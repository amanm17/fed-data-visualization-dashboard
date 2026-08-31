# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An embeddable data-visualization dashboard, originally built for India's
Annual Survey of Industries (ASI) unit-level microdata and now also
covering PLFS (Periodic Labour Force Survey) person-level microdata as a
second, unrelated survey. Node/Express backend, DuckDB as the query engine
(reads CSVs — and, for PLFS, a fixed-width text file — directly, no
separate DB server, no ETL step), vanilla JS + Chart.js frontend shipped as
a single embeddable widget (`<div data-asi-dashboard>` + one `<script>`
tag). Two further, architecturally separate features exist alongside this:
the **Financial Analyzer** (`public/financial-analyzer.html`), which parses
multi-company Screener.in exports entirely client-side, and the **Trade
Explorer** (`public/trade-explorer.html`), which fetches and caches live
UN Comtrade trade data. See their own sections below, since none of the
module-system architecture described next applies to either.

## Commands

```
npm install
npm start        # node server/index.js — http://localhost:4000
npm run dev       # same, with --watch (auto-restart on file change)
```

There is no test suite, lint config, or build step in this project —
`npm start`/`npm run dev` and manual verification (curl the API, drive
`public/demo.html` in a browser) are the only feedback loops. When
verifying a change, prefer:
- `curl localhost:4000/api/metadata | jq` to check the module registry
  wired up correctly (new dataset/dimension/measure appears).
- `curl -X POST localhost:4000/api/query -H "Content-Type: application/json" -d '{...}'`
  to check a specific query.
- Loading `public/demo.html` in a browser to check the widget end-to-end.

