// Orchestrates one /api/comtrade/query request: plans which
// (reporter,partner,flow) triples are already cached vs need a live fetch,
// dispatches the missing ones through the caller's key pool (chunked to
// respect Comtrade's per-call limits), upserts fresh rows into the shared
// cache, then serves the full requested cell set back from the cache —
// with metadata about what was already cached, freshly fetched, or
// couldn't be fetched (no working key / API error), so the frontend can
// show real gaps instead of silently returning incomplete data.
const cache = require('./cache');
const planner = require('./planner');
const { planCallsForCell } = require('./batching');
const { KeyPool, fetchCallWithKeyPool } = require('./keyPool');

function tripleKey(t) {
  return `${t.reporterCode}|${t.partnerCode}|${t.flowCode}`;
}

async function runQuery({ reporterCodes, partnerCodes, flowCodes, hsCodes, years, apiKeys }) {
  const { fullyCached, needsFetch } = await planner.planQuery({
    reporterCodes, partnerCodes, flowCodes, hsCodes, years,
  });

  const pool = new KeyPool(apiKeys);
  const unavailable = new Map(); // tripleKey -> reason
  let callsMade = 0;

  for (const triple of needsFetch) {
    if (!pool.keys.length) {
      // Demo mode — never attempt a fetch, just record the gap so the
      // frontend can prompt for a key instead of showing a false error.
      unavailable.set(tripleKey(triple), 'No API key supplied (demo mode — showing cached data only)');
      continue;
    }
    for (const call of planCallsForCell(triple)) {
      const { rows, error } = await fetchCallWithKeyPool(pool, call);
      callsMade += 1;
      if (error || !rows) {
        unavailable.set(tripleKey(triple), error ? error.message : 'Unknown fetch error');
        continue;
      }
      await cache.upsertRecords(rows);
    }
  }

  const records = await cache.findRecords({ reporterCodes, partnerCodes, flowCodes, hsCodes, years });

  return {
    records,
    meta: {
      triplesRequested: reporterCodes.length * partnerCodes.length * flowCodes.length,
      triplesFullyCachedBeforeQuery: fullyCached.length,
      triplesFetched: needsFetch.length - unavailable.size,
      triplesUnavailable: [...unavailable.entries()].map(([key, reason]) => ({ key, reason })),
      apiCallsMade: callsMade,
    },
  };
}

// No fetch — just how many triples are missing and how many API calls
// would be needed to fill them, so the frontend can show a cost estimate
// and ask for confirmation before a heavy multi-select query spends quota.
async function previewQuery({ reporterCodes, partnerCodes, flowCodes, hsCodes, years }) {
  const { fullyCached, needsFetch } = await planner.planQuery({
    reporterCodes, partnerCodes, flowCodes, hsCodes, years,
  });
  const callsNeeded = needsFetch.reduce((sum, triple) => sum + planCallsForCell(triple).length, 0);
  return {
    triplesFullyCached: fullyCached.length,
    triplesNeedingFetch: needsFetch.length,
    callsNeeded,
  };
}

module.exports = { runQuery, previewQuery };
