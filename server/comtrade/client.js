// Thin wrapper around the UN Comtrade REST API. Our backend is Node, so it
// can't just `pip install comtradeapicall` and call the official Python
// client the way the reference tool this was ported from does — this
// replicates the exact request shape read directly out of that package's
// source (comtradeapicall/PreviewGet.py): base URL, param names, and the
// "drop null params instead of sending the literal string" convention
// (Comtrade itself treats an omitted partnerCode as "every partner, one
// call" rather than an error).
const BASE_URL = 'https://comtradeapi.un.org/data/v1/get';

class ComtradeApiError extends Error {
  constructor(message, { status, quotaExceeded } = {}) {
    super(message);
    this.name = 'ComtradeApiError';
    this.status = status;
    this.quotaExceeded = quotaExceeded;
  }
}

function buildParams(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return search;
}

// One call to data/v1/get/{typeCode}/{freqCode}/{clCode}. `hsCodes` and
// `years` are joined into Comtrade's comma-separated form here; the caller
// (batching.js) is responsible for keeping each array within Comtrade's
// per-call limits — this function does not chunk anything itself.
async function fetchTradeData({
  subscriptionKey,
  reporterCode,
  partnerCode,
  flowCode,
  hsCodes,
  years,
  typeCode = 'C',
  freqCode = 'A',
  clCode = 'HS',
}) {
  const url = `${BASE_URL}/${typeCode}/${freqCode}/${clCode}`;
  const params = buildParams({
    reportercode: reporterCode,
    flowCode,
    period: years.join(','),
    cmdCode: hsCodes.join(','),
    partnerCode,
    format: 'JSON',
    includeDesc: true,
    // Without this, Comtrade returns multiple rows for the SAME
    // (reporter, partner, flow, hsCode, year) — split by a secondary
    // partner2Code dimension — often repeating the identical primaryValue
    // 2-6x across those rows. Confirmed directly against Comtrade's public
    // preview endpoint: the same India/2023/HS-610230/World query returns
    // 2 duplicate-value rows without this param and exactly 1 correct row
    // with it. Silently summing raw rows (as breakdown.js's ranking does)
    // then badly overcounts; the regular cache upsert path was accidentally
    // shielded from a *visibly* wrong total (ON CONFLICT DO UPDATE just
    // keeps whichever duplicate row lands last, not a sum), but which one
    // "wins" is nondeterministic, so this is fixed at the source for both
    // paths rather than papered over downstream. Matches what the
    // reference Python pipeline always passed explicitly for exactly this
    // reason (see sector_comtrade_pipeline.py's own getFinalData calls).
    breakdownMode: 'classic',
    'subscription-key': subscriptionKey,
  });

  const res = await fetch(`${url}?${params.toString()}`);
  const bodyText = await res.text();

  if (!res.ok) {
    // Comtrade returns 429 for quota exhaustion and 401/403 for a bad/
    // expired key, as a plain error body rather than the {data:[...]} shape.
    throw new ComtradeApiError(
      `Comtrade API error ${res.status}: ${bodyText.slice(0, 300)}`,
      { status: res.status, quotaExceeded: res.status === 429 }
    );
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (e) {
    throw new ComtradeApiError(`Comtrade API returned non-JSON response: ${bodyText.slice(0, 300)}`);
  }

  return json.data || [];
}

// The Python reference client defensively tries both camelCase and
// lowercase field names when reading a response row (see its own `_get`
// helper) — a sign the API's exact casing isn't fully reliable across
// endpoints/versions. We don't have a subscription key available to verify
// a live data/v1/get response ourselves (only the unauthenticated
// reference endpoints were checked directly), so this stays defensive
// too; confirm against a real response during the curl verification step.
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return null;
}

function normalizeRow(row) {
  const qtyRaw = Number(pick(row, ['qty']));
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : null;
  // `netWgt` is a separate field from `qty`/`qtyUnitAbbr` — Comtrade reports
  // it in kg for virtually every commodity regardless of what unit the
  // classification's own `qty` figure uses (confirmed directly against a
  // real response: HS 610230 came back with `qty: 306402, qtyUnitAbbr: "u"`
  // *and* `netWgt: 42549.138` in the same row). Capturing it gives a
  // standard cross-product unit (kg) alongside whatever native unit `qty`
  // happens to be in, rather than only ever having one or the other.
  const netWgtRaw = Number(pick(row, ['netWgt', 'netwgt']));
  const netWgtKg = Number.isFinite(netWgtRaw) && netWgtRaw > 0 ? netWgtRaw : null;
  return {
    reporterCode: Number(pick(row, ['reporterCode', 'reportercode'])),
    partnerCode: Number(pick(row, ['partnerCode', 'partnercode'])),
    flowCode: pick(row, ['flowCode', 'flowcode']),
    hsCode: String(pick(row, ['cmdCode', 'cmdcode'])),
    year: Number(pick(row, ['period'])),
    tradeValueUsd: Number(pick(row, ['primaryValue', 'primaryvalue'])) || null,
    qty,
    // Confirmed against real cached responses: Comtrade sends the literal
    // string "N/A" for qtyUnitAbbr on value-only rows (no real quantity),
    // not null/empty — `pick()` only filters those, so "N/A" was leaking
    // through as a fake "unit" and poisoning the frontend's single-unit
    // detection (any multi-year query with even one N/A row looked like a
    // 2-unit mix, disabling Quantity/Unit Price entirely). Only report a
    // unit when there's an actual qty to go with it.
    qtyUnit: qty !== null ? pick(row, ['qtyUnitAbbr', 'qtyunitabbr']) : null,
    netWgtKg,
  };
}

module.exports = { fetchTradeData, ComtradeApiError, normalizeRow };
