# Contributing a new module

This dashboard is built around one rule: **a dataset/block is a single file
in `server/modules/`.** The backend auto-discovers every `*.module.js` file
in that directory at startup, builds DuckDB views from it, and the frontend
widget populates its dataset picker, X/Y dropdowns, and filters entirely
from what the backend reports at `/api/metadata`. You never need to touch
`server/index.js`, any file under `server/routes/`, `server/query/`, or
`public/asi-dashboard.js` to add a module.

There's a second, related file type — `server/derived/*.derived.js` — for
measures that are formulas across *several* blocks (like the 27 ASI
"Principal Characteristics"), not owned by any single one. See the section
below.

If you're picking this project back up in a fresh session with no memory of
how it was built: read `server/modules/block_a.module.js` (simple) and
`server/modules/block_c.module.js` (item-grain with pivot rollups)
alongside this doc — they're the reference implementations.

## Checklist: adding one new ASI block (or any new dataset)

1. **Drop the CSV into `data/`.**
   File name is up to you; the module file below references it by name.
   (Set `ASI_DATA_DIR` env var if you keep CSVs somewhere else.)

2. **Decide the module's grain.**
   - `grain: 'unit'` — one row per (yr, DSL) already, e.g. Block B/F/G.
   - `grain: 'item'` — multiple rows per (yr, DSL), e.g. Block C/D/E/H/I/J
     (fixed assets by asset type, inputs by commodity code, etc). Item-grain
     modules **must** declare a `rollup` (see step 5) so joining them onto
     the unit-level summary can't silently fan out and double-count.

3. **Create `server/modules/<name>.module.js`** exporting one object.
   Required fields:

   | field        | meaning |
   |--------------|---------|
   | `id`         | unique lowercase snake_case slug, e.g. `block_c` |
   | `label`      | human-readable name shown in the dataset picker |
   | `grain`      | `'unit'` or `'item'` |
   | `isSpine`    | `true` only for the one module that anchors every join (already Block A — don't set this on a new module) |
   | `file`       | CSV filename, relative to `ASI_DATA_DIR` (default `./data`) |
   | `idColumn`   | this block's own DSL column name (e.g. `ac01` for Block C) — this is what joins to the spine's `a1` |
   | `columns`    | **whitelist**: EVERY raw column in the CSV, mapped to a SQL type — see the warning below, this is not optional/partial |
   | `dimensions` | array of dimension entries (physical or derived — see below) |
   | `measures`   | array of measure entries (physical or derived — see below) |
   | `rollup`     | item-grain only — see step 5 |

   **`columns` must list literally every column in the CSV's header, not just
   the ones you care about.** Confirmed empirically: DuckDB's `read_csv(...,
   columns={...})` matches positionally against the file's header — passing
   a subset throws `"It was not possible to automatically detect the CSV
   parsing dialect"`. Columns you don't want to expose still need a type
   entry; they just won't appear in `dimensions`/`measures`.

   **Get column types right, don't trust auto-detection.** This project
   deliberately uses explicit `read_csv(..., columns={...})` instead of
   `read_csv_auto` specifically because the auto-sniffer inferred two of
   Block A's own code columns (`a4`, `a8`) as `BIGINT` from a row sample
   that happened to have no leading zeros — silently corrupting any
   leading-zero value elsewhere in the file (confirmed: `district "01"` →
   `1`). Any character-coded field (state/district codes, item/commodity
   codes, CIN, etc.) should be `VARCHAR` even if it looks numeric.

4. **Physical vs. derived dimensions/measures.** A physical entry maps
   directly to one CSV column:
   ```js
   { key: 'a7', label: 'State Code', filterable: true }
   ```
   `key` must exist in `columns`. A derived entry computes a value from a
   SQL expression over other whitelisted columns of *this same module* —
   used so far for Block A's `nic2_pub` (2-digit industry grouping):
   ```js
   { key: 'nic2_pub', label: 'Industry (2-digit)', filterable: true,
     derived: true, dependsOn: ['a5'],
     sql: (c) => `CASE WHEN substr(${c.a5},1,2) IN ('01','08','10', /* ... */)
                   THEN substr(${c.a5},1,2) ELSE 'Other' END` }
   ```
   `dependsOn` keys must all be in `columns` (checked at startup). `c` is an
   object mapping every column name in this module's `columns` to its
   quoted SQL identifier — `sql(c)` returns a plain SQL expression string,
   never anything from the frontend. It gets baked into this module's own
   `CREATE VIEW` as a real column, so it works identically whether you query
   this module standalone or through `unit_summary`.

