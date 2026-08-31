// Turns the module descriptors from server/modules (and the cross-block
// formulas from server/derived) into (a) real DuckDB views and (b) an
// in-memory map of queryable "datasets" that validate.js/buildSql.js/
// metadata route use. This is the only place that knows how modules get
// wired together — adding a module or derived file never requires touching
// this file.
const path = require('path');
const db = require('../db');
const { buildRegistry } = require('../modules');
const { loadDerivedByDataset } = require('../derived');
const { quoteIdent, sqlLiteral } = require('./sqlUtil');
const { buildDerivedSelect } = require('./deriveChain');

const DATA_DIR = process.env.ASI_DATA_DIR || path.join(__dirname, '..', '..', 'data');

// Builds a `{ col: quotedIdentifier }` map for every raw column in a
// module's `columns` whitelist — this is the `c` argument every derived
// dimension/measure/rollup `sql(c)` function receives.
function columnRefs(columnNames) {
  const c = {};
  for (const name of columnNames) c[name] = quoteIdent(name);
  return c;
}

// Reads each module's CSV with an EXPLICIT type for every column (built
// from that module's own `columns` whitelist), instead of
// `read_csv_auto`'s per-column type sniffing. read_csv_auto silently
// infers some code columns (e.g. Block A's `a4`/`a8`) as BIGINT when its
// sample rows happen to have no leading zeros, corrupting real values
// elsewhere in the file — confirmed via `typeof(a4)`. Explicit types close
// that hole and, as a side effect, also mean read_csv only ever returns
// whitelisted columns even if the CSV has extra ones.
// Every existing ASI module is a real header=True CSV, so that stays the
// unconditional default. A module can override `header` (fixed-width files
// have no header row) and add `sep`/`quote` via an optional `csvOptions` —
// e.g. plfs_person reads each line as one raw column using a `sep` that
// never appears in the data and `quote: ''` to disable quote handling
// entirely, since fixed-width text isn't real CSV.
function csvOptionsSql(mod) {
  const opts = mod.csvOptions || {};
  const parts = [`header=${opts.header === false ? 'False' : 'True'}`];
  if (opts.sep !== undefined) parts.push(`sep=${sqlLiteral(opts.sep)}`);
  if (opts.quote !== undefined) parts.push(`quote=${sqlLiteral(opts.quote)}`);
  return parts.join(', ');
}

async function createModuleViews(modules) {
  for (const mod of modules.values()) {
    const csvPath = path.join(DATA_DIR, mod.file);
    const columnsMap = Object.entries(mod.columns)
      .map(([name, type]) => `${sqlLiteral(name)}: ${sqlLiteral(type)}`)
      .join(', ');
    const baseSql = `read_csv(${sqlLiteral(csvPath)}, ${csvOptionsSql(mod)}, columns={${columnsMap}})`;

    // Derived dimensions/measures declared on this module (e.g. Block A's
    // nic2_pub) get baked in as real columns right here, so every
    // downstream consumer (unit_summary, standalone queries on this
    // module) sees them as ordinary columns.
    const derivedEntries = [...mod.dimensions, ...mod.measures].filter((e) => e.derived);
    const c = columnRefs(Object.keys(mod.columns));
    const selectItems = ['*', ...derivedEntries.map((e) => `${e.sql(c)} AS ${quoteIdent(e.key)}`)];

    const sql = `CREATE OR REPLACE VIEW ${quoteIdent(mod.id)} AS
      SELECT ${selectItems.join(', ')} FROM ${baseSql}`;
    await db.exec(sql);
  }
}

