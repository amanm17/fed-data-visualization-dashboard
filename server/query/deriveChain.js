// Resolves a set of "derived" entries ({key, dependsOn, sql}) that may
// depend on each other (not just on raw base columns) into dependency
// order, then builds one SELECT layer on top of a base view/table that
// computes all of them. A derived measure can be several layers deep
// (e.g. pc_27 depends on pc_26, which depends on pc_21, which depends on
// pc_19 and pc_20) without whoever writes the *.derived.js file having to
// hand-order entries or know how deep the chain goes.
//
// This builds a single SELECT (not N chained CTEs) because DuckDB resolves
// SELECT-list aliases left-to-right within the same SELECT (confirmed:
// `SELECT 1 AS a, a + 1 AS b` works) — so as long as the derived columns
// are listed in topological order, each one can reference any alias
// (base column or earlier derived column) that came before it.
const { quoteIdent } = require('./sqlUtil');

// Kahn's-algorithm-style DFS topological sort. Throws a clear, named error
// on a cycle or a dependency that resolves to neither a base column nor
// another entry's key — a typo here should fail loudly at startup, not
// silently produce a wrong number.
function topoSort(entries, baseColumnNames) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const resolved = new Set(baseColumnNames);
  const visiting = new Set();
  const ordered = [];

  function visit(entry, chain) {
    if (resolved.has(entry.key)) return;
    if (visiting.has(entry.key)) {
      throw new Error(`Circular dependency among derived measures: ${[...chain, entry.key].join(' -> ')}`);
    }
    visiting.add(entry.key);
    for (const dep of entry.dependsOn) {
      if (resolved.has(dep)) continue;
      const depEntry = byKey.get(dep);
      if (!depEntry) {
        throw new Error(
          `Derived measure "${entry.key}" depends on "${dep}", which is neither a base column ` +
          `nor another derived measure's key`
        );
      }
      visit(depEntry, [...chain, entry.key]);
    }
    visiting.delete(entry.key);
    resolved.add(entry.key);
    ordered.push(entry);
  }

  for (const entry of entries) visit(entry, []);
  return ordered;
}

// Returns the full SQL for a view built on top of `baseViewName`, adding
// one computed column per entry in dependency order.
function buildDerivedSelect(baseViewName, baseColumnNames, entries) {
  if (entries.length === 0) {
    return `SELECT * FROM ${quoteIdent(baseViewName)}`;
  }
  const ordered = topoSort(entries, baseColumnNames);

  // Every base column and every derived key gets a quoted reference — safe
  // to hand a superset to sql(c) since entries only read the keys they
  // declared in dependsOn.
  const allNames = [...baseColumnNames, ...ordered.map((e) => e.key)];
  const c = {};
  for (const name of allNames) c[name] = quoteIdent(name);

  const selectItems = ['*', ...ordered.map((entry) => `${entry.sql(c)} AS ${quoteIdent(entry.key)}`)];
  return `SELECT ${selectItems.join(',\n           ')}\n    FROM ${quoteIdent(baseViewName)}`;
}

module.exports = { buildDerivedSelect, topoSort };
