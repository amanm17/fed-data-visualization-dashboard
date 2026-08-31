const { initRegistry } = require('../query/registry');
const { validateQueryRequest, ValidationError } = require('../query/validate');
const { buildQuery } = require('../query/buildSql');
const db = require('../db');

module.exports = async function queryHandler(req, res) {
  try {
    const registry = await initRegistry();
    const validated = validateQueryRequest(registry, req.body);
    const { sql, params } = buildQuery(validated);
    const rows = await db.all(sql, params);
    res.json({
      labels: rows.map((r) => r.label),
      values: rows.map((r) => r.value),
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  }
};