5. **If `grain: 'item'`, add a `rollup` array.** Several ASI item-grain
   blocks pack multiple *fixed, numbered* row-types per unit, and at least
   one of those rows is often a pre-computed **total** — summing every row
   blindly would double-count it. So rollup entries are pivots/conditional
   aggregates, not a blanket `SUM(...) GROUP BY dsl`:
   ```js
   rollup: [
     { as: 'land_net_closing', label: 'Land — Net Value Closing (Rs.)',
       dependsOn: ['c_11', 'c_113'],
       sql: (c) => `MAX(CASE WHEN ${c.c_11} = 1 THEN ${c.c_113} END)` },
   ]
   ```
   - `as` becomes the column name on `unit_summary` — must be globally
     unique across all modules (the loader throws at startup if it
     collides).
   - `sql(c)` must be a full **aggregate** expression (`MAX`, `SUM`, etc. —
     it runs inside a `GROUP BY idColumn, yr` subquery). Look at the actual
     data before writing one: check whether each "row type" code is truly
     fixed-position (query `SELECT DISTINCT <code column>, COUNT(*) FROM
     <table> GROUP BY 1`) and whether one of them is already a total.
   - Every rollup output gets wrapped in `COALESCE(..., 0)` automatically —
     you don't write that yourself. This matters because plenty of units
     have *zero* rows in some blocks (confirmed: 27% of units have no
     Block J row at all) — without it, a missing block would produce NULL
     that poisons every derived formula downstream.
   - Item-grain modules are *also* separately queryable at their own native
     grain (their own item-level dimensions, like asset-type code, only
     make sense there — pivoting to unit grain collapses them away). No
     extra config needed — it's automatic from `dimensions`/`measures`.

6. **Restart the server** (`npm start` or `npm run dev`).
   - A malformed module file fails loudly at startup, naming the file and
     the exact problem (missing field, unknown/undeclared column, duplicate
     `id`/rollup `as`, more than one `isSpine: true`, etc). It will not fail
     silently.

7. **Verify it appeared with zero other changes:**
   - `curl localhost:4000/api/metadata | jq` — your new dataset should be
     listed, alongside an updated `unit_summary` (if `grain: 'item'`, its
     rollup measures should now show up under `unit_summary.measures` too).
   - Reload `public/demo.html` — the dataset picker should list it; picking
     it should repopulate X/Y dropdowns and filters from your module's
     `dimensions`/`measures`, with no frontend code changes.
   - Sanity-check raw vs. weighted numbers actually differ as expected.
   - For rollups specifically: pick one real DSL, pull its raw rows from
     the CSV by hand, and confirm the pivoted `unit_summary` column matches
     the specific row/column you expect — don't just trust that it ran
     without error.

## Adding cross-block derived measures (`server/derived/`)

Some measures are formulas across *several* blocks' already-rolled-up
columns — e.g. Gross Value Added = Total Output (Blocks F/G/J) − Total
Inputs (Blocks F/H/I). These don't belong to any one module, so they live
in their own auto-discovered file type: `server/derived/<name>.derived.js`.

```js
module.exports = {
  appliesTo: 'unit_summary',
  measures: [
    { key: 'pc_19_gross_value_added', label: '19. Gross Value Added (Rs.)',
      dependsOn: ['pc_15_total_output', 'pc_18_total_inputs'],
      sql: (c) => `(${c.pc_15_total_output} - ${c.pc_18_total_inputs})` },
  ],
};
```

- `dependsOn` may name *either* a raw `unit_summary` column (any module's
  bare/rollup/`<mod>__key`-prefixed column) *or* another derived measure's
  own `key` — entries are free to depend on each other.
