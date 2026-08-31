// Singleton DuckDB connection. DuckDB reads the CSVs directly via SQL
// (read_csv_auto) — there is no separate ETL step or database server.
const duckdb = require('duckdb-async');

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = duckdb.Database.create(':memory:');
  }
  return dbPromise;
}

// DuckDB returns BIGINT-typed columns (COUNT(*), INTEGER group keys, etc) as
// JS BigInt, which JSON.stringify can't serialize. Our values are well
// within Number.MAX_SAFE_INTEGER, so converting is safe.
function sanitizeRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

// Runs a query and returns rows. `params` are bound as prepared-statement
// parameters — never string-concatenated — so filter values from the
// frontend can never inject SQL.
async function all(sql, params = []) {
  const db = await getDb();
  const rows = await db.all(sql, ...params);
  return rows.map(sanitizeRow);
}

// Runs a statement with no expected result rows (CREATE VIEW, etc).
async function exec(sql) {
  const db = await getDb();
  return db.exec(sql);
}

module.exports = { getDb, all, exec };
