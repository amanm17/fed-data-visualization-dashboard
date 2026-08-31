// "Discovery" mode: rank every real country on one side of a trade
// relationship by fixing the OTHER side and omitting this one from the
// API call entirely. Comtrade returns one row per real country in a
// single call (client.js's buildParams already drops null-valued params
// before building the request URL) rather than requiring a separate call
// per country — the same mechanism the reference Python pipeline used for
// both "find top partners for a reporter" (omit partnerCode) and "top
// exporters/importers of a product" (omit reporterCode, partnerCode fixed
// to World/0). NOTE: omitting reporterCode specifically was never directly
// observed in the reference tool's source (only omitting partnerCode
// was) — it's a reasonable symmetry assumption given the REST layer drops
// any missing param generically, but treat it as unconfirmed until tested
// against a real key.
//
// Always a live fetch — there's no reliable way to tell from the cache
// alone whether a full breakdown was ever captured before, so this mode
// requires at least one API key and never falls back to demo mode. Every
// real row it gets back is still upserted into the shared cache, so
// ordinary queries benefit from the warm-up even though this call itself
// never checks the cache first.
const cache = require('./cache');
const { planCallsForCell } = require('./batching');
const { KeyPool, fetchCallWithKeyPool } = require('./keyPool');

async function fetchBreakdown({ anchorRole, anchorCode, flowCode, hsCodes, years, apiKeys, topN = 10 }) {
  const pool = new KeyPool(apiKeys);
  if (!pool.keys.length) {
    throw new Error('Discovery mode needs at least one API key — there is no cached fallback for a full country breakdown.');
  }

  const cell = anchorRole === 'reporter'
    ? { reporterCode: anchorCode, partnerCode: null, flowCode, hsCodes, years }
    : { reporterCode: null, partnerCode: anchorCode, flowCode, hsCodes, years };

  const totals = new Map(); // countryCode -> accumulated trade value
  let callsMade = 0;
  const errors = [];

  for (const call of planCallsForCell(cell)) {
    const { rows, error } = await fetchCallWithKeyPool(pool, call);
    callsMade += 1;
    if (error || !rows) {
      errors.push(error ? error.message : 'Unknown fetch error');
      continue;
    }
    await cache.upsertRecords(rows);
    for (const r of rows) {
      const countryCode = anchorRole === 'reporter' ? r.partnerCode : r.reporterCode;
      if (!Number.isFinite(countryCode)) continue;
      totals.set(countryCode, (totals.get(countryCode) || 0) + (r.tradeValueUsd || 0));
    }
  }

  const ranked = Array.from(totals.entries())
    .map(([code, value]) => ({ code, value }))
    .sort((a, b) => b.value - a.value);
  const grandTotal = ranked.reduce((sum, r) => sum + r.value, 0);

  const ranking = ranked.slice(0, topN).map((r, i) => ({
    rank: i + 1,
    code: r.code,
    value: r.value,
    sharePct: grandTotal > 0 ? (r.value / grandTotal) * 100 : 0,
  }));

  // Surfaced to the frontend as a data-completeness signal — Comtrade
  // often has far fewer reporters for the most recent 1-2 years (major
  // economies can take a while to file), and a "top exporters" ranking
  // silently missing the real biggest exporter is a lot more misleading
  // than a visibly short list, so the caller shows this count rather than
  // just the top N.
  return { ranking, totalCountriesFound: ranked.length, callsMade, errors };
}

module.exports = { fetchBreakdown };
