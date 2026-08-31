const { initRegistry } = require('../query/registry');
const { validateDimensionRequest, ValidationError } = require('../query/validate');
const { quoteIdent } = require('../query/registry');
const db = require('../db');

// GET /api/dimension-values?dataset=block_a&dim=a7
// Powers filter-option dropdowns in the UI: distinct values actually present
// in the data for a whitelisted, filterable dimension.
module.exports = async function dimensionValuesHandler(req, res) {
  try {
    const registry = await initRegistry();
    const { dataset, dim } = validateDimensionRequest(registry, req.query.dataset, req.query.dim);

    // No LIMIT here — a filter dimension is only useful if every value a
    // user might actually want to select against is present. A previous
    // `LIMIT 500` silently truncated a5 (5-digit NIC code, 670 distinct
    // values in the real data) partway through the alphabet, dropping
    // legitimate codes with real units behind them (e.g. "28299", 403
    // rows) with no indication anything had been cut. If a future
    // dimension's cardinality becomes large enough to be a real payload/
    // render concern, that's a signal it shouldn't be `filterable: true`
    // in the first place (see CONTRIBUTING.md), not something to solve by
    // quietly dropping values here.
    const col = quoteIdent(dim.key);
    const sql = `SELECT DISTINCT ${col} AS value FROM ${quoteIdent(dataset.view)}
      WHERE ${col} IS NOT NULL ORDER BY ${col}`;
    const rows = await db.all(sql);
    res.json({ values: rows.map((r) => r.value) });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  }
};
