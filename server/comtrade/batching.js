// Comtrade's data/v1/get endpoint enforces hard per-call limits on how many
// comma-joined values cmdCode/period can carry. These numbers are not
// documented anywhere convenient — they're the exact constants the
// reference Python pipeline this module was ported from hardcoded after
// hitting real API errors above them (`_BILATERAL_MAX_HS_PER_CALL`,
// `_BILATERAL_MAX_YEARS_PER_CALL` in sector_comtrade_pipeline.py).
const MAX_HS_CODES_PER_CALL = 20;
const MAX_YEARS_PER_CALL = 12;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

// Expands one logical cell group (one reporter, one partner, one flow, N HS
// codes, N years) into the minimal set of API calls needed to respect the
// limits above. Fan-out across reporters/partners/flows happens one level
// up in planner.js — this only ever chunks the HS/year dimension of a
// single (reporter, partner, flow) triple.
function planCallsForCell({ reporterCode, partnerCode, flowCode, hsCodes, years }) {
  const hsChunks = chunk(hsCodes, MAX_HS_CODES_PER_CALL);
  const yearChunks = chunk(years, MAX_YEARS_PER_CALL);
  const calls = [];
  for (const hsChunk of hsChunks) {
    for (const yearChunk of yearChunks) {
      calls.push({ reporterCode, partnerCode, flowCode, hsCodes: hsChunk, years: yearChunk });
    }
  }
  return calls;
}

module.exports = { MAX_HS_CODES_PER_CALL, MAX_YEARS_PER_CALL, chunk, planCallsForCell };
