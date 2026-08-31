// Decides, for a requested query, which (reporter, partner, flow) triples
// already have every requested HS-code x year cell cached, and which need
// a live fetch. Granularity is per-triple, not per-cell: Comtrade bills one
// call per (HS-code-batch x year-batch) regardless of which specific cells
// within it are missing, so there's no quota benefit to fetching a
// surgical subset — if a triple has ANY gap, its full hsCodes x years
// block is (re)fetched, which naturally also refreshes the parts that were
// already cached. This is what makes the shared cache actually save quota
// across different visitors' overlapping queries: a triple that's already
// been fully fetched by anyone is skipped outright.
const cache = require('./cache');

async function planQuery({ reporterCodes, partnerCodes, flowCodes, hsCodes, years }) {
  const wantedCells = hsCodes.length * years.length;
  const fullyCached = [];
  const needsFetch = [];

  for (const reporterCode of reporterCodes) {
    for (const partnerCode of partnerCodes) {
      for (const flowCode of flowCodes) {
        const cachedRows = await cache.findRecords({
          reporterCodes: [reporterCode],
          partnerCodes: [partnerCode],
          flowCodes: [flowCode],
          hsCodes,
          years,
        });
        const triple = { reporterCode, partnerCode, flowCode, hsCodes, years };
        if (cachedRows.length >= wantedCells) {
          fullyCached.push(triple);
        } else {
          needsFetch.push(triple);
        }
      }
    }
  }

  return { fullyCached, needsFetch };
}

module.exports = { planQuery };