// Builds the "unit_summary_base" view: the spine plus every other module's
// contribution, each joined in on (yr, dsl) exactly once. Item-grain
// modules fold up via their `rollup` pivot/conditional-aggregate
// expressions (never a blanket SUM — several of these blocks already
// contain a pre-computed "total" row, so a blanket sum would double-count
// it). Every rolled-up or joined-in *measure* is wrapped in
// `COALESCE(..., 0)`, matching the source R methodology: plenty of units
// have no row at all in some blocks (e.g. 27% have no Block J row), and an
// unmatched LEFT JOIN must read as a real zero, not a NULL that poisons
// every downstream derived formula. Dimensions are deliberately left
// nullable — a fabricated "0" category is misleading in a filter/breakdown
// context even though the source methodology zeroes those too.
async function createUnitSummaryBaseView(modules, spine) {
  const selects = [`sp.yr AS yr`, `sp.${quoteIdent(spine.idColumn)} AS dsl`, `sp.mult AS mult`];
  const baseColumnNames = ['yr', 'dsl', 'mult'];
  const seen = new Set(['yr', spine.idColumn, 'mult']);
  const joins = [];

  const spineColumns = new Set([
    ...spine.dimensions.map((d) => d.key),
    ...spine.measures.map((m) => m.key),
  ]);
  for (const key of spineColumns) {
    if (seen.has(key)) continue;
    seen.add(key);
    selects.push(`sp.${quoteIdent(key)} AS ${quoteIdent(key)}`);
    baseColumnNames.push(key);
  }

  for (const mod of modules.values()) {
    if (mod.id === spine.id) continue;
    // Standalone modules (e.g. a non-ASI survey with no shared join key)
    // never fold into unit_summary at all — there's no ASI dsl/yr to join
    // against, so attempting it would either throw at startup (no matching
    // column) or silently join nothing.
    if (mod.standalone) continue;

    if (mod.grain === 'item') {
      const c = columnRefs(Object.keys(mod.columns));
      const aggs = mod.rollup
        .map((r) => `COALESCE(${r.sql(c)}, 0) AS ${quoteIdent(r.as)}`)
        .join(', ');
      const alias = `${mod.id}_r`;
      joins.push(`LEFT JOIN (
        SELECT ${quoteIdent(mod.idColumn)} AS dsl, yr, ${aggs}
        FROM ${quoteIdent(mod.id)}
        GROUP BY ${quoteIdent(mod.idColumn)}, yr
      ) AS ${quoteIdent(alias)}
        ON ${quoteIdent(alias)}.dsl = sp.${quoteIdent(spine.idColumn)}
       AND ${quoteIdent(alias)}.yr = sp.yr`);
      for (const r of mod.rollup) {
        // The inner COALESCE (above) only handles "unit has some rows in
        // this block, but none matching this pivot's code." A unit with
        // NO rows in this block at all never appears in the subquery's
        // GROUP BY output, so the LEFT JOIN itself yields NULL here — this
        // outer COALESCE is what actually catches that case.
        selects.push(`COALESCE(${quoteIdent(alias)}.${quoteIdent(r.as)}, 0) AS ${quoteIdent(r.as)}`);
        baseColumnNames.push(r.as);
      }
    } else {
      // Unit-grain, non-spine module (Block B/F/G): already one row per
      // unit, joins in directly — no GROUP BY needed. Every column it
      // contributes is prefixed with its module id to avoid colliding with
      // the spine or any other module.
      joins.push(`LEFT JOIN ${quoteIdent(mod.id)}
        ON ${quoteIdent(mod.id)}.${quoteIdent(mod.idColumn)} = sp.${quoteIdent(spine.idColumn)}
       AND ${quoteIdent(mod.id)}.yr = sp.yr`);
      const measureKeys = new Set(mod.measures.map((m) => m.key));
      const cols = new Set([...mod.dimensions.map((d) => d.key), ...measureKeys]);
      for (const key of cols) {
        const alias = `${mod.id}__${key}`;
        const colRef = `${quoteIdent(mod.id)}.${quoteIdent(key)}`;
        const expr = measureKeys.has(key) ? `COALESCE(${colRef}, 0)` : colRef;
        selects.push(`${expr} AS ${quoteIdent(alias)}`);
        baseColumnNames.push(alias);
      }
    }
  }

  const sql = `CREATE OR REPLACE VIEW unit_summary_base AS
    SELECT ${selects.join(', ')}
    FROM ${quoteIdent(spine.id)} AS sp
    ${joins.join('\n')}`;
  await db.exec(sql);

  return { baseColumnNames };
}

// Applies every *.derived.js entry targeting 'unit_summary' on top of
// unit_summary_base — e.g. the 27 ASI Principal Characteristics, several
// of which depend on each other (pc_27 -> pc_26 -> pc_21 -> pc_19/pc_20).
// deriveChain.js topologically sorts them so the file's author never has
// to hand-order entries or know how deep the chain goes.
//
// Ratio measures (SUM(numerator)/SUM(denominator), e.g. Output per Worker)
// are deliberately excluded here — they have no `sql`/`dependsOn` because
// they can't be baked into a single per-unit view column at all: dividing
// two independently-aggregated sums has to happen at query time, in the
// same GROUP BY as everything else (see buildSql.js's buildRatioAggExpr).
async function createUnitSummaryFinalView(baseColumnNames, derivedBucket) {
  const entries = [...(derivedBucket?.dimensions || []), ...(derivedBucket?.measures || [])]
    .filter((e) => !e.ratio);
  const selectSql = buildDerivedSelect('unit_summary_base', baseColumnNames, entries);
  await db.exec(`CREATE OR REPLACE VIEW unit_summary AS ${selectSql}`);
}

