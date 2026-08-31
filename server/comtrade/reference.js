// Country (reporter/partner) and HS-classification reference data. Neither
// requires a subscription key — both are public static JSON files, found
// indirectly via ListofReferences.json's per-category `fileuri` (confirmed
// live: category "reporter" -> Reporters.json, category "cmd:HS" ->
// HS.json — the "Combined HS" list covering every digit level, matching
// the clCode=HS used by every trade-data call in client.js). The same
// Reporters.json list is used for both reporter and partner dropdowns —
// they share one code space, and the reference pipeline this was ported
// from does the same (its own get_country_reference() docstring says so
// explicitly).
const fs = require('fs');
const path = require('path');

const LIST_OF_REFERENCES_URL = 'https://comtradeapi.un.org/files/v1/app/reference/ListofReferences.json';

const CACHE_DIR = process.env.COMTRADE_CACHE_DIR
  || process.env.ASI_DATA_DIR
  || path.join(__dirname, '..', '..', 'data');
const COUNTRY_CACHE_FILE = path.join(CACHE_DIR, 'comtrade_country_reference.json');
const HS_CACHE_FILE = path.join(CACHE_DIR, 'comtrade_hs_reference.json');
const SEED_COUNTRY_FILE = path.join(__dirname, 'data', 'comtrade_country_reference.seed.json');

// Neither list changes often — 30 days matches the reference pipeline's
// own country-list TTL.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readJsonIfFresh(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const age = Date.now() - fs.statSync(filePath).mtimeMs;
  if (age > TTL_MS) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function fetchReferenceCategory(category) {
  const listRes = await fetch(LIST_OF_REFERENCES_URL);
  if (!listRes.ok) throw new Error(`ListofReferences.json fetch failed: ${listRes.status}`);
  const { results: list } = await listRes.json();
  const entry = (list || []).find((r) => r.category === category);
  if (!entry || !entry.fileuri) throw new Error(`No reference file found for category "${category}"`);

  const fileRes = await fetch(entry.fileuri);
  if (!fileRes.ok) throw new Error(`Reference file fetch failed for "${category}": ${fileRes.status}`);
  const { results } = await fileRes.json();
  return results || [];
}

let countryCache = null;

async function getCountries({ forceRefresh = false } = {}) {
  if (countryCache && !forceRefresh) return countryCache;

  if (!forceRefresh) {
    const cached = readJsonIfFresh(COUNTRY_CACHE_FILE);
    if (cached) {
      countryCache = cached;
      return cached;
    }
  }

  try {
    const raw = await fetchReferenceCategory('reporter');
    const countries = raw
      .map((r) => ({
        code: String(r.reporterCode),
        name: r.reporterDesc || r.text,
        iso3: r.reporterCodeIsoAlpha3 || '',
        isGroup: Boolean(r.isGroup),
      }))
      .filter((c) => c.code && c.name);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(COUNTRY_CACHE_FILE, JSON.stringify(countries));
    countryCache = countries;
    return countries;
  } catch (e) {
    // Never fail the request just because a live refresh didn't work —
    // fall back to whatever's on disk (even if stale), then the bundled
    // seed copied from the reference pipeline's own cache file.
    if (fs.existsSync(COUNTRY_CACHE_FILE)) {
      countryCache = JSON.parse(fs.readFileSync(COUNTRY_CACHE_FILE, 'utf8'));
    } else {
      const seed = JSON.parse(fs.readFileSync(SEED_COUNTRY_FILE, 'utf8'));
      countryCache = seed.map((c) => ({ code: c.code, name: c.name, iso3: c.iso3, isGroup: Boolean(c.is_group) }));
    }
    return countryCache;
  }
}

let hsCache = null;

// HS.json entries: { id, text, parent, isLeaf, aggrLevel, standardUnitAbbr }.
// `id` is the HS code itself (any digit level — chapter/heading/subheading/
// 6-digit), `text` is "<code> - <description>", `isLeaf` distinguishes real
// 6-digit codes ("1") from chapter/heading aggregates ("0"). Comtrade
// accepts any of these as cmdCode, so both are kept and exposed to search.
async function getHsCodes({ forceRefresh = false } = {}) {
  if (hsCache && !forceRefresh) return hsCache;

  if (!forceRefresh) {
    const cached = readJsonIfFresh(HS_CACHE_FILE);
    if (cached) {
      hsCache = cached;
      return cached;
    }
  }

  const raw = await fetchReferenceCategory('cmd:HS');
  const codes = raw
    .filter((r) => r.id && r.id !== 'TOTAL')
    .map((r) => ({
      code: r.id,
      description: r.text,
      parent: r.parent,
      isLeaf: r.isLeaf === '1' || r.isLeaf === 1,
      digitLevel: r.aggrLevel,
    }));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(HS_CACHE_FILE, JSON.stringify(codes));
  hsCache = codes;
  return codes;
}

async function searchHsCodes(query, { limit = 50 } = {}) {
  const codes = await getHsCodes();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return codes.slice(0, limit);

  // A numeric query means "HS code", not "product description that
  // happens to contain this number" — each entry's description embeds its
  // own code as a prefix (e.g. "0101 - Horses..."), so a plain substring
  // search on numbers would match almost every code and bury the actual
  // code-prefix match the user meant.
  if (/^\d+$/.test(q)) {
    return codes.filter((c) => c.code.startsWith(q)).slice(0, limit);
  }

  const startsWith = [];
  const contains = [];
  for (const c of codes) {
    const desc = c.description.toLowerCase();
    if (desc.startsWith(q)) startsWith.push(c);
    else if (desc.includes(q)) contains.push(c);
  }
  return [...startsWith, ...contains].slice(0, limit);
}

// Resolves a list of exact HS codes (e.g. pasted in bulk by a user) to
// their real descriptions, for the bulk-paste picker UI — a plain O(n)
// filter over the already-cached full list rather than N separate search
// calls. Codes with no match are silently dropped; the caller is
// responsible for telling the user how many of their pasted codes
// resolved.
async function lookupHsCodes(codes) {
  const wanted = new Set((codes || []).map((c) => String(c).trim()).filter(Boolean));
  if (!wanted.size) return [];
  const all = await getHsCodes();
  return all.filter((c) => wanted.has(c.code));
}

module.exports = { getCountries, getHsCodes, searchHsCodes, lookupHsCodes, fetchReferenceCategory };
