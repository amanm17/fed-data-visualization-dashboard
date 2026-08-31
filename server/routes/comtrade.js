// Routes for the UN Comtrade Trade Explorer — a standalone module, separate
// from the ASI/PLFS module-registry routes above it in server/index.js.
// Kept thin: validation here, orchestration in server/comtrade/queryService.js.
const express = require('express');
const reference = require('../comtrade/reference');
const queryService = require('../comtrade/queryService');
const { fetchBreakdown } = require('../comtrade/breakdown');

const router = express.Router();

const VALID_FLOW_CODES = new Set(['X', 'M', 'RX', 'RM']);

// Generous but real caps on one request — this is a shared, quota-limited
// resource, so these stop a query from silently fanning out into hundreds
// of API calls. Not a hard product limit; revisit once real usage exists.
const MAX_TRIPLES = 200;
const MAX_HS_CODES = 50;
const MAX_YEARS = 30;

function expandYears(years) {
  if (Array.isArray(years)) return years.map(Number).filter(Number.isFinite);
  if (years && typeof years === 'object' && years.start && years.end) {
    const out = [];
    for (let y = Number(years.start); y <= Number(years.end); y += 1) out.push(y);
    return out;
  }
  return [];
}

function parseQuerySpec(body) {
  const reporterCodes = (body.reporters || []).map(Number).filter(Number.isFinite);
  const partnerCodes = (body.partners && body.partners.length ? body.partners : [0])
    .map(Number)
    .filter(Number.isFinite);
  const flowCodes = (body.flows || []).filter((f) => VALID_FLOW_CODES.has(f));
  const hsCodes = (body.hsCodes || []).map(String).filter(Boolean);
  const years = expandYears(body.years);

  const errors = [];
  if (!reporterCodes.length) errors.push('At least one reporter is required.');
  if (!partnerCodes.length) errors.push('At least one partner is required.');
  if (!flowCodes.length) errors.push('At least one valid flow (X, M, RX, RM) is required.');
  if (!hsCodes.length) errors.push('At least one HS code is required.');
  if (!years.length) errors.push('At least one year is required.');
  if (hsCodes.length > MAX_HS_CODES) errors.push(`Too many HS codes (max ${MAX_HS_CODES}).`);
  if (years.length > MAX_YEARS) errors.push(`Too many years (max ${MAX_YEARS}).`);

  const triples = reporterCodes.length * partnerCodes.length * flowCodes.length;
  if (triples > MAX_TRIPLES) {
    errors.push(`Too many reporter x partner x flow combinations (${triples}, max ${MAX_TRIPLES}).`);
  }

  return { reporterCodes, partnerCodes, flowCodes, hsCodes, years, errors };
}

router.get('/reference/countries', async (req, res) => {
  try {
    const countries = await reference.getCountries();
    res.json({ countries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reference/hs', async (req, res) => {
  try {
    const codes = await reference.searchHsCodes(req.query.search, { limit: 100 });
    res.json({ codes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolves a bulk-pasted, comma/whitespace-separated list of exact HS
// codes to their real descriptions — backs the "paste codes" picker
// affordance, distinct from the fuzzy /reference/hs search above.
router.get('/reference/hs/lookup', async (req, res) => {
  const codes = String(req.query.codes || '').split(/[\s,]+/).filter(Boolean);
  try {
    const matched = await reference.lookupHsCodes(codes);
    res.json({ codes: matched, requested: codes.length, matched: matched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// No fetch — a cost estimate (how many API calls a live fetch would need)
// so the frontend can confirm before spending quota.
router.post('/preview', async (req, res) => {
  const spec = parseQuerySpec(req.body || {});
  if (spec.errors.length) return res.status(400).json({ errors: spec.errors });
  try {
    const result = await queryService.previewQuery(spec);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/query', async (req, res) => {
  const spec = parseQuerySpec(req.body || {});
  if (spec.errors.length) return res.status(400).json({ errors: spec.errors });
  const apiKeys = Array.isArray(req.body.apiKeys)
    ? req.body.apiKeys.filter((k) => typeof k === 'string' && k.trim())
    : [];
  try {
    const result = await queryService.runQuery({ ...spec, apiKeys });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseBreakdownSpec(body) {
  const errors = [];
  const anchorRole = body.anchorRole === 'reporter' || body.anchorRole === 'partner' ? body.anchorRole : null;
  if (!anchorRole) errors.push('anchorRole must be "reporter" or "partner".');
  const anchorCode = Number(body.anchorCode);
  if (!Number.isFinite(anchorCode)) errors.push('anchorCode is required.');
  const flowCode = VALID_FLOW_CODES.has(body.flowCode) ? body.flowCode : null;
  if (!flowCode) errors.push('A valid flow (X, M, RX, RM) is required.');
  const hsCodes = (body.hsCodes || []).map(String).filter(Boolean);
  if (!hsCodes.length) errors.push('At least one HS code is required.');
  if (hsCodes.length > MAX_HS_CODES) errors.push(`Too many HS codes (max ${MAX_HS_CODES}).`);
  const years = expandYears(body.years);
  if (!years.length) errors.push('At least one year is required.');
  if (years.length > MAX_YEARS) errors.push(`Too many years (max ${MAX_YEARS}).`);
  const topN = Math.min(Math.max(Number(body.topN) || 10, 1), 25);

  return { anchorRole, anchorCode, flowCode, hsCodes, years, topN, errors };
}

// Discovery/ranking: fixes one side of a trade relationship and asks
// Comtrade for the full breakdown of the other side in one call, ranked
// by trade value — "find top partners for reporter X" (anchorRole:
// 'reporter') or "top exporters/importers of product Y" (anchorRole:
// 'partner', anchorCode usually 0/World). Always a live fetch; see
// server/comtrade/breakdown.js for why there's no cached/demo fallback.
router.post('/breakdown', async (req, res) => {
  const spec = parseBreakdownSpec(req.body || {});
  if (spec.errors.length) return res.status(400).json({ errors: spec.errors });
  const apiKeys = Array.isArray(req.body.apiKeys)
    ? req.body.apiKeys.filter((k) => typeof k === 'string' && k.trim())
    : [];
  if (!apiKeys.length) {
    return res.status(400).json({ errors: ['Discovery mode needs at least one API key.'] });
  }
  try {
    const result = await fetchBreakdown({ ...spec, apiKeys });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
