// Auto-discovers every *.module.js file in this directory, validates its
// descriptor shape, and builds an in-memory registry. Nothing here names a
// specific block — dropping a new *.module.js file here is the entire
// integration step (see CONTRIBUTING.md).
const fs = require('fs');
const path = require('path');

const VALID_GRAINS = new Set(['unit', 'item']);

function loadModuleFiles() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.module.js'))
    .sort();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A dimension/measure entry is either physical (`key` is a real column in
// `columns`) or derived (`derived: true`, computed from a `sql(c)` function
// over other whitelisted columns named in `dependsOn`). Both shapes are
// validated the same way everywhere they appear.
function validateFieldEntry(entry, kind, ctx, columns) {
  assert(entry && typeof entry.key === 'string', `${ctx}: every ${kind} needs a "key"`);
  assert(typeof entry.label === 'string', `${ctx}: ${kind} "${entry.key}" needs a "label"`);
  if (entry.derived) {
    assert(typeof entry.sql === 'function', `${ctx}: derived ${kind} "${entry.key}" needs a "sql" function`);
    assert(Array.isArray(entry.dependsOn) && entry.dependsOn.length > 0,
      `${ctx}: derived ${kind} "${entry.key}" needs a non-empty "dependsOn" array`);
    for (const dep of entry.dependsOn) {
      assert(columns[dep], `${ctx}: derived ${kind} "${entry.key}" depends on unknown column "${dep}"`);
    }
  } else {
    assert(columns[entry.key], `${ctx}: ${kind} "${entry.key}" is not in "columns" (add it, or mark it derived: true)`);
  }
}

function validateDescriptor(descriptor, filename) {
  const ctx = `module file "${filename}"`;
  assert(descriptor && typeof descriptor === 'object', `${ctx} must export an object`);
  assert(typeof descriptor.id === 'string' && /^[a-z][a-z0-9_]*$/.test(descriptor.id),
    `${ctx}: "id" must be a lowercase snake_case string`);
  assert(typeof descriptor.label === 'string' && descriptor.label.length > 0,
    `${ctx}: "label" is required`);
  assert(VALID_GRAINS.has(descriptor.grain),
    `${ctx}: "grain" must be one of ${[...VALID_GRAINS].join(', ')}`);
  assert(typeof descriptor.file === 'string' && descriptor.file.length > 0,
    `${ctx}: "file" (CSV filename relative to the data dir) is required`);
  assert(typeof descriptor.idColumn === 'string' && descriptor.idColumn.length > 0,
    `${ctx}: "idColumn" is required`);
  assert(descriptor.columns && typeof descriptor.columns === 'object',
    `${ctx}: "columns" (whitelist map of column -> SQL type) is required`);
  assert(Array.isArray(descriptor.dimensions), `${ctx}: "dimensions" must be an array`);
  assert(Array.isArray(descriptor.measures), `${ctx}: "measures" must be an array`);
  assert(!(descriptor.isSpine && descriptor.standalone),
    `${ctx}: a module can't be both "isSpine" and "standalone"`);
  if (descriptor.csvOptions !== undefined) {
    assert(typeof descriptor.csvOptions === 'object' && descriptor.csvOptions !== null,
      `${ctx}: "csvOptions", if present, must be an object`);
  }
  if (descriptor.weight !== undefined) {
    assert(typeof descriptor.weight.column === 'string' && descriptor.weight.column.length > 0,
      `${ctx}: "weight.column", if present, must be a non-empty string`);
  }

  for (const dim of descriptor.dimensions) {
    validateFieldEntry(dim, 'dimension', ctx, descriptor.columns);
  }
  for (const measure of descriptor.measures) {
    validateFieldEntry(measure, 'measure', ctx, descriptor.columns);
  }

  if (descriptor.grain === 'item') {
    assert(Array.isArray(descriptor.rollup) && descriptor.rollup.length > 0,
      `${ctx}: item-grain modules must declare a non-empty "rollup" array (how this block folds up to unit grain)`);
    for (const r of descriptor.rollup) {
      assert(typeof r.as === 'string' && r.as.length > 0, `${ctx}: every rollup entry needs "as"`);
      assert(typeof r.label === 'string' && r.label.length > 0, `${ctx}: rollup entry "${r.as}" needs "label"`);
      assert(typeof r.sql === 'function', `${ctx}: rollup entry "${r.as}" needs a "sql" function`);
      assert(Array.isArray(r.dependsOn) && r.dependsOn.length > 0,
        `${ctx}: rollup entry "${r.as}" needs a non-empty "dependsOn" array`);
      for (const dep of r.dependsOn) {
        assert(descriptor.columns[dep], `${ctx}: rollup entry "${r.as}" depends on unknown column "${dep}"`);
      }
    }
  }

  // Standalone modules never join against anything (no spine, no rollup), so
  // idColumn is purely descriptive there — it doesn't have to name a real
  // physical column the way it must for a module that's folded into
  // unit_summary or the ASI weight join.
  if (!descriptor.standalone && !descriptor.columns[descriptor.idColumn]) {
    throw new Error(`${ctx}: idColumn "${descriptor.idColumn}" is not in "columns"`);
  }
}

function buildRegistry() {
  const files = loadModuleFiles();
  const modules = new Map();
  let spine = null;

  for (const file of files) {
    const descriptor = require(path.join(__dirname, file));
    validateDescriptor(descriptor, file);
    assert(!modules.has(descriptor.id), `duplicate module id "${descriptor.id}" (file "${file}")`);
    modules.set(descriptor.id, descriptor);
    if (descriptor.isSpine) {
      if (spine) throw new Error(`more than one module has isSpine: true ("${spine.id}" and "${descriptor.id}")`);
      spine = descriptor;
    }
  }

  assert(spine, 'exactly one module must declare isSpine: true (the Block-A-equivalent unit spine)');

  // Rollup "as" aliases must be unique across the whole registry — they become
  // columns on the shared unit_summary view.
  const seenAliases = new Set();
  for (const mod of modules.values()) {
    if (mod.grain !== 'item') continue;
    for (const r of mod.rollup) {
      assert(!seenAliases.has(r.as), `duplicate rollup alias "${r.as}" (module "${mod.id}")`);
      seenAliases.add(r.as);
    }
  }

  return { modules, spine };
}

module.exports = { buildRegistry };
