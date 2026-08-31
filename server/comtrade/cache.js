// Persistent, shared cache of fetched Comtrade rows — deliberately separate
// from server/db.js's `:memory:` DuckDB (that one exists purely to rebuild
// the ASI/PLFS CSV-backed views fresh on every boot). This module exists so
// fetched API data survives restarts and is shared across every visitor,
// which is the whole point of this feature's "hybrid fetch+cache" design.
// Confirmed empirically against this project's installed duckdb-async
// (1.4.2): a composite PRIMARY KEY plus `INSERT ... ON CONFLICT (...) DO
// UPDATE SET ...` works exactly as it would in Postgres.
const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb-async');

const CACHE_DIR = process.env.COMTRADE_CACHE_DIR
  || process.env.ASI_DATA_DIR
  || path.join(__dirname, '..', '..', 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'comtrade_cache.duckdb');

let dbPromise = null;

async function initDb() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const db = await duckdb.Database.create(CACHE_FILE);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS trade_records (
      reporter_code INTEGER,
      partner_code INTEGER,
      flow_code VARCHAR,
      hs_code VARCHAR,
      year INTEGER,
      trade_value_usd DOUBLE,
      qty DOUBLE,
      qty_unit VARCHAR,
      net_wgt_kg DOUBLE,
      fetched_at TIMESTAMP,
      PRIMARY KEY (reporter_code, partner_code, flow_code, hs_code, year)
    );
  `);
  // Migration for cache files created before net_wgt_kg existed — DuckDB's
  // ADD COLUMN IF NOT EXISTS (confirmed working against this project's
  // installed duckdb-async) makes this a no-op on a fresh table and safe to
  // run unconditionally on every boot. Rows fetched before this migration
  // simply have a NULL net_wgt_kg until their triple is re-fetched live —
  // there's no way to backfill it without calling Comtrade again.
  await db.exec(`ALTER TABLE trade_records ADD COLUMN IF NOT EXISTS net_wgt_kg DOUBLE;`);
  return db;
}

function getDb() {
  if (!dbPromise) dbPromise = initDb();
  return dbPromise;
}

// DuckDB returns BIGINT-typed columns as JS BigInt, which JSON.stringify
// can't serialize — same fix as server/db.js's sanitizeRow.
function sanitizeRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

const UPSERT_SQL = `
  INSERT INTO trade_records
    (reporter_code, partner_code, flow_code, hs_code, year, trade_value_usd, qty, qty_unit, net_wgt_kg, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
  ON CONFLICT (reporter_code, partner_code, flow_code, hs_code, year)
  DO UPDATE SET
    trade_value_usd = excluded.trade_value_usd,
    qty = excluded.qty,
    qty_unit = excluded.qty_unit,
    net_wgt_kg = excluded.net_wgt_kg,
    fetched_at = excluded.fetched_at
`;

// `rows` — array of { reporterCode, partnerCode, flowCode, hsCode, year,
// tradeValueUsd, qty, qtyUnit, netWgtKg }. A missing qty/qtyUnit/netWgtKg
// (Comtrade's value-only rows, or a commodity with no reported weight) is
// stored as null, not 0 — matches the reference pipeline's "qty<=0 is
// missing, not zero" convention, needed for unit price to stay meaningful
// later.
async function upsertRecords(rows) {
  if (!rows.length) return;
  const db = await getDb();
  for (const r of rows) {
    await db.run(
      UPSERT_SQL,
      r.reporterCode, r.partnerCode, r.flowCode, r.hsCode, r.year,
      r.tradeValueUsd, r.qty ?? null, r.qtyUnit || null, r.netWgtKg ?? null
    );
  }
}

// Returns every already-cached row whose (reporter,partner,flow,hs,year)
// falls within the given arrays — used both to check whether a
// (reporter,partner,flow) triple's requested hsCodes x years block is
// already fully covered (planner.js) and to serve the final chart data.
async function findRecords({ reporterCodes, partnerCodes, flowCodes, hsCodes, years }) {
  if (![reporterCodes, partnerCodes, flowCodes, hsCodes, years].every((l) => l.length)) return [];
  const db = await getDb();
  const inClause = (col, values) => `${col} IN (${values.map(() => '?').join(',')})`;
  const sql = `
    SELECT reporter_code, partner_code, flow_code, hs_code, year, trade_value_usd, qty, qty_unit, net_wgt_kg
    FROM trade_records
    WHERE ${inClause('reporter_code', reporterCodes)}
      AND ${inClause('partner_code', partnerCodes)}
      AND ${inClause('flow_code', flowCodes)}
      AND ${inClause('hs_code', hsCodes)}
      AND ${inClause('year', years)}
  `;
  const params = [...reporterCodes, ...partnerCodes, ...flowCodes, ...hsCodes, ...years];
  const rows = await db.all(sql, ...params);
  return rows.map(sanitizeRow);
}

module.exports = { getDb, upsertRecords, findRecords, CACHE_FILE };
