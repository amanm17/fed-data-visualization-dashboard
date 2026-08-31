# Data Visualization Suite

Four independent, embeddable tools, each a single `<div>` + `<script>` drop
onto any host page:

- **ASI/PLFS Microdata Dashboard** — India's Annual Survey of Industries
  (unit-level) and Periodic Labour Force Survey (person-level) microdata.
  Node/Express backend, DuckDB as the query engine (reads CSVs — and, for
  PLFS, a fixed-width text file — directly, no separate DB server), vanilla
  JS + Chart.js frontend.
- **Financial Analyzer** (`public/financial-analyzer.html`) — multi-company
  Screener.in "Data Sheet" exports (.xlsx/.csv), common-sized and compared
  across companies and years. Fully client-side — files never leave the
  browser.
- **Trade Explorer** (`public/trade-explorer.html`) — live UN Comtrade
  trade data: pick reporter/partner countries, HS product codes, and
  import/export flow, then chart real trade data across years. Hybrid
  live-fetch + shared server-side cache, bring-your-own Comtrade API key.

See [CLAUDE.md](CLAUDE.md) for the full architecture of each, and
[CONTRIBUTING.md](CONTRIBUTING.md) for step-by-step checklists to extend
any of them.

## Run it

```
npm install
npm start        # http://localhost:4000
```

Then open any of:
- `http://localhost:4000/demo.html` — ASI/PLFS Microdata Dashboard
- `http://localhost:4000/financial-analyzer.html` — Financial Analyzer
- `http://localhost:4000/trade-explorer.html` — Trade Explorer

Each page proves its own embed contract on an example host page — nothing
in the widget is hardcoded to that page.

There is no test suite, lint config, or build step in this project;
`npm start` plus manual verification (curl the API, drive the demo pages
in a browser) are the feedback loops throughout.

## ASI/PLFS: adding a new dataset

All 10 ASI blocks (A–J) are registered as modules (`server/modules/`), fed
into a combined `unit_summary` dataset that also exposes the 27 official
ASI "Principal Characteristics" (Gross Value Added, Net Profit, Fixed
Capital Formation, etc.) as cross-block derived measures
(`server/derived/`), plus productivity/composition ratio measures (Output
per Worker, Labor Income % of GVA, Women Workforce Share, Employment per
Crore of Fixed Capital) computed as true ratios-of-aggregates rather than
an average of per-unit ratios. PLFS person-level microdata is a second,
unrelated survey registered the same way, as a `standalone: true` module.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how all of this works — adding
a dataset is a single-file addition, no other code changes required.

### Weighting

ASI and PLFS are both sample surveys, not a census. Every chart supports a
**raw** mode (plain sum/avg/count/min/max) and a **weighted** mode using
each unit's own sampling multiplier:

- weighted sum = `sum(value * mult)`
- weighted average = `sum(value * mult) / sum(mult)` (not an average of
  pre-weighted rows)
- weighted count = `sum(mult)`

Toggle it in the UI to compare both.

### Security

Every dataset/dimension/measure/aggregation/filter key from the frontend is
checked against a whitelist built from `server/modules/*.module.js` before
it ever reaches SQL (`server/query/validate.js`). Filter *values* are always
bound as prepared-statement parameters. See `server/query/buildSql.js`. The
Trade Explorer's own request validation (`server/routes/comtrade.js`) works
the same way but is entirely separate — it has no module registry to build
a whitelist from.

## Deployment

See [DEPLOY.md](DEPLOY.md) for deploying to Render with a persistent disk
(needed for the ASI/PLFS source data and the Trade Explorer's shared cache).
