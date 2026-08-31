# Handover: Data-Viz Suite → Integration with the Company Website

This document is for the developer maintaining the company's existing
static website. It explains what this project is, how it's built, and
exactly what's involved in adding it to the existing site.

## 1. What this is

This repo is a small suite of three standalone, embeddable data tools —
built separately from the company website. Each one is also a complete,
self-contained page (`demo.html`, `trade-explorer.html`,
`financial-analyzer.html`), so on a platform like WordPress the simplest
integration is an `<iframe>` pointed at the hosted page — no theme/plugin
JS conflicts, no code-injection plugin needed. (A `<div>` + `<script>`
embed also exists for sites that can run arbitrary JS inline — see §3.)

| Tool | What it does | Needs a server? |
|---|---|---|
| **ASI/PLFS Microdata Dashboard** | Lets a visitor build their own charts from India's Annual Survey of Industries + Periodic Labour Force Survey microdata — pick dataset, X/Y axes, filters, all populated dynamically. | **Yes** |
| **Financial Analyzer** | Upload Screener.in financial exports for multiple companies; compare them, common-size the statements, chart trends. | **No** — 100% client-side |
| **Trade Explorer** | Chart real UN Comtrade international trade data by country/product; find top trading partners; export tidy CSVs. | **Yes** |

They share no code with each other and don't need to be integrated
together — you can add just one, or all three, independently.

## 2. The key fact for integration: two of these need a backend, one doesn't

Your site is static, so this is the one thing that actually matters for
planning:

- **Financial Analyzer is just files.** It parses uploaded spreadsheets
  entirely in the visitor's browser (via a CDN-loaded library) and never
  talks to a server. You can copy its files straight into your static
  site's asset folder and it works with zero backend.

- **ASI/PLFS Dashboard and Trade Explorer both need the small Node/Express
  server in this repo running somewhere**, because they query data
  (CSV files for ASI/PLFS; a live third-party API + cache for Trade
  Explorer) that can't live in a static site. This backend is already
  built and already has a one-command deploy path to Render (see §4) — it
  doesn't touch your existing site's stack at all. Your static site just
  makes cross-origin requests to it, the same way it might call any other
  third-party API.

Either way, **nothing about your existing static site's architecture
needs to change.** You're not migrating anything — you're adding a few
files and, for two of the three tools, pointing at one extra URL.

## 3. Exactly what to add to your site

### Recommended for WordPress: iframe the hosted pages directly

Once the backend is deployed and on a domain (§4), every tool is a
one-line embed — no JS to add to WordPress at all:

```html
<iframe src="https://tools.fedev.org/demo.html" width="100%" height="900" style="border:0;"></iframe>
<iframe src="https://tools.fedev.org/trade-explorer.html" width="100%" height="900" style="border:0;"></iframe>
<iframe src="https://tools.fedev.org/financial-analyzer.html" width="100%" height="900" style="border:0;"></iframe>
```

Nothing in the server sets `X-Frame-Options` or a `Content-Security-Policy`
that would block framing, so this works as-is. Two things worth knowing:

- **The domain must be HTTPS.** If the WordPress site is served over
  HTTPS (it should be), an iframe pointing at a plain `http://` URL gets
  silently blocked as mixed content — Render issues free TLS
  automatically for both its own subdomain and any custom domain attached
  to it, so this is a non-issue as long as the `https://` URL is used.
- **Height is fixed, not responsive to content** — a plain iframe doesn't
  auto-resize to its contents. `900px` is a reasonable starting guess for
  any of these tools; adjust per page, or add a small `postMessage`-based
  auto-resize script later if the fixed height becomes annoying (not
  currently implemented in this repo).

### Alternative: inline `<div>` + `<script>` (if the site can run arbitrary JS)

### Financial Analyzer (no backend)

Copy these four files from `public/` into your site's assets:
`financial-analyzer.css`, `financial-core.js`, `financial-analyzer.js`,
and pull in Chart.js + SheetJS from a CDN (or self-host them). Then on
whatever page you want it, add:

```html
<div data-financial-analyzer></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<script src="financial-core.js"></script>
<script src="financial-analyzer.js"></script>
```

That's the whole integration. See `public/financial-analyzer.html` for a
working reference page.

### ASI/PLFS Dashboard and Trade Explorer (need the backend deployed first)

