// Auto-discovers every *.derived.js file in this directory. Each file
// declares cross-block computed measures/dimensions that target an
// already-assembled dataset (currently only 'unit_summary') — things like
// the 27 ASI "Principal Characteristics," which are formulas over several
// blocks' rolled-up columns, not owned by any single block module. Adding
// one is the same "drop a file" pattern as server/modules — see
// CONTRIBUTING.md.
const fs = require('fs');
const path = require('path');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadDerivedFiles() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.derived.js'))
    .sort();
}

function validateDerivedFile(descriptor, filename) {
  const ctx = `derived file "${filename}"`;
  assert(descriptor && typeof descriptor === 'object', `${ctx} must export an object`);
  assert(typeof descriptor.appliesTo === 'string' && descriptor.appliesTo.length > 0,
    `${ctx}: "appliesTo" (target dataset id) is required`);
  assert(Array.isArray(descriptor.measures), `${ctx}: "measures" must be an array`);
  for (const m of descriptor.measures) {
    assert(m && typeof m.key === 'string', `${ctx}: every measure needs a "key"`);
    assert(typeof m.label === 'string', `${ctx}: measure "${m.key}" needs a "label"`);
    if (m.ratio) {
      // Ratio measures compute SUM(numerator)/SUM(denominator) at QUERY
      // time (never baked into a view column — see registry.js), so they
      // have no `sql`/`dependsOn` of their own. Unlike the per-unit form,
      // a typo'd column here surfaces as a DuckDB error on first use, not
      // at startup — deliberate simplification, see CONTRIBUTING.md.
      assert(typeof m.ratio.numerator === 'function', `${ctx}: measure "${m.key}" ratio needs a "numerator" function`);
      assert(typeof m.ratio.denominator === 'function', `${ctx}: measure "${m.key}" ratio needs a "denominator" function`);
      assert(m.ratio.scale === undefined || typeof m.ratio.scale === 'number',
        `${ctx}: measure "${m.key}" ratio "scale" must be a number if present`);
    } else {
      assert(typeof m.sql === 'function', `${ctx}: measure "${m.key}" needs a "sql" function (or a "ratio" object)`);
      assert(Array.isArray(m.dependsOn) && m.dependsOn.length > 0,
        `${ctx}: measure "${m.key}" needs a non-empty "dependsOn" array`);
    }
  }
  if (descriptor.dimensions) {
    assert(Array.isArray(descriptor.dimensions), `${ctx}: "dimensions" must be an array if present`);
    for (const d of descriptor.dimensions) {
      assert(d && typeof d.key === 'string', `${ctx}: every dimension needs a "key"`);
      assert(typeof d.label === 'string', `${ctx}: dimension "${d.key}" needs a "label"`);
      assert(typeof d.sql === 'function', `${ctx}: dimension "${d.key}" needs a "sql" function`);
      assert(Array.isArray(d.dependsOn) && d.dependsOn.length > 0,
        `${ctx}: dimension "${d.key}" needs a non-empty "dependsOn" array`);
    }
  }
}

// Returns a map: datasetId -> { measures: [...], dimensions: [...] },
// merging every *.derived.js file that targets that dataset.
function loadDerivedByDataset() {
  const byDataset = new Map();
  const seenKeys = new Set();

  for (const file of loadDerivedFiles()) {
    const descriptor = require(path.join(__dirname, file));
    validateDerivedFile(descriptor, file);

    const bucket = byDataset.get(descriptor.appliesTo) || { measures: [], dimensions: [] };
    for (const m of descriptor.measures) {
      assert(!seenKeys.has(m.key), `duplicate derived measure/dimension key "${m.key}" (file "${file}")`);
      seenKeys.add(m.key);
      bucket.measures.push(m);
    }
    for (const d of descriptor.dimensions || []) {
      assert(!seenKeys.has(d.key), `duplicate derived measure/dimension key "${d.key}" (file "${file}")`);
      seenKeys.add(d.key);
      bucket.dimensions.push(d);
    }
    byDataset.set(descriptor.appliesTo, bucket);
  }

  return byDataset;
}

module.exports = { loadDerivedByDataset };
