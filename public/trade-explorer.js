// Embeddable "Trade Explorer" widget over UN Comtrade data. Drop one <div
// data-trade-explorer data-api-base="..."></div> plus this script (and its
// dependency, Chart.js) on any page — unlike the Financial Analyzer, this
// one is NOT fully client-side: the backend holds the shared cache and is
// the only thing that ever talks to comtradeapi.un.org. Each visitor's own
// API key(s) live only in this browser's localStorage and are sent with
// every request to our own backend, never anywhere else.
(function () {
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function csvEscape(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // "FED Classic" is the FED deck's own theme colors; the others are
  // derived variations — same four presets (plus a "Custom" mode with real
  // color pickers) as the reference Python tool, ported verbatim.
  const PALETTE_PRESETS = {
    'FED Classic': ['#133E68', '#009F75', '#FEB95F', '#9F4A54', '#7DE2D1', '#0097A7', '#C2C1C2', '#595959'],
    'FED Bold': ['#0A2C4D', '#00B386', '#FF9F1C', '#7A1F2B', '#37CFB5', '#005F73', '#8C8C8C', '#262626'],
    'FED Pastel': ['#6E8FB8', '#5FC9A8', '#FFD08A', '#C98A92', '#B7ECE0', '#5FB8C9', '#D9D9D9', '#8C8C8C'],
    'Monochrome Navy': ['#133E68', '#2C5683', '#46709E', '#608ABA', '#7AA4D6', '#94BEF1', '#0A2640', '#C2C1C2'],
  };
  const DEFAULT_PALETTE = 'FED Classic';
  function colorForIndex(palette, i) { return palette[i % palette.length]; }

  const CHART_TYPES = ['Line', 'Area', 'Bar (Grouped)', 'Bar (Stacked)', 'Pie'];

  const FLOW_LABELS = { X: 'Export', M: 'Import', RX: 'Re-Export', RM: 'Re-Import' };
  // Comtrade's reporter/partner reference file lists only real countries —
  // "World" (partnerCode 0, meaning "aggregate across every partner") is a
  // synthetic value the data API accepts but the reference API never lists,
  // confirmed empirically (searched the live 255-country list for it: zero
  // matches). So it's added here rather than looked up.
  const WORLD_OPTION = { code: '0', label: 'World (all partners combined)' };

  // ---- Client-side-only quota estimate. Comtrade's own 429 is the real
  // enforcement; this just gives the visitor a heads-up before they spend
  // a whole day's quota on one heavy query. Resets at UTC midnight. ----
  const QUOTA_STORAGE_KEY = 'trade_explorer_quota_v1';
  const KEYS_STORAGE_KEY = 'trade_explorer_api_keys_v1';
  const CALLS_PER_KEY_PER_DAY = 500; // Comtrade free registered-tier daily cap

  function todayUtc() { return new Date().toISOString().slice(0, 10); }

  function loadQuotaState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(QUOTA_STORAGE_KEY) || 'null');
      if (parsed && parsed.date === todayUtc()) return parsed;
    } catch (e) { /* ignore */ }
    return { date: todayUtc(), callsUsed: 0 };
  }

  function recordCallsUsed(n) {
    if (!n) return;
    const state = loadQuotaState();
    state.callsUsed += n;
    try { localStorage.setItem(QUOTA_STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function loadKeys() {
    try { return JSON.parse(localStorage.getItem(KEYS_STORAGE_KEY) || '[]'); } catch (e) { return []; }
  }

  function saveKeys(keys) {
    try { localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(keys)); } catch (e) { /* ignore */ }
  }

  function maskKey(key) {
    return key.length <= 8 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`;
  }

  // ---- Reusable "search + checkbox list + selected summary" control used
  // for reporters, partners, and HS codes. ----
  class Picker {
    constructor(container) {
      this.container = container;
      this.searchInput = container.querySelector('.trade-explorer__picker-search');
      this.optionsEl = container.querySelector('.trade-explorer__picker-options');
      this.selectedEl = container.querySelector('.trade-explorer__picker-selected');
      this.selected = new Map(); // code (string) -> label
      this.currentOptions = [];
      this.onChange = () => {};
    }

    setOptions(options) {
      this.currentOptions = options;
      this.renderOptions();
    }

    setSelected(entries) {
      this.selected = new Map(entries.map((e) => [String(e.code), e.label]));
      this.renderOptions();
      this.renderSelected();
      this.onChange(this.selectedCodes());
    }

    renderOptions() {
      if (!this.currentOptions.length) {
        this.optionsEl.innerHTML = '<div class="trade-explorer__picker-selected">No matches</div>';
        return;
      }
      this.optionsEl.innerHTML = this.currentOptions.map((opt) => `
        <label class="trade-explorer__picker-option">
          <input type="checkbox" value="${escapeHtml(opt.code)}" ${this.selected.has(String(opt.code)) ? 'checked' : ''} />
          ${escapeHtml(opt.label)}
        </label>
      `).join('');
      this.optionsEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const opt = this.currentOptions.find((o) => String(o.code) === cb.value);
          if (cb.checked) this.selected.set(cb.value, opt ? opt.label : cb.value);
          else this.selected.delete(cb.value);
          this.renderSelected();
          this.onChange(this.selectedCodes());
        });
      });
    }

    renderSelected() {
      const labels = Array.from(this.selected.values());
      this.selectedEl.textContent = labels.length ? `Selected: ${labels.join(', ')}` : 'None selected';
    }

    selectedCodes() {
      return Array.from(this.selected.keys());
    }

    entries() {
      return Array.from(this.selected, ([code, label]) => ({ code, label }));
    }
  }

  class TradeExplorerWidget {
    constructor(root) {
      this.root = root;
      this.apiBase = root.dataset.apiBase || '';
      this.countries = [];
      this.chart = null;
      this.lastResult = null; // { spec, records }
      this.activePalette = PALETTE_PRESETS[DEFAULT_PALETTE];
      this.chartType = 'Line';
      this.pieYear = null;
      this.singleQtyUnit = null;
      this.render();
      this.init();
    }

    render() {
      this.root.classList.add('trade-explorer');
      const thisYear = new Date().getFullYear();
      // The main year *range* defaults to thisYear-1 as its latest year —
      // fine for a trend chart, where a partial/still-reporting final year
      // just shows up as a visibly lower last point. The discovery panels
      // default further back: confirmed directly against Comtrade that
      // thisYear-1 is too recent for major reporters to have filed yet
      // (e.g. China had zero rows for 2025 as of mid-2026, while ~76
      // smaller/faster-reporting countries already had) — a "top
      // exporters" ranking silently missing the actual biggest exporter is
      // far more misleading than a chart's last point trailing off, so it
      // needs a year more likely to have broad reporting coverage already.
      const discoveryDefaultYear = thisYear - 2;
      const measureGroup = `te-measure-${Math.random().toString(36).slice(2)}`;
      const dpFlowGroup = `te-dp-flow-${Math.random().toString(36).slice(2)}`;
      const drFlowGroup = `te-dr-flow-${Math.random().toString(36).slice(2)}`;
      const customColors = PALETTE_PRESETS[DEFAULT_PALETTE];

      this.root.innerHTML = `
        <div class="trade-explorer__settings" data-role="settings">
          <div class="trade-explorer__settings-header" data-role="settings-toggle">
            <span>🔑 API Keys &amp; Quota</span>
            <span data-role="settings-caret">▸</span>
          </div>
          <div class="trade-explorer__settings-body">
            <p class="trade-explorer__quota-note">
              No key? You can still browse/chart whatever's already cached below.
              A free key from <a href="https://comtradedeveloper.un.org/" target="_blank" rel="noopener">comtradedeveloper.un.org</a>
              lets you fetch new combinations live. Keys are stored only in
              this browser and sent straight to this page's own backend —
              add more than one to combine their daily quotas.
            </p>
            <div class="trade-explorer__key-row">
              <input type="text" data-role="key-input" placeholder="Paste a Comtrade subscription key" />
              <button type="button" class="trade-explorer__btn trade-explorer__btn--secondary" data-role="key-add">Add</button>
            </div>
            <ul class="trade-explorer__key-list" data-role="key-list"></ul>
            <div class="trade-explorer__quota-note" data-role="quota-estimate"></div>
          </div>
        </div>

        <div class="trade-explorer__row">
          <div class="trade-explorer__field">
            <label>Reporter(s)</label>
            <div class="trade-explorer__picker" data-role="picker-reporters">
              <input type="text" class="trade-explorer__picker-search" placeholder="Search countries…" />
              <div class="trade-explorer__picker-options"></div>
              <div class="trade-explorer__picker-selected"></div>
            </div>
          </div>
          <button type="button" class="trade-explorer__swap-btn" data-role="swap-btn" title="Swap reporter and partner">⇄</button>
          <div class="trade-explorer__field">
            <label>Partner(s)</label>
            <div class="trade-explorer__picker" data-role="picker-partners">
              <input type="text" class="trade-explorer__picker-search" placeholder="Search countries…" />
              <div class="trade-explorer__picker-options"></div>
              <div class="trade-explorer__picker-selected"></div>
            </div>
          </div>
        </div>

        <div class="trade-explorer__row">
          <div class="trade-explorer__field" style="flex-basis:100%">
            <label>HS Code(s) / product</label>
            <div class="trade-explorer__picker" data-role="picker-hs">
              <input type="text" class="trade-explorer__picker-search" placeholder="Search by product name or HS code (e.g. \"cotton\" or \"52\")…" />
              <div class="trade-explorer__picker-options"></div>
              <div class="trade-explorer__picker-selected"></div>
            </div>
            <div class="trade-explorer__bulk-paste-toggle" data-role="bulk-toggle">📋 Paste codes in bulk</div>
            <div class="trade-explorer__bulk-paste" data-role="bulk-paste" style="display:none">
              <textarea data-role="bulk-textarea" placeholder="Paste HS codes separated by commas, spaces, or new lines…"></textarea>
              <button type="button" class="trade-explorer__btn trade-explorer__btn--secondary" data-role="bulk-add">Add pasted codes</button>
              <div class="trade-explorer__status" data-role="bulk-status"></div>
            </div>
          </div>
        </div>

        <div class="trade-explorer__row">
          <div class="trade-explorer__field">
            <label>Flow</label>
            <div class="trade-explorer__flow-options" data-role="flow-options">
              <label><input type="checkbox" value="X" checked /> Export</label>
              <label><input type="checkbox" value="M" /> Import</label>
              <label><input type="checkbox" value="RX" /> Re-Export</label>
              <label><input type="checkbox" value="RM" /> Re-Import</label>
            </div>
          </div>
          <div class="trade-explorer__field">
            <label>Years</label>
            <div class="trade-explorer__year-range">
              <input type="number" data-role="year-start" value="${thisYear - 11}" />
              <span>–</span>
              <input type="number" data-role="year-end" value="${thisYear - 1}" />
            </div>
          </div>
        </div>

        <div class="trade-explorer__discovery" data-role="discovery-partners">
          <div class="trade-explorer__discovery-header" data-role="dp-toggle">
            <span>🔎 Find top partners for my reporter</span>
            <span data-role="dp-caret">▸</span>
          </div>
          <div class="trade-explorer__discovery-body">
            <p class="trade-explorer__quota-note">
              Ranks a single year's trade (independent of the year range
              above). Uses the HS code(s) selected above and needs exactly
              one reporter selected and an API key — this is always a live
              fetch, there's no cached fallback for a full breakdown. Recent
              years default further back since major economies sometimes
              take a while to report — if a country you expect is missing,
              try an earlier year.
            </p>
            <div class="trade-explorer__row">
              <div class="trade-explorer__field">
                <label>Flow</label>
                <div class="trade-explorer__flow-options">
                  <label><input type="radio" data-role="dp-flow" name="${dpFlowGroup}" value="X" checked /> Export</label>
                  <label><input type="radio" data-role="dp-flow" name="${dpFlowGroup}" value="M" /> Import</label>
                </div>
              </div>
              <div class="trade-explorer__field">
                <label>Year</label>
                <input type="number" data-role="dp-year" value="${discoveryDefaultYear}" />
              </div>
              <div class="trade-explorer__field">
                <label>Top N</label>
                <input type="number" data-role="dp-topn" value="10" min="1" max="25" />
              </div>
            </div>
            <button type="button" class="trade-explorer__btn trade-explorer__btn--secondary" data-role="dp-run">Find top partners</button>
            <span class="trade-explorer__status" data-role="dp-status"></span>
            <div data-role="dp-results"></div>
          </div>
        </div>

        <div class="trade-explorer__discovery" data-role="discovery-reporters">
          <div class="trade-explorer__discovery-header" data-role="dr-toggle">
            <span>🌍 Top exporters/importers of this product</span>
            <span data-role="dr-caret">▸</span>
          </div>
          <div class="trade-explorer__discovery-body">
            <p class="trade-explorer__quota-note">
              Ranks a single year's trade (independent of the year range
              above). Uses the HS code(s) selected above and ranks every
              reporting country in one call — needs an API key, no cached
              fallback. Recent years default further back since major
              economies sometimes take a while to report (confirmed: one
              major economy had zero rows for last year while dozens of
              smaller/faster reporters already did) — if a country you
              expect is missing or the ranking looks off, try an earlier
              year.
            </p>
            <div class="trade-explorer__row">
              <div class="trade-explorer__field">
                <label>Rank by</label>
                <div class="trade-explorer__flow-options">
                  <label><input type="radio" data-role="dr-flow" name="${drFlowGroup}" value="X" checked /> Top Exporters</label>
                  <label><input type="radio" data-role="dr-flow" name="${drFlowGroup}" value="M" /> Top Importers</label>
                </div>
              </div>
              <div class="trade-explorer__field">
                <label>Year</label>
                <input type="number" data-role="dr-year" value="${discoveryDefaultYear}" />
              </div>
              <div class="trade-explorer__field">
                <label>Top N</label>
                <input type="number" data-role="dr-topn" value="10" min="1" max="25" />
              </div>
            </div>
            <button type="button" class="trade-explorer__btn trade-explorer__btn--secondary" data-role="dr-run">Find top countries</button>
            <span class="trade-explorer__status" data-role="dr-status"></span>
            <div data-role="dr-results"></div>
          </div>
        </div>

        <div class="trade-explorer__actions">
          <button type="button" class="trade-explorer__btn" data-role="fetch-btn">Fetch &amp; chart</button>
          <button type="button" class="trade-explorer__btn trade-explorer__btn--secondary" data-role="reset-btn">Reset</button>
          <span class="trade-explorer__status" data-role="status"></span>
        </div>

        <div data-role="banners"></div>

        <div data-role="results" style="display:none">
          <div class="trade-explorer__measure-row">
            <label><input type="radio" name="${measureGroup}" data-role="measure-value" value="value" checked /> Trade Value (USD)</label>
            <label><input type="radio" name="${measureGroup}" data-role="measure-qty" value="qty" /> Net weight / quantity</label>
            <label><input type="radio" name="${measureGroup}" data-role="measure-unitprice" value="unitPrice" /> Unit Price (USD per unit)</label>
          </div>
          <p class="trade-explorer__quota-note" data-role="qty-unit-note" style="display:none"></p>
          <div class="trade-explorer__measure-row" data-role="share-toggle-wrap" style="display:none">
            <label><input type="checkbox" data-role="share-toggle" /> Show as % of World total (with Rest of World)</label>
          </div>
          <div class="trade-explorer__chart-controls-row">
            <label>Chart type
              <select data-role="chart-type">
                ${CHART_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}
              </select>
            </label>
            <label data-role="pie-year-wrap" style="display:none">Year (Pie snapshot)
              <select data-role="pie-year"></select>
            </label>
            <label>🎨 Color theme
              <select data-role="palette-select">
                ${Object.keys(PALETTE_PRESETS).map((n) => `<option value="${n}">${n}</option>`).join('')}
                <option value="Custom">Custom</option>
              </select>
            </label>
          </div>
          <div class="trade-explorer__custom-palette-row" data-role="custom-palette-row" style="display:none">
            ${[0, 1, 2, 3].map((i) => `<input type="color" data-role="custom-color-${i}" value="${customColors[i]}" />`).join('')}
          </div>
          <div class="trade-explorer__export-row">
            <button type="button" data-role="export-csv">Download CSV</button>
            <button type="button" data-role="export-png">Download PNG</button>
          </div>
          <div class="trade-explorer__chart-wrap">
            <canvas data-role="canvas"></canvas>
          </div>
        </div>
      `;

      const q = (role) => this.root.querySelector(`[data-role="${role}"]`);
      this.el = {
        settings: q('settings'),
        settingsToggle: q('settings-toggle'),
        keyInput: q('key-input'),
        keyAdd: q('key-add'),
        keyList: q('key-list'),
        quotaEstimate: q('quota-estimate'),
        swapBtn: q('swap-btn'),
        bulkToggle: q('bulk-toggle'),
        bulkPaste: q('bulk-paste'),
        bulkTextarea: q('bulk-textarea'),
        bulkAdd: q('bulk-add'),
        bulkStatus: q('bulk-status'),
        flowOptions: q('flow-options'),
        yearStart: q('year-start'),
        yearEnd: q('year-end'),
        discoveryPartners: q('discovery-partners'),
        dpToggle: q('dp-toggle'),
        dpYear: q('dp-year'),
        dpTopN: q('dp-topn'),
        dpRun: q('dp-run'),
        dpStatus: q('dp-status'),
        dpResults: q('dp-results'),
        discoveryReporters: q('discovery-reporters'),
        drToggle: q('dr-toggle'),
        drYear: q('dr-year'),
        drTopN: q('dr-topn'),
        drRun: q('dr-run'),
        drStatus: q('dr-status'),
        drResults: q('dr-results'),
        fetchBtn: q('fetch-btn'),
        resetBtn: q('reset-btn'),
        status: q('status'),
        banners: q('banners'),
        results: q('results'),
        measureValue: q('measure-value'),
        measureQty: q('measure-qty'),
        measureUnitPrice: q('measure-unitprice'),
        qtyUnitNote: q('qty-unit-note'),
        shareToggleWrap: q('share-toggle-wrap'),
        shareToggle: q('share-toggle'),
        chartTypeSelect: q('chart-type'),
        pieYearWrap: q('pie-year-wrap'),
        pieYearSelect: q('pie-year'),
        paletteSelect: q('palette-select'),
        customPaletteRow: q('custom-palette-row'),
        customColorInputs: Array.from(this.root.querySelectorAll('[data-role^="custom-color-"]')),
        exportCsv: q('export-csv'),
        exportPng: q('export-png'),
        canvas: q('canvas'),
      };

      this.reporterPicker = new Picker(this.root.querySelector('[data-role="picker-reporters"]'));
      this.partnerPicker = new Picker(this.root.querySelector('[data-role="picker-partners"]'));
      this.hsPicker = new Picker(this.root.querySelector('[data-role="picker-hs"]'));
    }

    async init() {
      this.wireSettings();
      this.wireQueryBuilder();
      this.wireBulkPaste();
      this.wireDiscoveryPanels();
      this.wireMiscButtons();
      this.wireChartControls();
      this.wirePalette();
      this.el.fetchBtn.addEventListener('click', () => this.onFetchClick());
      this.el.measureValue.addEventListener('change', () => this.redrawChart());
      this.el.measureQty.addEventListener('change', () => this.redrawChart());
      this.el.measureUnitPrice.addEventListener('change', () => this.redrawChart());
      this.el.shareToggle.addEventListener('change', () => this.redrawChart());
      this.el.exportCsv.addEventListener('click', () => this.downloadCSV());
      this.el.exportPng.addEventListener('click', () => this.downloadPNG());

      this.renderKeyList();
      this.updateQuotaEstimate();

      this.setStatus('Loading country list…');
      try {
        const res = await fetch(`${this.apiBase}/api/comtrade/reference/countries`);
        const body = await res.json();
        this.countries = body.countries || [];
        const options = this.countries.map((c) => ({ code: c.code, label: c.name }));
        this.reporterPicker.setOptions(options);
        this.partnerPicker.setOptions([WORLD_OPTION, ...options]);
        this.partnerPicker.setSelected([WORLD_OPTION]);
        this.setStatus('');
      } catch (e) {
        this.setStatus('');
        this.showBanner(`Could not load the country list: ${e.message}`, 'error');
      }
    }

    wireSettings() {
      this.el.settingsToggle.addEventListener('click', () => {
        this.el.settings.classList.toggle('is-open');
      });
      this.el.keyAdd.addEventListener('click', () => {
        const value = this.el.keyInput.value.trim();
        if (!value) return;
        const keys = loadKeys();
        if (!keys.includes(value)) {
          keys.push(value);
          saveKeys(keys);
          this.renderKeyList();
          this.updateQuotaEstimate();
        }
        this.el.keyInput.value = '';
      });
    }

    renderKeyList() {
      const keys = loadKeys();
      this.el.keyList.innerHTML = keys.map((k, i) => `
        <li>${escapeHtml(maskKey(k))} <button type="button" data-idx="${i}">Remove</button></li>
      `).join('') || '<li>No keys added — browsing cached data only (demo mode).</li>';
      this.el.keyList.querySelectorAll('button[data-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const keys = loadKeys();
          keys.splice(Number(btn.dataset.idx), 1);
          saveKeys(keys);
          this.renderKeyList();
          this.updateQuotaEstimate();
        });
      });
    }

    updateQuotaEstimate() {
      const keys = loadKeys();
      const quota = loadQuotaState();
      const capacity = keys.length * CALLS_PER_KEY_PER_DAY;
      const remaining = Math.max(0, capacity - quota.callsUsed);
      this.el.quotaEstimate.textContent = keys.length
        ? `Estimated remaining quota today: ~${remaining} call(s) across ${keys.length} key(s). (Estimate only — Comtrade doesn't report real remaining quota; the actual limit is enforced by Comtrade itself.)`
        : '';
    }

    wireQueryBuilder() {
      const wireCountryPicker = (picker, extraOptions) => {
        picker.searchInput.addEventListener('input', () => {
          const q = picker.searchInput.value.trim().toLowerCase();
          const filtered = !q
            ? this.countries.slice(0, 50)
            : this.countries.filter((c) => c.name.toLowerCase().includes(q) || c.iso3.toLowerCase() === q);
          const options = filtered.slice(0, 50).map((c) => ({ code: c.code, label: c.name }));
          const extras = (extraOptions || []).filter((o) => !q || o.label.toLowerCase().includes(q));
          picker.setOptions([...extras, ...options]);
        });
      };
      wireCountryPicker(this.reporterPicker);
      wireCountryPicker(this.partnerPicker, [WORLD_OPTION]);

      let hsDebounce = null;
      this.hsPicker.searchInput.addEventListener('input', () => {
        clearTimeout(hsDebounce);
        hsDebounce = setTimeout(async () => {
          const q = this.hsPicker.searchInput.value.trim();
          try {
            const res = await fetch(`${this.apiBase}/api/comtrade/reference/hs?search=${encodeURIComponent(q)}`);
            const body = await res.json();
            this.hsPicker.setOptions((body.codes || []).map((c) => ({ code: c.code, label: c.description })));
          } catch (e) {
            // Search failures are non-fatal — leave the previous results showing.
          }
        }, 300);
      });
    }

    wireBulkPaste() {
      this.el.bulkToggle.addEventListener('click', () => {
        const hidden = this.el.bulkPaste.style.display === 'none';
        this.el.bulkPaste.style.display = hidden ? '' : 'none';
      });
      this.el.bulkAdd.addEventListener('click', async () => {
        const codes = this.el.bulkTextarea.value.split(/[\s,]+/).filter(Boolean);
        if (!codes.length) return;
        this.el.bulkStatus.textContent = 'Looking up…';
        try {
          const res = await fetch(`${this.apiBase}/api/comtrade/reference/hs/lookup?codes=${encodeURIComponent(codes.join(','))}`);
          const body = await res.json();
          const existing = this.hsPicker.entries();
          const existingCodes = new Set(existing.map((e) => String(e.code)));
          const additions = (body.codes || [])
            .filter((c) => !existingCodes.has(String(c.code)))
            .map((c) => ({ code: c.code, label: c.description }));
          this.hsPicker.setSelected([...existing, ...additions]);
          this.el.bulkStatus.textContent = `Matched ${body.matched} of ${body.requested} pasted code(s).`;
          this.el.bulkTextarea.value = '';
        } catch (e) {
          this.el.bulkStatus.textContent = `Lookup failed: ${e.message}`;
        }
      });
    }

    wireMiscButtons() {
      this.el.swapBtn.addEventListener('click', () => {
        const reporterHasWorld = this.reporterPicker.selectedCodes().includes('0');
        const partnerHasWorld = this.partnerPicker.selectedCodes().includes('0');
        if (reporterHasWorld || partnerHasWorld) {
          this.showBanner('Can\'t swap while "World" is selected as a reporter or partner — a country can\'t report as "World."', 'error');
          return;
        }
        const reporterEntries = this.reporterPicker.entries();
        const partnerEntries = this.partnerPicker.entries();
        this.reporterPicker.setSelected(partnerEntries);
        this.partnerPicker.setSelected(reporterEntries.length ? reporterEntries : [WORLD_OPTION]);
      });

      this.el.resetBtn.addEventListener('click', () => {
        this.reporterPicker.setSelected([]);
        this.partnerPicker.setSelected([WORLD_OPTION]);
        this.hsPicker.setSelected([]);
        this.root.querySelectorAll('[data-role="flow-options"] input[type="checkbox"]').forEach((cb) => {
          cb.checked = cb.value === 'X';
        });
        const thisYear = new Date().getFullYear();
        this.el.yearStart.value = thisYear - 11;
        this.el.yearEnd.value = thisYear - 1;
        this.clearBanners();
        this.el.results.style.display = 'none';
        this.lastResult = null;
        if (this.chart) { this.chart.destroy(); this.chart = null; }
      });
    }

    wireChartControls() {
      this.el.chartTypeSelect.addEventListener('change', () => {
        this.chartType = this.el.chartTypeSelect.value;
        this.el.pieYearWrap.style.display = this.chartType === 'Pie' ? '' : 'none';
        this.redrawChart();
      });
      this.el.pieYearSelect.addEventListener('change', () => {
        this.pieYear = Number(this.el.pieYearSelect.value) || null;
        this.redrawChart();
      });
    }

    wirePalette() {
      this.el.paletteSelect.addEventListener('change', () => this.applyPaletteChoice());
      this.el.customColorInputs.forEach((input) => {
        input.addEventListener('input', () => {
          if (this.el.paletteSelect.value === 'Custom') this.applyPaletteChoice();
        });
      });
    }

    applyPaletteChoice() {
      const choice = this.el.paletteSelect.value;
      this.el.customPaletteRow.style.display = choice === 'Custom' ? '' : 'none';
      this.activePalette = choice === 'Custom' ? this.customPaletteColors() : PALETTE_PRESETS[choice];
      this.redrawChart();
    }

    customPaletteColors() {
      const custom = this.el.customColorInputs.map((input) => input.value);
      const base = PALETTE_PRESETS[DEFAULT_PALETTE];
      return [...custom, ...base.slice(custom.length)];
    }

    wireDiscoveryPanels() {
      this.el.dpToggle.addEventListener('click', () => this.el.discoveryPartners.classList.toggle('is-open'));
      this.el.drToggle.addEventListener('click', () => this.el.discoveryReporters.classList.toggle('is-open'));
      this.el.dpRun.addEventListener('click', () => this.runDiscovery('partners'));
      this.el.drRun.addEventListener('click', () => this.runDiscovery('reporters'));
    }

    countryName(code) {
      const c = this.countries.find((c) => String(c.code) === String(code));
      return c ? c.name : String(code);
    }

    async runDiscovery(kind) {
      const isPartners = kind === 'partners';
      const statusEl = isPartners ? this.el.dpStatus : this.el.drStatus;
      const resultsEl = isPartners ? this.el.dpResults : this.el.drResults;
      const topN = Number((isPartners ? this.el.dpTopN : this.el.drTopN).value) || 10;
      const year = Number((isPartners ? this.el.dpYear : this.el.drYear).value);
      const flowInput = this.root.querySelector(
        isPartners ? 'input[data-role="dp-flow"]:checked' : 'input[data-role="dr-flow"]:checked'
      );
      const flowCode = flowInput ? flowInput.value : 'X';

      const hsCodes = this.hsPicker.selectedCodes();
      const apiKeys = loadKeys();

      resultsEl.innerHTML = '';
      statusEl.textContent = '';
      if (!hsCodes.length) { statusEl.textContent = 'Pick at least one HS code above first.'; return; }
      if (!year) { statusEl.textContent = 'Enter a valid year above first.'; return; }
      if (!apiKeys.length) { statusEl.textContent = 'Add an API key above first — discovery always needs a live fetch.'; return; }

      let anchorRole;
      let anchorCode;
      if (isPartners) {
        const reporters = this.reporterPicker.selectedCodes();
        if (reporters.length !== 1) { statusEl.textContent = 'Select exactly one reporter above first.'; return; }
        anchorRole = 'reporter';
        anchorCode = Number(reporters[0]);
      } else {
        anchorRole = 'partner';
        anchorCode = 0; // World — rank every reporter's total trade
      }

      statusEl.textContent = 'Fetching…';
      try {
        const result = await this.apiPost('/api/comtrade/breakdown', {
          anchorRole, anchorCode, flowCode, hsCodes, years: [year], topN, apiKeys,
        });
        recordCallsUsed(result.callsMade);
        this.updateQuotaEstimate();
        statusEl.textContent = (result.errors && result.errors.length)
          ? `Done, with ${result.errors.length} fetch error(s) along the way.`
          : `Done (${result.callsMade} API call(s) used).`;
        this.renderDiscoveryResults(
          resultsEl, result.ranking, result.totalCountriesFound, year,
          isPartners ? this.partnerPicker : this.reporterPicker,
          isPartners ? 'partner' : 'reporter'
        );
      } catch (e) {
        statusEl.textContent = '';
        resultsEl.innerHTML = `<div class="trade-explorer__banner trade-explorer__banner--error">${escapeHtml(e.message)}</div>`;
      }
    }

    renderDiscoveryResults(container, ranking, totalCountriesFound, year, targetPicker, roleLabel) {
      if (!ranking.length) {
        container.innerHTML = '<div class="trade-explorer__quota-note">No data returned for this combination.</div>';
        return;
      }
      const rows = ranking.map((r) => `
        <tr>
          <td>${r.rank}</td>
          <td>${escapeHtml(this.countryName(r.code))}</td>
          <td>$${Math.round(r.value).toLocaleString()}</td>
          <td>${r.sharePct.toFixed(1)}%</td>
        </tr>
      `).join('');
      container.innerHTML = `
        <p class="trade-explorer__quota-note">
          ${totalCountriesFound} countr${totalCountriesFound === 1 ? 'y has' : 'ies have'} reported data for
          ${year} so far — if a country you expect isn't in this list (or in the top ranks), Comtrade
          likely doesn't have its ${year} figures yet; try an earlier year.
        </p>
        <table class="trade-explorer__discovery-table">
          <thead><tr><th>#</th><th>Country</th><th>Trade Value (USD), ${year}</th><th>Share</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <button type="button" class="trade-explorer__btn trade-explorer__btn--secondary" data-role="add-discovery">
          Add these ${ranking.length} to ${roleLabel} selection
        </button>
      `;
      container.querySelector('[data-role="add-discovery"]').addEventListener('click', () => {
        const existing = targetPicker.entries();
        const existingCodes = new Set(existing.map((e) => String(e.code)));
        const additions = ranking
          .filter((r) => !existingCodes.has(String(r.code)))
          .map((r) => ({ code: r.code, label: this.countryName(r.code) }));
        targetPicker.setSelected([...existing, ...additions]);
      });
    }

    setStatus(text) { this.el.status.textContent = text; }

    showBanner(text, kind) {
      const div = document.createElement('div');
      div.className = `trade-explorer__banner trade-explorer__banner--${kind}`;
      div.textContent = text;
      this.el.banners.appendChild(div);
    }

    clearBanners() { this.el.banners.innerHTML = ''; }

    buildQuerySpec() {
      return {
        reporters: this.reporterPicker.selectedCodes().map(Number),
        partners: this.partnerPicker.selectedCodes().map(Number),
        hsCodes: this.hsPicker.selectedCodes(),
        flows: Array.from(this.el.flowOptions.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value),
        years: { start: Number(this.el.yearStart.value), end: Number(this.el.yearEnd.value) },
      };
    }

    validateSpec(spec) {
      const errors = [];
      if (!spec.reporters.length) errors.push('Pick at least one reporter.');
      if (!spec.hsCodes.length) errors.push('Pick at least one HS code.');
      if (!spec.flows.length) errors.push('Pick at least one flow.');
      if (!spec.years.start || !spec.years.end || spec.years.start > spec.years.end) {
        errors.push('Enter a valid year range.');
      }
      return errors;
    }

    async apiPost(path, body) {
      const res = await fetch(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json.errors && json.errors.join(' ')) || json.error || `HTTP ${res.status}`);
      return json;
    }

    async onFetchClick() {
      const spec = this.buildQuerySpec();
      const errors = this.validateSpec(spec);
      this.clearBanners();
      if (errors.length) {
        this.showBanner(errors.join(' '), 'error');
        return;
      }

      const apiKeys = loadKeys();
      this.el.fetchBtn.disabled = true;

      if (apiKeys.length) {
        this.setStatus('Estimating cost…');
        try {
          const preview = await this.apiPost('/api/comtrade/preview', spec);
          if (preview.callsNeeded > 0) {
            const quota = loadQuotaState();
            const capacity = apiKeys.length * CALLS_PER_KEY_PER_DAY;
            const estRemaining = Math.max(0, capacity - quota.callsUsed);
            if (preview.callsNeeded > estRemaining) {
              const proceed = window.confirm(
                `This needs an estimated ${preview.callsNeeded} new API call(s), but your `
                + `${apiKeys.length} key(s) have roughly ${estRemaining} left today (estimate only — `
                + `not enforced by us). Continue anyway?`
              );
              if (!proceed) {
                this.setStatus('');
                this.el.fetchBtn.disabled = false;
                return;
              }
            }
          }
        } catch (e) {
          // A failed preview shouldn't block the real query — just skip the estimate.
        }
      }

      this.setStatus('Fetching…');
      try {
        const result = await this.apiPost('/api/comtrade/query', { ...spec, apiKeys });
        recordCallsUsed(result.meta.apiCallsMade);
        this.updateQuotaEstimate();
        this.renderResult(spec, result);
      } catch (e) {
        this.showBanner(`Request failed: ${e.message}`, 'error');
      } finally {
        this.setStatus('');
        this.el.fetchBtn.disabled = false;
      }
    }

    renderResult(spec, result) {
      const { records, meta } = result;
      this.lastResult = { spec, records };

      if (meta.triplesUnavailable && meta.triplesUnavailable.length) {
        const lines = meta.triplesUnavailable.map(({ key, reason }) => {
          const [reporterCode, partnerCode, flowCode] = key.split('|');
          const reporterName = this.reporterPicker.selected.get(reporterCode) || reporterCode;
          const partnerName = this.partnerPicker.selected.get(partnerCode) || partnerCode;
          return `${reporterName} → ${partnerName} (${FLOW_LABELS[flowCode] || flowCode}): ${reason}`;
        });
        this.showBanner(
          `${meta.triplesUnavailable.length} combination(s) couldn't be fetched:\n${lines.join('\n')}`,
          'warn'
        );
      }

      if (!records.length) {
        this.el.results.style.display = 'none';
        this.showBanner('No data available for this combination yet.', 'warn');
        return;
      }

      // Comtrade sometimes reports the very same reporter/partner/flow/HS
      // combination in different units across different years (confirmed
      // against real cached data: some series report "kg" some years and
      // "u" others for the same product) — genuinely different real units,
      // not the "N/A" placeholder bug fixed elsewhere. Disabling Quantity/
      // Unit Price outright on ANY variance was too blunt: it blocked the
      // whole feature even when the vast majority of points shared one
      // unit. Instead, pick the most-common real unit and treat any row
      // reporting a different one as a gap (like a missing year already
      // is) — buildChartData() enforces this same rule when computing
      // per-cell values. Only disable outright when there's no usable
      // quantity data at all.
      const qtyUnitCounts = new Map();
      for (const r of records) {
        if (r.qty == null || !r.qty_unit) continue;
        qtyUnitCounts.set(r.qty_unit, (qtyUnitCounts.get(r.qty_unit) || 0) + 1);
      }
      let dominantUnit = null;
      let dominantCount = 0;
      for (const [unit, count] of qtyUnitCounts) {
        if (count > dominantCount) { dominantUnit = unit; dominantCount = count; }
      }
      this.singleQtyUnit = dominantUnit;
      const disableQtyBased = dominantUnit === null;
      const tip = disableQtyBased
        ? 'No quantity data reported for this selection — only Trade Value is available.'
        : qtyUnitCounts.size > 1
          ? `This selection reports quantity in more than one unit (${Array.from(qtyUnitCounts.keys()).join(', ')}) — showing only the ${dominantUnit} data points; the rest are gaps.`
          : '';
      this.el.measureQty.disabled = disableQtyBased;
      this.el.measureQty.title = tip;
      this.el.measureUnitPrice.disabled = disableQtyBased;
      this.el.measureUnitPrice.title = tip;
      // A hover-only tooltip is easy to miss when a control just looks
      // greyed out for no visible reason — show the same explanation
      // on-screen too, whenever there's actually something to explain.
      this.el.qtyUnitNote.textContent = tip;
      this.el.qtyUnitNote.style.display = tip ? '' : 'none';
      if (disableQtyBased && (this.el.measureQty.checked || this.el.measureUnitPrice.checked)) {
        this.el.measureValue.checked = true;
      }

      const years = Array.from(new Set(records.map((r) => r.year))).sort((a, b) => a - b);
      this.populatePieYearOptions(years);
      this.updateShareToggleVisibility();

      this.el.results.style.display = '';
      this.redrawChart();
    }

    populatePieYearOptions(years) {
      this.el.pieYearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
      this.pieYear = years.length ? years[years.length - 1] : null;
      if (this.pieYear !== null) this.el.pieYearSelect.value = String(this.pieYear);
    }

    shareToggleApplicable() {
      if (!this.lastResult) return false;
      const { spec } = this.lastResult;
      const hasWorld = spec.partners.some((p) => Number(p) === 0);
      const hasOtherPartner = spec.partners.some((p) => Number(p) !== 0);
      return hasWorld && hasOtherPartner
        && spec.reporters.length === 1 && spec.flows.length === 1 && spec.hsCodes.length === 1;
    }

    updateShareToggleVisibility() {
      const applicable = this.shareToggleApplicable();
      this.el.shareToggleWrap.style.display = applicable ? '' : 'none';
      if (!applicable) this.el.shareToggle.checked = false;
    }

    currentMeasure() {
      if (this.el.measureUnitPrice.checked) return 'unitPrice';
      if (this.el.measureQty.checked) return 'qty';
      return 'value';
    }

    pieYearIndex(years) {
      if (this.pieYear !== null && years.includes(this.pieYear)) return years.indexOf(this.pieYear);
      return years.length - 1;
    }

    buildChartData() {
      const { spec, records } = this.lastResult;
      const measure = this.currentMeasure();
      const years = Array.from(new Set(records.map((r) => r.year))).sort((a, b) => a - b);

      const seriesList = [];
      const seriesIndex = new Map();
      for (const r of records) {
        const key = `${r.reporter_code}|${r.partner_code}|${r.flow_code}|${r.hs_code}`;
        let s = seriesIndex.get(key);
        if (!s) {
          s = {
            reporter_code: r.reporter_code, partner_code: r.partner_code,
            flow_code: r.flow_code, hs_code: r.hs_code, valuesByYear: new Map(),
          };
          seriesIndex.set(key, s);
          seriesList.push(s);
        }
        // A row reporting quantity in a different unit than the selection's
        // dominant one (see renderResult) is treated as a gap for qty/
        // unitPrice — same principle as a missing year — rather than
        // silently mixing e.g. kg and item counts into one series.
        const unitMismatch = (measure === 'qty' || measure === 'unitPrice')
          && this.singleQtyUnit && r.qty_unit && r.qty_unit !== this.singleQtyUnit;
        const val = unitMismatch ? null
          : measure === 'qty' ? r.qty
          : measure === 'unitPrice' ? (r.qty && r.qty > 0 ? r.trade_value_usd / r.qty : null)
          : r.trade_value_usd;
        s.valuesByYear.set(r.year, val);
      }
      for (const s of seriesList) {
        s.values = years.map((y) => (s.valuesByYear.has(y) ? s.valuesByYear.get(y) : null));
      }

      const varying = {
        reporter: spec.reporters.length > 1,
        partner: spec.partners.length > 1,
        flow: spec.flows.length > 1,
        hs: spec.hsCodes.length > 1,
      };
      const anyVarying = Object.values(varying).some(Boolean);
      const labelFor = (s) => {
        const parts = [];
        if (!anyVarying || varying.reporter) {
          parts.push(this.reporterPicker.selected.get(String(s.reporter_code)) || s.reporter_code);
        }
        if (!anyVarying || varying.partner) {
          parts.push(this.partnerPicker.selected.get(String(s.partner_code)) || s.partner_code);
        }
        if (!anyVarying || varying.flow) parts.push(FLOW_LABELS[s.flow_code] || s.flow_code);
        if (!anyVarying || varying.hs) {
          parts.push(this.hsPicker.selected.get(String(s.hs_code)) || s.hs_code);
        }
        return parts.join(' · ');
      };

      let finalList = seriesList.map((s) => ({ ...s, label: labelFor(s) }));
      let unitLabel;
      const sharePctActive = measure === 'value' && this.el.shareToggle.checked && this.shareToggleApplicable();

      if (sharePctActive) {
        const worldSeries = seriesList.find((s) => Number(s.partner_code) === 0);
        const otherSeries = seriesList.filter((s) => Number(s.partner_code) !== 0);
        const transformed = otherSeries.map((s) => ({ label: labelFor(s), values: new Array(years.length).fill(null) }));
        const restOfWorld = { label: 'Rest of World', values: new Array(years.length).fill(null) };

        years.forEach((y, i) => {
          const worldVal = (worldSeries && worldSeries.values[i]) || 0;
          let sumOthers = 0;
          otherSeries.forEach((s, si) => {
            const raw = s.values[i] || 0;
            sumOthers += raw;
            transformed[si].values[i] = worldVal > 0 ? (raw / worldVal) * 100 : null;
          });
          const rest = Math.max(0, worldVal - sumOthers);
          restOfWorld.values[i] = worldVal > 0 ? (rest / worldVal) * 100 : null;
        });

        finalList = [...transformed, restOfWorld];
        unitLabel = '% of total trade';
      } else if (measure === 'qty') {
        unitLabel = this.singleQtyUnit ? `Quantity (${this.singleQtyUnit})` : 'Quantity';
      } else if (measure === 'unitPrice') {
        unitLabel = this.singleQtyUnit ? `USD per ${this.singleQtyUnit}` : 'USD per unit';
      } else {
        unitLabel = 'Trade Value (USD)';
      }

      const datasets = finalList.map((s, i) => {
        const color = colorForIndex(this.activePalette, i);
        return {
          label: s.label,
          data: s.values,
          borderColor: color,
          backgroundColor: color,
          spanGaps: true,
          tension: 0.15,
        };
      });

      return { years, datasets, measure, unitLabel };
    }

    redrawChart() {
      if (!this.lastResult) return;
      const { years, datasets, unitLabel } = this.buildChartData();
      if (this.chart) this.chart.destroy();

      if (this.chartType === 'Pie') {
        const yearIdx = this.pieYearIndex(years);
        const labels = datasets.map((d) => d.label);
        const data = datasets.map((d) => d.data[yearIdx] ?? 0);
        const colors = labels.map((_, i) => colorForIndex(this.activePalette, i));
        this.chart = new Chart(this.el.canvas.getContext('2d'), {
          type: 'pie',
          data: { labels, datasets: [{ data, backgroundColor: colors }] },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom' },
              title: { display: true, text: `Year: ${years[yearIdx] ?? ''}` },
            },
          },
        });
        return;
      }

      const isBar = this.chartType.startsWith('Bar');
      const isStacked = this.chartType === 'Bar (Stacked)';
      const isArea = this.chartType === 'Area';
      const chartDatasets = datasets.map((d) => ({
        ...d,
        fill: isArea,
        backgroundColor: isArea ? `${d.borderColor}33` : d.backgroundColor,
      }));

      this.chart = new Chart(this.el.canvas.getContext('2d'), {
        type: isBar ? 'bar' : 'line',
        data: { labels: years, datasets: chartDatasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { stacked: isStacked, title: { display: true, text: unitLabel } },
            x: { stacked: isStacked, title: { display: true, text: 'Year' } },
          },
          plugins: { legend: { position: 'bottom' } },
        },
      });
    }

    downloadCSV() {
      if (!this.lastResult) return;
      const { records } = this.lastResult;

      // A tidy/long table (one row per reporter/partner/flow/HS/year cell,
      // every field its own column) sorts and pivots in a spreadsheet the
      // way the wide, one-column-per-series export never could — the wide
      // form baked "Reporter · Partner · Flow · HS" into a single label
      // string per column header, which is exactly what a user wanting to
      // sort by e.g. HS code alone can't work with. Exported independent of
      // the on-screen measure/share-of-world toggles, since it already
      // carries both value and quantity per row and those toggles are just
      // chart-side views of this same data.
      const rows = records
        .map((r) => ({
          reporterCode: String(r.reporter_code),
          partnerCode: String(r.partner_code),
          flowCode: r.flow_code,
          hsCode: String(r.hs_code),
          year: r.year,
          tradeValueUsd: r.trade_value_usd,
          qty: r.qty,
          qtyUnit: r.qty_unit || '',
          unitPrice: r.qty && r.qty > 0 ? r.trade_value_usd / r.qty : '',
          netWgtKg: r.net_wgt_kg,
        }))
        .sort((a, b) => (
          a.reporterCode.localeCompare(b.reporterCode)
          || a.partnerCode.localeCompare(b.partnerCode)
          || a.flowCode.localeCompare(b.flowCode)
          || a.hsCode.localeCompare(b.hsCode)
          || a.year - b.year
        ));

      const header = [
        'Reporter Code', 'Reporter', 'Partner Code', 'Partner', 'Flow',
        'HS Code', 'HS Description', 'Year', 'Trade Value (USD)',
        'Quantity', 'Quantity Unit', 'Net Weight (kg)', 'Unit Price (USD/unit)',
      ];
      const csvRows = [header, ...rows.map((r) => [
        r.reporterCode,
        this.reporterPicker.selected.get(r.reporterCode) || r.reporterCode,
        r.partnerCode,
        this.partnerPicker.selected.get(r.partnerCode) || r.partnerCode,
        FLOW_LABELS[r.flowCode] || r.flowCode,
        r.hsCode,
        this.hsPicker.selected.get(r.hsCode) || '',
        r.year,
        r.tradeValueUsd,
        r.qty === null || r.qty === undefined ? '' : r.qty,
        r.qtyUnit,
        // Net weight in kg is a separate field from Quantity/Quantity Unit
        // above — Comtrade reports it for virtually every commodity
        // regardless of what unit Quantity happens to be in (confirmed: HS
        // 610230 came back with qty in "u" *and* a real netWgt in the same
        // row) — so it's included as its own standard-unit column rather
        // than only ever having one figure or the other.
        r.netWgtKg === null || r.netWgtKg === undefined ? '' : r.netWgtKg,
        r.unitPrice === '' ? '' : r.unitPrice.toFixed(2),
      ])];

      const csvText = csvRows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `trade-explorer-${Date.now()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    downloadPNG() {
      if (!this.chart) return;
      const link = document.createElement('a');
      link.href = this.chart.toBase64Image('image/png', 1);
      link.download = `trade-explorer-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  }

  function init() {
    document.querySelectorAll('[data-trade-explorer]').forEach((el) => new TradeExplorerWidget(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.TradeExplorer = { init: (el) => new TradeExplorerWidget(el) };
})();