- **You never have to order entries or know how deep a dependency chain
  goes.** `server/query/deriveChain.js` topologically sorts every derived
  entry across every `*.derived.js` file (Kahn's algorithm) before wiring
  them into `unit_summary`, and throws a clear, named error on a real cycle
  or a typo'd dependency. `pc_27_net_profit` in
  `asi_principal_characteristics.derived.js` is 4 layers deep — its file
  lists all 27 characteristics in numeric order purely for readability,
  not because order matters.
- A one-off measure that isn't one of the 27 numbered Principal
  Characteristics doesn't have to be shoehorned into that file — give it
  its own small `*.derived.js` file instead, the way
  `asi_employment.derived.js`'s `total_persons_engaged` does. Same
  `dependsOn`/`sql(c)` mechanism either way.
- `dependsOn`/naming conventions to look up existing columns: spine (Block
  A) columns are bare (`costop`, `a11`); other unit-grain modules are
  `<moduleId>__<columnKey>` (`block_f__F7`); item-grain rollups are the
  rollup entry's own `as` (`indigenous_total_inputs`). Run
  `curl localhost:4000/api/metadata | jq '.datasets[] | select(.id=="unit_summary")'`
  to see the full current list.
- Restart and verify the same way as a module (metadata endpoint,
  `demo.html`) — plus, since these are almost always meant to satisfy some
  arithmetic identity (e.g. NVA = GVA − Depreciation), it's worth checking
  that identity holds numerically across the real data as a sanity check,
  not just that the query runs.

### Ratio measures (a third measure shape)

Some measures are genuinely ratios — Output per Worker, Labor Income (% of
GVA), Women Workforce Share (%) — where the right computation is
**SUM(numerator) / SUM(denominator)** over whatever's grouped/filtered, not
a per-unit value that then gets summed/averaged like every other measure.
This matters: averaging each unit's own ratio would let one tiny unit's
extreme value skew the result, which is wrong for a productivity or
composition metric. In the same measures array, alongside `sql`/
`dependsOn` entries, add a `ratio` entry instead:

```js
{
  key: 'output_per_worker', label: 'Output per Worker (Rs.)',
  ratio: {
    numerator: (c) => c.pc_15_total_output,
    denominator: (c) => c.total_employees,
  },
},
{
  key: 'labor_income_pct', label: 'Labor Income (% of GVA)',
  ratio: {
    numerator: (c) => `(${c.total_employee_wages} + ${c.bonus} + ${c.pf} + ${c.welfare})`,
    denominator: (c) => c.pc_19_gross_value_added,
    scale: 100, // applied after dividing — 100 for a %, 1e7 for "per crore"
  },
},
```

These two and the other two productivity ratios (Employment per Crore of
Fixed Capital, Women Workforce Share) live in
`server/derived/asi_productivity_ratios.derived.js` — its header comment
records not just what was picked (Total Employees, Fixed Capital, Total
Emoluments over GVA) but the alternatives that were considered and
rejected for each (Total Workers vs. Direct Workers, Fixed vs. Invested
Capital, wages-only vs. emoluments, GVA vs. NVA). Worth reading before
changing any of the four, since that reasoning doesn't live anywhere else.

- `numerator`/`denominator` are `sql(c) => expr` functions, same convention
  as everywhere else — but `c` here is a `Proxy`, not a fixed whitelist: any
  property access becomes a quoted column reference, since a ratio's pieces
  are often a small sum of a few existing measures/columns rather than one
  single column. `scale` is optional.
- **This is never baked into a view column.** `server/query/registry.js`
  explicitly excludes `ratio` entries from the topological-sort/bake step —
  dividing two independently-aggregated sums has to happen at query time,
  inside the same `GROUP BY` as the chart's X-axis, which per-unit derived
  measures can't express. `server/query/buildSql.js`'s `buildRatioAggExpr`
  is what actually evaluates it, reusing the same raw/weighted `SUM`
  machinery for each side.
- The requested aggregation (sum/avg/count/min/max) is **ignored** for a
  ratio measure — both sides always `SUM` (raw or weighted). The frontend
  disables the Aggregation control whenever the selected Y measure has
  `ratio: true` in `/api/metadata` (see `updateAggAvailability` in
  `public/asi-dashboard.js`) so the UI doesn't show a stale/misleading
  aggregation choice.
- **Trade-off**: unlike `dependsOn`-based entries, a ratio's column
  references aren't validated at startup (there's no fixed whitelist to
  check them against, only an arbitrary SQL expression) — a typo'd column
  name surfaces as a DuckDB error the first time someone charts that
  measure, not when the server starts. Deliberate simplification given this
  is a query-time-only construct.