Once the backend is deployed somewhere (§4 below gives you a URL, e.g.
`https://asi-plfs-dashboard.onrender.com`), each widget is still just a
`<div>` + `<script>` — the only difference from the Financial Analyzer is
a `data-api-base` attribute telling the widget where its backend lives:

```html
<!-- ASI/PLFS Dashboard -->
<div data-asi-dashboard data-api-base="https://asi-plfs-dashboard.onrender.com"></div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<script src="https://asi-plfs-dashboard.onrender.com/asi-dashboard.js"></script>
```

```html
<!-- Trade Explorer -->
<div data-trade-explorer data-api-base="https://asi-plfs-dashboard.onrender.com"></div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<script src="https://asi-plfs-dashboard.onrender.com/trade-explorer.js"></script>
```

The backend already has permissive CORS enabled (it's designed to be
called from any origin), so this works immediately from your site's
domain with no extra configuration on either side. Live reference pages:
`public/demo.html` and `public/trade-explorer.html`.

## 4. Deploying the backend

Full step-by-step instructions are already written up in
[`DEPLOY.md`](DEPLOY.md) — the short version:

- It deploys to **Render's free tier** — $0/month, one command away via
  the included `render.yaml` blueprint.
- The only real setup step is a one-time data upload: the ASI/PLFS source
  CSVs (~566MB) aren't in this git repo, so they're zipped and put
  somewhere with a direct-download link (e.g. OneDrive); a `prestart`
  script downloads and unpacks them on every cold start.
- **The real tradeoff of free tier:** it spins down after 15 minutes of no
  traffic, so the next visitor after a quiet period waits ~1–3 minutes
  while it wakes up and re-downloads that 566MB dataset (there's no
  persistent disk to keep it around between spin-downs). Trade Explorer's
  shared Comtrade cache resets the same way. This is a reasonable trade
  for $0 if traffic is occasional; if it's not, upgrading to Render's
  Starter plan ($7/month + a $0.25/month disk) removes both the
  spin-down and the repeated re-download, with no code changes — see
  `DEPLOY.md`'s note on this.
- Comtrade API keys are **bring-your-own** — each visitor pastes their own
  free key into the widget's own settings panel (stored only in their
  browser). The server itself never needs a key configured; without one,
  Trade Explorer still works in a read-only "demo mode" showing whatever's
  already cached.

This deploy is independent of your existing site's hosting — it doesn't
need to live on the same server, same host, or even the same cloud
provider.

**Attaching a custom domain** (e.g. `tools.fedev.org`) instead of using
the raw `*.onrender.com` URL is a Render dashboard setting (Settings →
Custom Domain) plus a CNAME record at your DNS provider pointing at the
value Render gives you — Render then issues a free TLS certificate for it
automatically. This isn't required (the `onrender.com` URL already has
HTTPS and works fine in an iframe), but it's cleaner if the WordPress
embed should visibly point at a company-owned domain rather than
Render's.

## 5. Decisions / things to confirm before going live

- **Raw Render URL, or a custom subdomain?** Both work identically for
  iframing (§3) — this is purely a branding/preference call, not a
  technical one.
- **Who owns the data refresh going forward?** The ASI/PLFS CSVs are a
  point-in-time survey dataset — updating them means re-zipping and
  re-uploading per `DEPLOY.md` §1–2. Comtrade data refreshes itself
  automatically (visitors' own queries populate the cache over time).
- **CORS is currently wide open** (any origin can call the API). If
  that's a concern, it can be restricted to just your site's domain — a
  one-line change in `server/index.js`.
- **Where on your site should each tool live?** These were built as
  standalone pages; whether they get their own URLs/nav entries or get
  embedded inside existing pages is entirely up to how your site is
  structured — the embed snippets above work either way.

## 6. Where to go for more detail

This repo is unusually well-documented for its size — worth pointing your
developer at directly rather than re-explaining everything here:

- [`CLAUDE.md`](CLAUDE.md) — full architecture writeup of all three tools,
  including every non-obvious design decision and data quirk encountered
  while building this.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to add a new ASI/PLFS data
  module, if that's ever needed.
- [`DEPLOY.md`](DEPLOY.md) — the deploy walkthrough referenced in §4.
- `public/demo.html`, `public/financial-analyzer.html`,
  `public/trade-explorer.html` — working, minimal reference pages showing
  the exact embed contract for each tool.