`ASI_DATA_DIR` env var overrides the data directory (default `./data`,
gitignored — CSVs *and* PLFS's `CPERV1.txt` are not committed; see
`.gitignore`'s `data/*.csv`/`data/*.txt`).

**Deployment**: see [DEPLOY.md](DEPLOY.md) — Render (Starter plan +
persistent disk), with `scripts/ensure-data.js` (wired in as `prestart`)
handling the one real wrinkle: the 566MB of gitignored data needs to reach
the server's disk somehow, and that script downloads it from an archive
URL exactly once (idempotent no-op on every boot after that).

## Architecture

### The core idea: modules become DuckDB views, wired together at startup

Everything flows from `server/modules/*.module.js` files, each describing
one ASI Block (or any other CSV dataset): its CSV filename, a `columns`
whitelist (name → SQL type, for *every* column in the file), `dimensions`,
`measures`, and — for multi-row-per-unit blocks — a `rollup`.
`server/modules/index.js` auto-discovers and validates these at startup;
`server/query/registry.js` turns the validated registry into real DuckDB
views (`initRegistry()`, called once from `server/index.js` before the
HTTP server starts listening). Nothing else in the codebase names a
specific block — `server/routes/`, `server/query/validate.js`,
`server/query/buildSql.js`, and `public/asi-dashboard.js` all work purely
off whatever `initRegistry()` produced. **Adding a new dataset means adding
one `*.module.js` file — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
full checklist and the exact module-file contract** (grain, `isSpine`,
rollup pivots vs. blanket aggregates, derived dimensions/measures, decode
maps). Two worked examples are already in the repo:
`server/modules/block_a.module.js` (simplest, unit-grain, the spine) and
`server/modules/block_c.module.js` (item-grain with pivot rollups).

One module (Block A) is the **spine**: it provides the join key (`dsl`)
and sampling weight (`mult`) that every other module joins against.
`registry.js` builds a combined `unit_summary` view by joining the spine to
every other module — item-grain modules fold in via their `rollup` pivots
(`GROUP BY idColumn, yr`, never a blanket `SUM` — several blocks contain a
pre-computed "total" row that a blind sum would double-count), unit-grain
modules join in directly with columns prefixed `<moduleId>__<column>`.
Every rolled-up/joined *measure* is wrapped in `COALESCE(..., 0)` since
plenty of units have zero rows in a given block.

### Standalone (non-ASI) datasets — `standalone: true`

A module doesn't have to belong to the ASI spine family at all. Setting
`standalone: true` on a module descriptor (see `plfs_person.module.js`)
does two things in `registry.js`: it's skipped entirely from the
`unit_summary` fold-in (no join is even attempted — the module doesn't
need a `yr` column or any relationship to the ASI `dsl`), and it must
declare its own `weight: { column: '<key>' }` instead of getting the
automatic ASI-spine weight join every other non-spine module gets.
`buildSql.js` needs no changes for this — it already treats
`weight.needsJoin: false` generically, using `t.<column>` directly,
regardless of which module declares it. Ratio measures (see below) also
work for any standalone dataset, not just `unit_summary` — a
`*.derived.js` file's `appliesTo` can name any module id, and
`registry.js`'s `buildDatasetDescriptors` merges its ratio measures into
that dataset directly (non-ratio derived entries aren't supported yet for
per-module datasets — only for `unit_summary` — and fail loudly at
startup if attempted, rather than being silently dropped).

This is also the escape hatch for non-CSV source files: a module can
override the default `read_csv(header=True, ...)` behavior via an
optional `csvOptions: { header, sep, quote }`. `plfs_person.module.js`
uses this to read a **fixed-width text file** as a single raw-line column
(`sep` set to a byte that never occurs in the data, `quote: ''` to disable
CSV quote handling) and then exposes every real field as a `derived`
dimension/measure using `substr(line, start, len)` — the exact same
`derived: true, dependsOn, sql(c)` mechanism used everywhere else for
computed columns, just depending on one synthetic `line` column instead of
named physical ones. See `server/modules/data/plfs_person_layout.js`
(generated once from the official layout file) for the byte-position
table this is built from.

### Cross-block derived measures (`server/derived/`)

`server/derived/*.derived.js` files declare measures that are formulas
*across* several already-rolled-up columns on `unit_summary` (e.g. the 27
official ASI "Principal Characteristics" — GVA, NVA, Net Profit, etc., in
`asi_principal_characteristics.derived.js`). These can depend on each other
arbitrarily deep (`pc_27` is 4 layers deep); `server/query/deriveChain.js`
topologically sorts all of them (Kahn's algorithm) so the file's author
never has to hand-order entries. This and the per-module `rollup`/derived-
dimension mechanism all compile down to a `sql(c) => "SQL expression"`
function baked into a `CREATE VIEW` at startup — by query time, every
dimension/measure (physical, pivoted, or cross-block-derived) is just an
ordinary column. This is why `server/query/validate.js` never needs to know
about any of this.

There's a second, query-time-only measure shape in the same files: **ratio
measures** (`asi_productivity_ratios.derived.js` — Output per Worker, Labor
Income % of GVA, etc.), declared as `{ key, label, ratio: { numerator,
denominator, scale? } }` instead of `sql`/`dependsOn`. These compute
`SUM(numerator)/SUM(denominator)` — a true ratio-of-aggregates, not a
per-unit value averaged afterward (averaging each unit's own ratio would
let one tiny unit's extreme value skew a productivity/composition metric).
Because that division has to happen inside the same `GROUP BY` as the
chart's X-axis, ratio entries are explicitly excluded from the view-baking
step and instead evaluated by `buildRatioAggExpr` in `buildSql.js` at query
time — the one case where `buildSql.js` *does* need to know about a
derived-measure detail. The frontend disables the Aggregation control
whenever the selected Y measure has `ratio: true` (from `/api/metadata`),
since both sides always `SUM` regardless of what aggregation was requested.

Not every plain `sql`/`dependsOn` measure has to live in the 27-PC file —
`asi_employment.derived.js`'s `total_persons_engaged` is a one-off example
of the same mechanism used for a single standard ASI concept that isn't
one of the 27 numbered Principal Characteristics. It's computed the way
MoSPI's own ASI methodology derives an average headcount from raw survey
responses — mandays worked ÷ days the factory worked — rather than by
summing the already-averaged per-category headcount rollups
(`total_employees` + `unpaid_family_members`) that `block_e.module.js`
also exposes; both approaches are algebraically equivalent when every
category's own average was computed over the same days-worked denominator,
but the mandays-based version was the one actually wanted here. Confirmed
directly against the real data: hand-checked against several real DSLs
(exact match), and confirmed the ~14% of units where it comes back `NULL`
are exactly the ones with `wdays = 0` (a factory that reported zero
working days that year) — `NULLIF(wdays, 0)` guards this on purpose,
rather than letting a divide-by-zero either error or silently produce
`Infinity`.

### Query pipeline (backend)

`server/routes/{metadata,query,dimensionValues}.js` are thin: they call
`initRegistry()` then hand off to `server/query/validate.js` (whitelist gate
— every dataset/dimension/measure/aggregation/filter key from the frontend
is checked against the registry before anything touches SQL) and
`server/query/buildSql.js` (turns a validated request into parameterized
SQL — filter *values* are always bound as prepared-statement params, never
concatenated; raw vs. weighted aggregation formulas live here). `server/db.js`
is a thin DuckDB connection singleton that also sanitizes `BigInt` results
(DuckDB returns `BIGINT` for some aggregates; `JSON.stringify` can't
serialize those) before rows go back over HTTP.

**Weighting is a hard requirement, not an add-on**: ASI is a sample survey.
Every measure supports raw (`SUM`/`AVG`/`COUNT`/`MIN`/`MAX`) and weighted
mode using each unit's `mult`: weighted sum = `SUM(value * mult)`, weighted
avg = `SUM(value * mult) / SUM(mult)` (not an average of pre-weighted
rows), weighted count = `SUM(mult)`. See `buildAggExpr` in `buildSql.js`.

### Frontend widget (`public/asi-dashboard.js`)

A single self-contained class (`ASIDashboardWidget`) that auto-inits on any
`[data-asi-dashboard]` element. It fetches `/api/metadata` once and builds
every control (dataset picker, X/Y/aggregation, filters, highlights) purely
from that response — it has no hardcoded knowledge of any block. Key
internal pieces:
- `CHART_RENDERERS` — a `{bar, line, pie}` registry; adding a chart type
  means adding one key here plus one string in `validate.js`'s
  `VALID_CHART_TYPES`.
- Filters render as checkbox lists (populated via `/api/dimension-values`,
  which only lists dimensions the dataset actually declares — see
  `validateDimensionRequest`) with a client-side search box and All/Clear.
- Highlights (multiple categories, each its own color) and Top-N capping
  live together in one row directly above the chart, and are both
  **client-side only** — they re-slice/re-color the *last fetched*
  `/api/query` result (`this.lastResult`) via `redraw()` rather than
  re-querying. Only dataset/X/Y/aggregation/weighted/filter changes call
  `runQuery()` (the backend has no concept of "top N" or "highlight").
- Weighted defaults to checked (ASI is a sample survey — raw counts
  understate the real population unless you're deliberately comparing).
- Decoded (human-readable) labels come from each dimension's `decode` map
  in the metadata response; raw codes are what's actually sent
  to/received from the API and matched against for filtering/highlighting.
- "Download PNG"/"Download CSV" (next to the highlights row) export
  `this.lastDrawn` — the same post-Top-N, post-highlight data already on
  screen, no re-fetch. The PNG path deliberately does **not** reuse
  `CHART_RENDERERS`: a static image can't offer the tooltip that reveals a
  truncated tick's full text, so `buildExportChart` re-renders onto an
  offscreen canvas with truncation off, `autoSkip: false`, and labels
  rotated 90° instead — kept as a separate function so export-only
  changes can't affect the tested on-screen rendering path.

### Financial Analyzer (`public/financial-analyzer.*`) — a separate feature

This is a JS port of a Streamlit tool (`app_financial.py`) for analyzing
multiple companies' Screener.in "Data Sheet" exports (.xlsx/.csv) — pull
every line item across companies, common-size everything to total revenue,
compare trends. It shares nothing with the ASI/PLFS module system above:
no DuckDB, no server involvement at all. Files are parsed entirely in the
browser via SheetJS (`XLSX`, loaded from a CDN in `financial-analyzer.html`)
and never leave the machine.

- `public/financial-core.js` — pure, environment-agnostic logic (no DOM):
  `extractSection` (slices a keyword-delimited block like `PROFIT & LOSS`
  out of the raw sheet and normalizes its date-header row down to years),
  `commonSize`, `aggregateAverage`. Because it has no browser dependency,
  it can be `require()`'d from a plain Node script (with the `xlsx` npm
  package standing in for the browser global) to verify logic against real
  sample files without driving a browser — that's how it was built and
  checked originally.
- A `Section` is an **array** of `{ name, values }` rows, not a plain
  object keyed by name — Screener's own Balance Sheet layout repeats the
  label `Total` twice (Total Liabilities, Total Assets); pandas tolerates
  duplicate index labels but a plain JS object would silently drop one.
  `aggregateAverage` deliberately groups by name across every row from
  every company (matching pandas' `groupby(level=0)` after `pd.concat`),
  so those two same-named `Total` rows merge into one averaged value too —
  harmless in practice since Total Liabilities and Total Assets are
  numerically identical by the balance-sheet identity, but worth knowing
  if this pattern gets reused for a statement without that property.
- `public/financial-analyzer.js` is the browser UI layer: file upload
  (click or drag-drop), 4 tabs (Individual / Aggregate Averages /
  Comparative Trends / Avg Common-Size Trends), plain HTML tables, and
  Chart.js line charts for the two trend tabs.

### Trade Explorer (`public/trade-explorer.*`, `server/comtrade/*`) — a third, separate feature

A UN Comtrade trade-data explorer: pick reporter/partner countries, HS
product codes, and import/export flow, then chart real trade data across
years. Ported from an existing but much more complex Python/Streamlit tool
(a DGCIS/QE "sector preset" mapping layer over Comtrade) — that mapping
layer was deliberately dropped per the user's own direction; only the
underlying fetch/cache/batching mechanics were kept. Shares nothing with
the ASI/PLFS module system or the Financial Analyzer: no CSV files, no
DuckDB *views* (though it does use DuckDB — see below), and — unlike the
Financial Analyzer — it's **not** fully client-side, since a subscription
key and a shared cache both need to live server-side.

- **Fetch model: hybrid live-fetch + shared persistent cache.** Comtrade
  data isn't preloaded — a visitor picks reporters/partners/HS codes/flow/
  years, and the backend only calls the live Comtrade API for whatever
  isn't already cached. Every fetched row is upserted into a **persistent**
  DuckDB file (`data/comtrade_cache.duckdb`, path overridable via
  `COMTRADE_CACHE_DIR`) shared across every visitor — deliberately a
  *separate* DuckDB instance from `server/db.js`'s `:memory:` one, which
  exists purely to rebuild the ASI/PLFS CSV views fresh on every boot and
  was never meant to persist anything.
- **Access model: bring-your-own-key.** Each visitor pastes their own free
  Comtrade subscription key(s) into a settings panel; keys live only in
  that browser's `localStorage` and are sent to this app's own backend
  with each request — never anywhere else, never persisted server-side. No
  key -> demo mode (browse/chart whatever's already in the shared cache,
  no live fetch). Multiple keys -> `server/comtrade/keyPool.js`
  round-robins across them so combined daily quota is the sum of each
  key's own 500-calls/day free-tier limit.
- **Backend** (`server/comtrade/`): `client.js` (raw REST client — see
  "Comtrade API contract" below), `batching.js` (chunks a request to
  respect Comtrade's real per-call limits), `cache.js` (the persistent
  DuckDB table, upserted via `INSERT ... ON CONFLICT ... DO UPDATE`),
  `reference.js` (country + HS-code reference data, live-fetched from
  Comtrade's own public, keyless reference endpoints and cached locally
  with a 30-day TTL), `planner.js` (diffs a request against the cache to
  find what actually needs fetching — at (reporter,partner,flow)-triple
  granularity, not per-cell, since one API call already covers a whole
  HS-code x year block regardless of which specific cells within it are
  missing), `keyPool.js`, `queryService.js` (orchestrates all of the above
  for one request), and `breakdown.js` (see "Discovery/ranking" below).
  Routes live in `server/routes/comtrade.js`, mounted at `/api/comtrade` —
  kept entirely separate from the ASI/PLFS `initRegistry()` startup path.
- **Frontend** (`public/trade-explorer.{html,js,css}`): a separate page
  (like the Financial Analyzer), with reporter/partner/HS-code
  search-and-multi-select pickers (feeding `/api/comtrade/reference/*`,
  plus a "paste codes in bulk" textarea backed by
  `/api/comtrade/reference/hs/lookup`), flow/year controls, and a Chart.js
  chart — one series per reporter/partner/flow/HS-code combination that's
  actually varying in the request. Three measures (Trade Value, Quantity,
  Unit Price — the last two use the *majority* `qty_unit` in the result
  and gap out any row reporting a different one, e.g. USD/kg vs USD/item;
  only disabled outright when there's no usable quantity data at all —
  see the two `qty_unit` notes further down), five chart types (Line/Area/Bar Grouped/Bar Stacked/Pie — Pie
  needs a single snapshot year, defaulting to the latest), and a color
  theme picker (4 FED-deck presets + a Custom mode with real color
  pickers) all just reshape/re-render `this.lastResult` client-side, no
  re-fetch. Before a live fetch, `/api/comtrade/preview` returns a
  call-count estimate so the UI can confirm with the visitor if their key
  pool's estimated remaining quota looks insufficient (a client-side
  `localStorage` estimate only — Comtrade doesn't expose real remaining
  quota, so its own 429 response is the actual enforcement).
- **Discovery/ranking** (`server/comtrade/breakdown.js`, `POST
  /api/comtrade/breakdown`): fixes one side of a trade relationship
  (reporter or partner) and omits the *other* side from the API call
  entirely — Comtrade returns every real country's breakdown in that one
  call, the same trick the reference Python tool used for "find top
  partners for a reporter" (omit `partnerCode`) and "top exporters/
  importers of a product" (omit `reporterCode`, `partnerCode` fixed to
  `0`/World). Always a live fetch (there's no reliable way to know a full
  breakdown was ever cached before, so this mode requires an API key and
  never falls back to demo mode) but every real row it returns is still
  upserted into the shared cache. Two frontend panels — "Find top
  partners" and "Top exporters/importers" — call this and offer an
  "Add these to my selection" button that merges results straight into
  the reporter/partner pickers. Each panel has its **own single-year
  field**, deliberately independent of the main query builder's year
  *range* — ranking sums every row it gets back per country with no
  per-year split, so reusing the main range by default (as the first cut
  of this feature did) silently summed a decade of trade into one number,
  which reads as "wrong" the moment it's cross-checked against Comtrade's
  own (single-year) UI.

  **This single year defaults to `thisYear - 2`, not `thisYear - 1`** —
  confirmed directly against Comtrade that the more recent year is
  frequently too fresh for major economies to have filed yet (China had
  zero rows for the most recent year while ~76 smaller/faster reporters
  already did for the same product, which silently promoted whichever
  country happened to report early to the top rank). The response also
  carries `totalCountriesFound` (the full count before slicing to
  `topN`), shown to the user as "N countries have reported data for
  &lt;year&gt; so far" specifically so a suspiciously short list is
  self-evident rather than silently misleading — this is a genuine
  Comtrade reporting-lag characteristic, not something a fixed default
  year can fully paper over for every HS code.
- **% share + Rest of World**: since World (partner code `0`) is already
  a normal partner option, selecting it alongside other real partners (for
  a single reporter/flow/HS-code query) reveals a "Show as % of World
  total" toggle. `buildChartData()` in `trade-explorer.js` then divides
  each selected partner's value by the World total per year and
  synthesizes a "Rest of World" series (`World − sum(selected)`, clipped
  at 0) — purely a client-side transform of already-fetched data, no new
  endpoint.
- **CSV export is tidy/long, not wide.** `downloadCSV()` originally
  mirrored the chart: one column per series (a `Reporter · Partner ·
  Flow · HS` label baked into the header) and one row per year — fine for
  re-plotting but useless for sorting/filtering in a spreadsheet, since
  every dimension was flattened into an opaque header string. Rewritten to
  export `this.lastResult.records` directly, one row per (reporter,
  partner, flow, HS code, year) cell with every dimension its own decoded
  column (`Reporter Code`/`Reporter`, `Partner Code`/`Partner`, `Flow`,
  `HS Code`/`HS Description`, `Year`) plus `Trade Value (USD)`,
  `Quantity`, `Quantity Unit`, and a computed `Unit Price` — sortable/
  filterable by any of them. Deliberately independent of the on-screen
  measure radio and % share toggle (both are just chart-side views of this
  same data) since the tidy export already carries value and quantity
  together per row.
- **`net_wgt_kg` is a separate column from `Quantity`/`Quantity Unit`,
  always in kg.** Comtrade's `qty`/`qtyUnitAbbr` reports each commodity's
  quantity in whatever unit its own classification uses (confirmed: HS
  610230 export came back with `qty: 306402, qtyUnitAbbr: "u"`) — but the
  *same response row* also carries `netWgt`, a weight-in-kg figure
  reported for virtually every commodity regardless of what `qty`'s unit
  is. `client.js`'s `normalizeRow` now captures both; `cache.js`'s
  `trade_records` table has a `net_wgt_kg DOUBLE` column (migrated onto
  pre-existing cache files at boot via `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`, confirmed to work against this project's installed
  `duckdb-async`) alongside the existing `qty`/`qty_unit`. The CSV export's
  `Net Weight (kg)` column exists so a user who wants one standardized
  unit across every HS code doesn't have to fight `qty_unit` switching
  between "u", "kg", "No", etc. per product. Rows cached before this
  migration have `net_wgt_kg = NULL` until their triple is re-fetched live
  — there's no way to backfill a weight Comtrade was never asked to
  return.

**Comtrade API contract** — not documented anywhere convenient for a
non-Python client, so it was read directly out of the official
`comtradeapicall` Python package's source rather than guessed:
`data/v1/get/{typeCode}/{freqCode}/{clCode}` for trade data
(`subscription-key` is a **query parameter**, not a header), and
`files/v1/app/reference/ListofReferences.json` -> per-category `fileuri`
for reference data (categories `reporter` and `cmd:HS` — the latter is
Comtrade's combined-HS-revisions classification, matching the `clCode=HS`
used everywhere else). Confirmed empirically that Comtrade's own country
reference list has **no "World" entry** — partner code `0` (aggregate
across all partners) is a synthetic value the data API accepts but the
reference API never lists, so the frontend adds it as a synthetic option
rather than looking it up. Confirmed per-call limits (hardcoded from the
reference Python tool, which hit real API errors above them): **max 20
comma-joined HS codes, max 12 comma-joined years per call**. Omitting
`partnerCode` to get every partner's breakdown in one call is directly
confirmed (the reference tool's own `fetch_top_partners` does exactly
this); `breakdown.js`'s symmetric use of omitting `reporterCode` instead
(for "top exporters/importers of a product") is a reasonable inference
from the same REST layer generically dropping any missing param, not
something independently observed in the reference tool's source — flagged
in `breakdown.js`'s own comment, worth double-checking against a real
response if that panel ever looks wrong. Since confirmed and now moot for
a different reason (see next).

**`breakdownMode` is not optional, despite looking like it** — confirmed by
querying Comtrade's own public, keyless preview endpoint
(`public/v1/preview/{typeCode}/{freqCode}/{clCode}`, same param shape,
no `subscription-key` needed) directly: a plain query for one (reporter,
partner, flow, HS code, year) came back as **2 rows with an identical
`primaryValue`**, split by `partner2Code`; across a wider batch, over half
of all reporters had 2–6 duplicate/split rows instead of one. Adding
`breakdownMode=classic` (which `client.js` now always sends) collapsed the
same query to exactly 1 correct row. This matters most for
`breakdown.js`'s ranking, which sums every row it receives per country —
without this param it was badly (and inconsistently, since the duplicate
count varies by country) overcounting. The regular per-cell cache path
was accidentally shielded from a *visibly* wrong total (`cache.js`'s
`ON CONFLICT DO UPDATE` overwrites rather than sums same-key rows, so it
silently kept just one arbitrary duplicate), but which one "wins" is
nondeterministic, so this is fixed at the request level for both paths.
Matches what the reference Python pipeline always passed explicitly for
exactly this reason — our port had dropped it.

**`qtyUnitAbbr` is the literal string `"N/A"` on value-only rows, not
null/absent** — confirmed against real cached responses: rows with no
usable quantity still carry `qtyUnitAbbr: "N/A"`, not a missing field, so
`client.js`'s `normalizeRow` was passing it straight through as if it were
a real unit. This corrupted `trade-explorer.js`'s "does this selection
share a single quantity unit" check (`renderResult`'s `qtyUnits` set) —
any multi-year series with even one value-only year looked like a
2-unit mix (`{"u", "N/A"}`), permanently disabling the Quantity and Unit
Price radios for a selection that was really all one unit. Fixed at the
source (`qtyUnit` is now only ever set when `qty` itself is non-null) and
defensively on the frontend (`qtyUnits` is now derived only from rows that
have a real `qty`), plus a one-time cleanup of the already-cached rows
that had this stale value baked in (`UPDATE trade_records SET qty_unit =
NULL WHERE qty IS NULL`).

**A single series can genuinely switch units across years** — separately
confirmed against real cached data (not the `"N/A"` artifact above): the
same (reporter, partner, flow, HS code) sometimes reports in `"u"` most
years and `"kg"` for one or two others. The original design disabled
Quantity/Unit Price outright on *any* unit variance in the result set,
which was too blunt — it blocked the whole feature over one outlier year.
`renderResult()` now picks the most-common real unit (`this.singleQtyUnit`)
and `buildChartData()` treats any row reporting a different unit as a gap
(the same way a missing year already renders), only disabling the two
measures outright when there's no usable quantity data at all. The disabled
tooltip and an on-screen note both explain when this is happening, listing
which units were mixed.

### Known sharp edges (worth knowing before touching module files)

- `read_csv(..., columns={...})` requires listing **every** column in the
  CSV's header, not just the ones you expose — confirmed empirically, it's
  positional against the file, and a partial map throws a sniffing error.
- Explicit `columns` types are load-bearing, not documentation:
  `read_csv_auto`'s per-column type sniffing previously inferred some
  leading-zero code columns as `BIGINT`, silently corrupting them (e.g.
  district `"01"` → `1`). Any character code column must be typed
  `VARCHAR` even when it looks numeric.
- `decode` map keys must match the column's actual SQL type/format exactly
  — `a12` (INTEGER) uses bare numeric keys, `a7` (VARCHAR, zero-padded)
  needs zero-padded string keys, or the lookup silently misses.
- Ratio measures aren't validated at startup the way `dependsOn`-based
  derived measures are (there's no fixed column whitelist to check an
  arbitrary `sql(c)` expression against) — a typo'd column in a `ratio`
  entry surfaces as a DuckDB error the first time someone charts that
  measure, not when the server starts.
- Fixed-width files can have CRLF line endings (`CPERV1.txt` does) —
  confirmed the reported byte length in the layout file (371) doesn't
  include the trailing `\r\n`; DuckDB's CSV reader strips it automatically
  when reading the file as a single raw-line column, so byte positions
  from the layout file line up exactly with no manual adjustment needed.
- A composite code (e.g. PLFS district) needs a composite decode key.
  Raw district codes repeat across states (confirmed against the official
  771-row code list — "01" is a different district in every state), so
  decoding needs `state+district` concatenated as the lookup key, not the
  bare district code alone — see `district` in `plfs_person.module.js`.
- A survey's own numeric fields can have an undisclosed implied decimal
  scale — PLFS's `mult` (multiplier/weight) is stored as an integer with
  an implied 2-decimal place (confirmed against the real data: raw
  `119669` → true weight `1196.69`; verified via the resulting weighted
  population estimate landing near India's actual population, ~1.19
  billion, only after applying `/100` — without it the estimate would
  have been off by 100x). Don't assume a weight/measure column's face
  value is the real value without checking a known-magnitude sanity check.
- The same conceptual field (e.g. "occupation") can use a different
  official code list per survey, and per digit-length within the same
  survey. PLFS occupation is NCO-2004 (3-digit), not NCO-2015, confirmed
  directly from MoSPI's Schedule 10.4 instruction document — despite NCO-
  2015 being the newer/more commonly surfaced classification in a web
  search. Daily-activity industry fields use 2-digit NIC-2008 while
  `ind_pas`/`ind_sas` use 5-digit — both decode from the same
  `nic2008_decode.json` (bucketed by digit-length string key), just a
  different bucket.