- `appliesTo` isn't limited to `'unit_summary'` — it can name any dataset
  id, including a standalone (non-ASI) module's own id. `registry.js`
  merges matching ratio measures straight into that dataset's descriptor
  (see `plfs_labor_force_indicators.derived.js`, which targets
  `plfs_person` directly). Non-ratio derived entries (`sql`/`dependsOn`)
  aren't supported for a per-module target yet — only `unit_summary` gets
  a bake-in-derived-columns pass — and the loader throws a clear error at
  startup if a `*.derived.js` file tries, rather than silently ignoring it.

## Adding a decode map later

If you get an official code list (state, district, NIC industry, status of
unit, asset-type, commodity code, etc.), adding it is a one-line diff per
dimension — no rebuild. Watch the key type: `decode` keys must match the
column's actual SQL type/format exactly, or the lookup silently misses.
`a12` (status of unit) is `INTEGER`, so bare numeric keys work
(`{ 1: 'Open' }`); `a7` (state) is `VARCHAR` and zero-padded ("01".."37"),
so keys must be zero-padded strings too (`{ '09': 'Uttar Pradesh' }` — a
bare `9` will never match "09").

```js
{ key: 'a7', label: 'State Code', filterable: true, decode: { '09': 'Uttar Pradesh', '27': 'Maharashtra', ... } }
```

For a large code list (NIC 2008 has 2,049 industry codes across three
digit-lengths), don't inline it — put it in its own file under
`server/modules/data/` and `require()` it from the module:
`server/modules/block_a.module.js` loads `data/nic2008_decode.json` this
way for `a4`/`a5`/`nic2_pub`, and three modules (`block_h`/`i`/`j`) share
one `data/unit_of_quantity_codes.js` file rather than repeating the same
23-entry map three times.

**If the raw code alone isn't globally unique**, decode a composite key
instead of the bare column. PLFS district codes repeat across states (code
`"01"` is a different district in every state), so `plfs_person.module.js`
adds a derived `district` dimension whose `sql(c)` concatenates state +
district into one combined code, decoded against a combined-key JSON file
(`plfs_district_decode.json`, keyed `"1917"` not `"17"`) — the bare
district column stays available too, just undecoded, for anyone who wants
the raw per-state code.

## Adding an entirely new (non-ASI) dataset later

