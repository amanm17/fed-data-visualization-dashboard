// Round-robins a request's array of subscription keys across the API
// calls needed to fulfill it, so a visitor who supplies several free-tier
// keys gets their combined daily quota rather than being capped at one
// key's 500 calls/day. Exhaustion tracking is scoped to a single request
// only — there is no cross-request/server-side quota state, since
// Comtrade doesn't expose remaining-quota in its responses; the real
// enforcement is always its own 429, and this just avoids retrying a key
// we already know failed earlier in the same request.
const { fetchTradeData, ComtradeApiError, normalizeRow } = require('./client');

class KeyPool {
  constructor(keys) {
    this.keys = (keys || []).filter(Boolean);
    this.exhausted = new Set();
    this.cursor = 0;
  }

  hasAvailableKey() {
    return this.exhausted.size < this.keys.length;
  }

  nextKey() {
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[this.cursor % this.keys.length];
      this.cursor += 1;
      if (!this.exhausted.has(key)) return key;
    }
    return null;
  }

  markExhausted(key) {
    this.exhausted.add(key);
  }
}

// Fetches one (reporterCode, partnerCode, flowCode, hsCodes, years) call,
// trying each remaining key in the pool until one succeeds or the pool is
// exhausted. Returns { rows, error } — error is only set (rows === null)
// once every key has failed or the pool started empty.
async function fetchCallWithKeyPool(pool, callSpec) {
  if (!pool.keys.length) {
    return { rows: null, error: new Error('No API keys supplied') };
  }
  let lastError = null;
  while (pool.hasAvailableKey()) {
    const key = pool.nextKey();
    if (!key) break;
    try {
      const raw = await fetchTradeData({ subscriptionKey: key, ...callSpec });
      return { rows: raw.map(normalizeRow), error: null };
    } catch (err) {
      lastError = err;
      if (err instanceof ComtradeApiError && err.quotaExceeded) {
        pool.markExhausted(key);
        continue; // try the next key in the pool
      }
      // A non-quota error (bad key, bad request shape, network failure)
      // is this call's failure, not a reason to burn through every other
      // key in the pool too.
      return { rows: null, error: err };
    }
  }
  return { rows: null, error: lastError || new Error('All API keys exhausted') };
}

module.exports = { KeyPool, fetchCallWithKeyPool };