// Builds the in-memory "dataset" descriptors that validate.js/buildSql.js
// and the /api/metadata route work against.
function buildDatasetDescriptors(modules, spine, derivedByDataset) {
  const datasets = new Map();

  for (const mod of modules.values()) {
    // Ratio measures targeting this module by id (e.g. plfs_person's
    // LFPR/WPR/Unemployment Rate) merge into its measures the same way
    // unit_summary's ratio measures do below — never baked into the view
    // (buildSql.js's buildRatioAggExpr evaluates them at query time), just
    // added to what validate.js/buildSql.js see as this dataset's measures.
    // Non-ratio derived entries aren't supported here yet (only unit_summary
    // gets a bake-in-derived-columns pass via createUnitSummaryFinalView) —
    // fail loudly rather than silently drop them if a file ever tries.
    const modDerived = derivedByDataset.get(mod.id);
    if (modDerived?.dimensions?.length) {
      throw new Error(`derived file targeting "${mod.id}": derived dimensions aren't supported for per-module (non-unit_summary) datasets yet`);
    }
    const extraMeasures = (modDerived?.measures || []).map((m) => {
      if (!m.ratio) {
        throw new Error(`derived file targeting "${mod.id}": measure "${m.key}" isn't a ratio — only ratio measures are currently supported for per-module (non-unit_summary) datasets`);
      }
      return { key: m.key, label: m.label, ratio: m.ratio };
    });

    datasets.set(mod.id, {
      id: mod.id,
      label: mod.label,
      grain: mod.grain,
      view: mod.id,
      idColumn: mod.idColumn,
      isSpine: !!mod.isSpine,
      dimensions: mod.dimensions,
      measures: [...mod.measures, ...extraMeasures],
      // Non-spine ASI datasets don't natively have `mult` — buildSql.js
      // joins it in from the spine view at query time using these fields.
      // A module that declares its own `weight.column` (e.g. a standalone,
      // non-ASI survey with its own multiplier) is used directly instead —
      // it already has that column on its own view, no join needed.
      weight: mod.weight
        ? { column: mod.weight.column, needsJoin: false }
        : mod.isSpine
          ? { column: 'mult', needsJoin: false }
          : { column: 'mult', needsJoin: true, spineView: spine.id, spineIdColumn: spine.idColumn },
    });
  }

  const unitSummaryDims = [...spine.dimensions];
  const unitSummaryMeasures = [...spine.measures];
  for (const mod of modules.values()) {
    if (mod.id === spine.id) continue;
    if (mod.standalone) continue;
    if (mod.grain === 'item') {
      for (const r of mod.rollup) {
        unitSummaryMeasures.push({ key: r.as, label: `${mod.label} — ${r.label}` });
      }
    } else {
      for (const m of mod.measures) {
        unitSummaryMeasures.push({ key: `${mod.id}__${m.key}`, label: `${mod.label} — ${m.label}` });
      }
      for (const d of mod.dimensions) {
        unitSummaryDims.push({ ...d, key: `${mod.id}__${d.key}`, label: `${mod.label} — ${d.label}` });
      }
    }
  }

  const unitSummaryDerived = derivedByDataset.get('unit_summary');
  for (const m of unitSummaryDerived?.measures || []) {
    // Ratio measures carry their {numerator, denominator, scale} through
    // untouched — buildSql.js reads it directly off the matched measure at
    // query time (see validateQueryRequest / buildRatioAggExpr).
    unitSummaryMeasures.push({ key: m.key, label: m.label, ratio: m.ratio });
  }
  for (const d of unitSummaryDerived?.dimensions || []) {
    unitSummaryDims.push({ key: d.key, label: d.label, filterable: !!d.filterable, decode: d.decode || null });
  }

  datasets.set('unit_summary', {
    id: 'unit_summary',
    label: 'ASI Unit Summary (all blocks combined)',
    grain: 'unit',
    view: 'unit_summary',
    idColumn: 'dsl',
    isSpine: false,
    dimensions: unitSummaryDims,
    measures: unitSummaryMeasures,
    weight: { column: 'mult', needsJoin: false },
  });

  return datasets;
}

let registryPromise = null;

async function initRegistry() {
  if (!registryPromise) {
    registryPromise = (async () => {
      const { modules, spine } = buildRegistry();
      await createModuleViews(modules);
      const { baseColumnNames } = await createUnitSummaryBaseView(modules, spine);
      const derivedByDataset = loadDerivedByDataset();
      await createUnitSummaryFinalView(baseColumnNames, derivedByDataset.get('unit_summary'));
      const datasets = buildDatasetDescriptors(modules, spine, derivedByDataset);
      return { modules, spine, datasets };
    })();
  }
  return registryPromise;
}

module.exports = { initRegistry, quoteIdent };