A module doesn't have to be an ASI block, and doesn't have to be a real
CSV file either. `server/modules/plfs_person.module.js` (PLFS microdata —
a different survey, different sampling frame, no shared join key with
ASI) is the reference implementation; read it alongside `block_a`/
`block_c`. Three fields make this work, all optional and all backward-
compatible (an ASI module that doesn't set them behaves exactly as before):

1. **`standalone: true`** — opts this module out of the automatic
   `unit_summary` fold-in entirely. Without this, *every* non-spine module
   gets joined into `unit_summary` in `registry.js`, which for an
   unrelated dataset would either throw at startup (if it lacks a `yr`
   column, which it likely does) or silently join nothing useful. Don't
   set `isSpine` on a standalone module — the loader rejects a module that
   tries to be both.

2. **`weight: { column: '<key>' }`** — every ASI module gets weighting
   for free via the automatic spine join (`buildSql.js` fetches `mult`
   from Block A by `dsl`). A standalone module has no such join key, so it
   must declare its own weight column directly — it's used as-is
   (`needsJoin: false`), no join required, since the column already lives
   on the module's own view. Note: there's currently no way to mark a
   dataset as having *no* weighting at all — the frontend's "Weighted"
   checkbox is unconditionally rendered for every dataset — so a future
   standalone dataset with no real sampling weight will need that handled
   explicitly (either give it a constant weight of 1, or extend the
   frontend to hide the checkbox when `weight` is absent) before this
   becomes a real problem.

3. **`csvOptions: { header, sep, quote }`** — overrides the default
   `read_csv(header=True, ...)` call for a module whose source file isn't
   normal delimited CSV. `plfs_person.module.js` uses this to read a
   **fixed-width text file**: `columns` is just `{ line: 'VARCHAR' }` (one
   raw column per row), `csvOptions` sets `header: false` and a `sep` byte
   guaranteed not to occur in the data (so the whole line lands in that
   one column) with `quote: ''` to disable CSV quote handling. Every real
   field is then a `derived: true` dimension/measure whose `sql(c)` does
   `substr(c.line, start, len)` — same mechanism as any other derived
   column, just depending on the one synthetic `line` column instead of
   named physical ones. For a file with ~100+ fields, don't hand-write
   that many entries: generate a small layout-table file once (see
   `server/modules/data/plfs_person_layout.js`, an array of
   `{ key, label, start, len, kind, sqlType }`) and map over it in the
   module file to build `dimensions`/`measures` programmatically.

`idColumn` still needs to be a non-empty string, but for a standalone
module it's purely descriptive — it's never used in generated SQL (grep
confirms `idColumn` only appears in spine/rollup join code, none of which
runs for a standalone module), so it doesn't have to name a real column;
`modules/index.js` skips the "must be in `columns`" check when
`standalone: true`.

## Adding a new chart type

Two small, independent edits, no wiring required elsewhere:
1. Backend: add the string to `VALID_CHART_TYPES` in `server/query/validate.js`.
2. Frontend: add a renderer function to `CHART_RENDERERS` in
   `public/asi-dashboard.js` (same shape as the existing `bar`/`line`/`pie`
   entries — takes a canvas context, labels, values, color; returns a
   `Chart` instance).

## Extending the Financial Analyzer (`public/financial-analyzer.*`)

This feature is architecturally separate from everything above — no
DuckDB, no module system, no server involvement at all. It parses
Screener.in exports entirely client-side and is a JS port of
`app_financial.py` (a Streamlit tool); see `CLAUDE.md`'s section on it for
the high-level shape.

- **Changing the extraction/analysis logic** (which section keywords to
  look for, how common-sizing or averaging works) belongs in
  `public/financial-core.js`, which is deliberately DOM-free — no
  `document`, no `fetch`, nothing browser-specific. That's what lets it be
  verified directly in Node (`require()` it, feed it `array-of-arrays` from
  the `xlsx` npm package reading a real sample file, assert on the
  output) without ever driving a browser. Do this before wiring a change
  into the UI — it's a much faster feedback loop, and it's how this file's
  logic was originally checked against real Infosys/ITC/Reliance Industries
  exports.
- **Changing the UI** (new tab, different chart, upload behavior) belongs
  in `public/financial-analyzer.js`, which owns the DOM/SheetJS/Chart.js
  wiring and calls into `financial-core.js` for all the actual computation.
- **A new Screener section** (e.g. actually extracting the quarterly P&L,
  which today is only used as an end-boundary keyword for the annual P&L,
  never itself extracted) is one more `extractSection(rows, startKeyword,
  endKeywords)` call in `parseCompanySheet` — the function already handles
  arbitrary start/end keyword pairs.
- Confirmed directly against real sample files (not assumed): Screener's
  "Data Sheet" sheet has a **fixed row layout** identical across companies
  (same section keywords at the same rows regardless of company; a
  company's non-applicable line items are just blank rather than the row
  being absent), and its `Report Date` header cells are genuine Excel
  dates, not text — `financial-core.js`'s `yearOf` relies on both. CSV
  export support exists in the code (mirroring `app_financial.py`) but
  wasn't verified against a real Screener CSV — only `.xlsx` samples were
  available — so treat that path as unconfirmed if a CSV upload ever
  parses incorrectly.

## Extending the Trade Explorer (`public/trade-explorer.*`, `server/comtrade/*`)

Also architecturally separate from everything above — no `server/modules/`
registry, no CSV `columns` whitelist, no DuckDB *views*. See `CLAUDE.md`'s
section on it for the full shape (live-fetch + shared persistent cache,
bring-your-own-key). A few concrete extension points:

- **A new trade measure** (e.g. CIF/FOB value, tariff-line detail) needs
  three changes together: `server/comtrade/client.js`'s `normalizeRow`
  (add the new field), `server/comtrade/cache.js`'s `trade_records` table
  (add a column — this is a real schema change to a persistent file, so
  either accept `NULL` for already-cached rows or write a small one-off
  migration), and `public/trade-explorer.js`'s measure radio group +
  `buildChartData`.
- **Trade balance as a real measure**, rather than something the frontend
  computes from two separately-fetched flows, would use Comtrade's own
  `tools/v1/getTradeBalance/{typeCode}/{freqCode}/{clCode}` endpoint
  (confirmed to exist in `comtradeapicall`'s source, not yet wired up
  here) — add a `fetchTradeBalance` alongside `fetchTradeData` in
  `client.js` rather than trying to make the existing X/M-flow cache
  double as a balance source.
- **Monthly instead of/alongside annual data**: `client.js`'s
  `fetchTradeData` hardcodes `freqCode = 'A'`. Comtrade supports
  `freqCode = 'M'` for many reporters since ~2000, but a monthly `period`
  value has a different format (`YYYYMM`) than annual (`YYYY`) —
  `cache.js`'s `year` column and `planner.js`'s cell-diffing logic both
  assume a bare year, so this isn't a one-line change; treat frequency as
  a first-class part of the cache key, not an afterthought.
- **A new flow type** needs nothing extra — `X`/`M`/`RX`/`RM` are already
  the full set the route validates (`VALID_FLOW_CODES` in
  `server/routes/comtrade.js`) and the frontend already renders all four
  as checkboxes.
- **A new reference-data category** (country/HS lists today) comes from
  `server/comtrade/reference.js`'s `fetchReferenceCategory`, which looks up
  any category by name via Comtrade's own `ListofReferences.json`
  directory — adding e.g. a services classification (EBOPS) reference
  would reuse this helper directly, no new fetch logic needed. The same
  file's `lookupHsCodes` (exact-code lookup over the cached full list,
  backing the bulk-paste picker) is the pattern to follow for any other
  "resolve a list of codes to descriptions" need.
- **A new discovery/ranking combination** (`server/comtrade/breakdown.js`,
  `POST /api/comtrade/breakdown`): today it only fixes reporter-omit-
  partner or partner-omit-reporter. A "top partners for a reporter,
  restricted to one partner's own trading region" or similar would still
  go through `fetchBreakdown`'s `anchorRole`/`anchorCode` shape — just add
  whatever additional fixed param the new combination needs to the `cell`
  object it builds, no change to the ranking/aggregation logic below that.
- **A new chart type or measure**: chart types live in the `CHART_TYPES`
  array and the `redrawChart()` branch in `trade-explorer.js` (Pie is the
  odd one out — it needs a snapshot year, everything else reuses the same
  per-year series shape); measures are a third case in `buildChartData()`'s
  per-cell `val` computation plus a radio in the template — follow the
  existing Quantity/Unit Price pair, including their shared "pick the
  majority `qty_unit`, gap out any row reporting a different one" guard
  (`renderResult()` computes `this.singleQtyUnit`; `buildChartData()`
  enforces it per-row) — **not** a hard disable-on-any-variance, which was
  the original design and turned out too blunt (see `CLAUDE.md`'s
  `qty_unit` notes for why).
- **When a control's availability depends on data you just fetched**
  (like Quantity/Unit Price above), surface the reason both as the
  control's `title` (hover tooltip) *and* as visible on-screen text
  (`data-role="qty-unit-note"` is the existing example) — a disabled
  control with only a hover tooltip reads as silently broken, which is
  exactly what happened here before the visible note was added.
- Verify any change the same way this module was originally verified:
  `curl` `/api/comtrade/reference/*` and `/api/comtrade/preview`/`query`
  directly, then drive `public/trade-explorer.html` in a browser with a
  real Comtrade API key — there's no way to exercise the live-fetch path
  without one.
