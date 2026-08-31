// Embeddable ASI dashboard widget. Drop one <div data-asi-dashboard
// data-api-base="..."></div> and this <script> into any page — every
// dataset/dimension/measure/filter shown here comes entirely from the
// backend's /api/metadata response. Nothing in this file names a block;
// new modules "just appear" once the backend registers them.
(function () {
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function cssEscape(str) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // `truncateTicks` shortens long axis labels (e.g. decoded org-type names)
  // so they don't overlap. This only affects the rendered tick text —
  // Chart.js's default tooltip reads from `data.labels` (kept full), not
  // the tick-display string, so hovering still shows the untruncated label.
  function baseOptions(truncateTicks) {
    const opts = { responsive: true, maintainAspectRatio: false };
    if (truncateTicks) {
      opts.scales = {
        x: {
          ticks: {
            callback: function (value) {
              const label = this.getLabelForValue(value);
              return label.length > 18 ? `${label.slice(0, 16)}…` : label;
            },
          },
        },
      };
    }
    return opts;
  }

  const FALLBACK_PALETTE = ['#4c72b0', '#dd8452', '#55a868', '#c44e52', '#8172b2', '#937860', '#da8bc3', '#8c8c8c', '#ccb974', '#64b5cd'];

  function palette(n, seedColor) {
    const colors = [seedColor, ...FALLBACK_PALETTE.filter((c) => c.toLowerCase() !== seedColor.toLowerCase())];
    const out = [];
    for (let i = 0; i < n; i++) out.push(colors[i % colors.length]);
    return out;
  }

  // Overlays highlight colors (keyed by each point's RAW, undecoded value)
  // on top of a chart-type-specific default color array. Index-aligned
  // with `rawValues`.
  function applyHighlights(defaultColors, rawValues, highlightMap) {
    return rawValues.map((v, i) => highlightMap.get(v) || defaultColors[i]);
  }

  // Chart-type registry: adding a new chart type is adding one key here
  // (plus one string in the backend's VALID_CHART_TYPES whitelist). Every
  // renderer gets (ctx, labels, values, baseColor, rawValues, highlightMap)
  // — rawValues/highlightMap are what per-category highlighting is built on.
  const CHART_RENDERERS = {
    bar: (ctx, labels, values, baseColor, rawValues, highlightMap) => {
      const colors = applyHighlights(rawValues.map(() => baseColor), rawValues, highlightMap);
      return new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Value', data: values, backgroundColor: colors }] },
        options: baseOptions(true),
      });
    },
    line: (ctx, labels, values, baseColor, rawValues, highlightMap) => {
      const pointColors = applyHighlights(rawValues.map(() => baseColor), rawValues, highlightMap);
      const pointRadius = rawValues.map((v) => (highlightMap.has(v) ? 6 : 3));
      return new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Value', data: values, borderColor: baseColor, backgroundColor: baseColor,
            fill: false, tension: 0.25,
            pointBackgroundColor: pointColors, pointBorderColor: pointColors, pointRadius,
          }],
        },
        options: baseOptions(true),
      });
    },
    pie: (ctx, labels, values, baseColor, rawValues, highlightMap) => {
      const colors = applyHighlights(palette(labels.length, baseColor), rawValues, highlightMap);
      return new Chart(ctx, {
        type: 'pie',
        data: { labels, datasets: [{ data: values, backgroundColor: colors }] },
        options: baseOptions(false),
      });
    },
  };

  // CSV field escaping per RFC 4180: quote (and double any embedded quotes)
  // only when the field actually contains a comma/quote/newline.
  function csvEscape(value) {
    const str = String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  // Builds a standalone Chart for PNG export — same data/highlight logic as
  // CHART_RENDERERS, but deliberately different options: full (untruncated)
  // labels rotated instead of shortened, `autoSkip: false` so every category
  // is shown, and a caption baked in via the title plugin. Kept separate
  // from CHART_RENDERERS (rather than parameterizing it) so the on-screen
  // rendering path — already working and covered by the existing tick-
  // truncation behavior — can't be affected by export-only changes.
  function buildExportChart(canvas, chartType, labels, values, baseColor, rawValues, highlightMap, captionLines) {
    const commonOptions = {
      responsive: false,
      animation: false,
      plugins: { title: { display: true, text: captionLines, font: { size: 14 }, padding: { bottom: 12 } } },
    };
    const rotatedTicks = { scales: { x: { ticks: { autoSkip: false, maxRotation: 90, minRotation: 45 } } } };

    if (chartType === 'line') {
      const pointColors = applyHighlights(rawValues.map(() => baseColor), rawValues, highlightMap);
      const pointRadius = rawValues.map((v) => (highlightMap.has(v) ? 6 : 3));
      return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Value', data: values, borderColor: baseColor, backgroundColor: baseColor,
            fill: false, tension: 0.25,
            pointBackgroundColor: pointColors, pointBorderColor: pointColors, pointRadius,
          }],
        },
        options: { ...commonOptions, ...rotatedTicks },
      });
    }
    if (chartType === 'pie') {
      const colors = applyHighlights(palette(labels.length, baseColor), rawValues, highlightMap);
      return new Chart(canvas.getContext('2d'), {
        type: 'pie',
        data: { labels, datasets: [{ data: values, backgroundColor: colors }] },
        options: commonOptions,
      });
    }
    const colors = applyHighlights(rawValues.map(() => baseColor), rawValues, highlightMap);
    return new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Value', data: values, backgroundColor: colors }] },
      options: { ...commonOptions, ...rotatedTicks },
    });
  }

  const TOP_N_OPTIONS = [
    { value: 'all', label: 'All' },
    { value: '5', label: 'Top 5' },
    { value: '10', label: 'Top 10' },
    { value: '25', label: 'Top 25' },
    { value: '50', label: 'Top 50' },
  ];

  const HIGHLIGHT_COLORS = ['#dd8452', '#55a868', '#c44e52', '#8172b2', '#937860', '#da8bc3', '#8c8c8c', '#ccb974', '#64b5cd', '#4c72b0'];

  class ASIDashboardWidget {
    constructor(root) {
      this.root = root;
      this.apiBase = root.dataset.apiBase || '';
      this.metadata = null;
      this.chart = null;
      this.lastResult = null; // { ds, body, data } from the last successful /api/query
      this.lastDrawn = null; // { ds, body, labels, values, rawValues, highlightMap } for the chart on screen right now
      this.highlightValues = []; // [{value, label}] for the current X-axis dimension
      this.highlightRows = []; // [{id, rowEl, select, colorInput}]
      this.highlightRowSeq = 0;
      this.renderShell();
      this.init();
    }

    async init() {
      try {
        const res = await fetch(`${this.apiBase}/api/metadata`);
        this.metadata = await res.json();
        this.populateDatasets();
      } catch (err) {
        this.el.status.textContent = `Failed to load metadata: ${err.message}`;
      }
    }

    renderShell() {
      this.root.innerHTML = `
        <div class="asi-dash">
          <div class="asi-dash__controls">
            <label>Dataset <select data-role="dataset"></select></label>
            <label>X-Axis <select data-role="x"></select></label>
            <label>Y-Axis <select data-role="y"></select></label>
            <label>Aggregation <select data-role="agg"></select></label>
            <label class="asi-dash__toggle"><input type="checkbox" data-role="weighted" checked> Weighted (mult)</label>
            <label>Chart Type <select data-role="chartType"></select></label>
            <label>Color <input type="color" data-role="color" value="#4c72b0"></label>
          </div>

          <div class="asi-dash__filters" data-role="filters"></div>

          <div class="asi-dash__chart-controls">
            <div class="asi-dash__section-header">
              <div class="asi-dash__section-header-left">
                <span>Highlights</span>
                <label class="asi-dash__topn-inline">Show
                  <select data-role="topn">
                    ${TOP_N_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
                  </select>
                </label>
              </div>
              <div class="asi-dash__section-header-right">
                <button type="button" data-role="download-png">Download PNG</button>
                <button type="button" data-role="download-csv">Download CSV</button>
                <button type="button" data-role="highlight-add">+ Add highlight</button>
              </div>
            </div>
            <div class="asi-dash__highlights" data-role="highlights"></div>
          </div>

          <div class="asi-dash__chartwrap"><canvas data-role="canvas"></canvas></div>
          <div class="asi-dash__status" data-role="status"></div>
        </div>`;

      this.el = {
        dataset: this.root.querySelector('[data-role="dataset"]'),
        x: this.root.querySelector('[data-role="x"]'),
        y: this.root.querySelector('[data-role="y"]'),
        agg: this.root.querySelector('[data-role="agg"]'),
        weighted: this.root.querySelector('[data-role="weighted"]'),
        chartType: this.root.querySelector('[data-role="chartType"]'),
        topn: this.root.querySelector('[data-role="topn"]'),
        color: this.root.querySelector('[data-role="color"]'),
        highlights: this.root.querySelector('[data-role="highlights"]'),
        highlightAdd: this.root.querySelector('[data-role="highlight-add"]'),
        downloadPng: this.root.querySelector('[data-role="download-png"]'),
        downloadCsv: this.root.querySelector('[data-role="download-csv"]'),
        filters: this.root.querySelector('[data-role="filters"]'),
        canvas: this.root.querySelector('[data-role="canvas"]'),
        status: this.root.querySelector('[data-role="status"]'),
      };

      this.el.dataset.addEventListener('change', () => this.populateFieldsForDataset());
      this.el.x.addEventListener('change', async () => {
        await this.refreshHighlightOptions();
        this.runQuery();
      });
      this.el.y.addEventListener('change', () => {
        this.updateAggAvailability();
        this.runQuery();
      });
      for (const key of ['agg', 'weighted']) {
        this.el[key].addEventListener('change', () => this.runQuery());
      }
      // Chart type/color/Top-N are pure rendering choices — the backend
      // never uses chartType and doesn't need to re-run the query for them.
      for (const key of ['chartType', 'color', 'topn']) {
        this.el[key].addEventListener('change', () => this.redraw());
      }
      this.el.highlightAdd.addEventListener('click', () => this.addHighlightRow());
      this.el.downloadPng.addEventListener('click', () => this.downloadChartImage());
      this.el.downloadCsv.addEventListener('click', () => this.downloadCSV());
    }

    populateDatasets() {
      this.el.dataset.innerHTML = this.metadata.datasets
        .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)}</option>`)
        .join('');
      this.el.agg.innerHTML = this.metadata.aggregations
        .map((a) => `<option value="${a}">${a}</option>`)
        .join('');
      this.el.chartType.innerHTML = this.metadata.chartTypes
        .map((c) => `<option value="${c}">${c}</option>`)
        .join('');
      this.populateFieldsForDataset();
    }

    currentDataset() {
      return this.metadata.datasets.find((d) => d.id === this.el.dataset.value) || this.metadata.datasets[0];
    }

    currentMeasure() {
      const ds = this.currentDataset();
      return ds && ds.measures.find((m) => m.key === this.el.y.value);
    }

    // Ratio measures (Output per Worker, Labor Income %, etc.) always
    // compute SUM(numerator)/SUM(denominator) server-side regardless of
    // the requested aggregation — showing "avg" next to one and getting a
    // sum/sum ratio back would be confusing, so the control is disabled
    // (and pinned to "sum", which is what's actually computed) whenever
    // the selected Y measure is a ratio.
    updateAggAvailability() {
      const measure = this.currentMeasure();
      const isRatio = !!(measure && measure.ratio);
      this.el.agg.disabled = isRatio;
      if (isRatio) {
        this.el.agg.value = 'sum';
        this.el.agg.title = 'Ratio measures always compute sum(numerator) / sum(denominator)';
      } else {
        this.el.agg.title = '';
      }
    }

    async populateFieldsForDataset() {
      const ds = this.currentDataset();
      if (!ds) return;
      this.el.x.innerHTML = ds.dimensions
        .map((d) => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.label)}</option>`)
        .join('');
      this.el.y.innerHTML = ds.measures
        .map((m) => `<option value="${escapeHtml(m.key)}">${escapeHtml(m.label)}</option>`)
        .join('');
      this.updateAggAvailability();
      await this.refreshHighlightOptions();
      this.renderFilters(ds);
    }

    // --- Filters: checkboxes + search + select-all/clear ---------------

    async renderFilters(ds) {
      const filterableDims = ds.dimensions.filter((d) => d.filterable);
      // Collapsed by default — with datasets like PLFS declaring 20+
      // filterable dimensions, rendering every option list open at once
      // made the page feel unnavigable. Collapsing to just the label (plus
      // a live selected-count badge, so a collapsed filter that already
      // has selections doesn't look empty) keeps the same functionality
      // reachable in one click instead of always taking the full space.
      this.el.filters.innerHTML = filterableDims
        .map((d) => `
          <div class="asi-dash__filter is-collapsed">
            <div class="asi-dash__filter-header" data-role="filter-toggle" data-key="${escapeHtml(d.key)}">
              <span class="asi-dash__filter-toggle-icon" aria-hidden="true">▸</span>
              <label>${escapeHtml(d.label)}</label>
              <span class="asi-dash__filter-count" data-role="filter-count" data-key="${escapeHtml(d.key)}"></span>
              <div class="asi-dash__filter-actions">
                <button type="button" data-role="filter-all" data-key="${escapeHtml(d.key)}">All</button>
                <button type="button" data-role="filter-clear" data-key="${escapeHtml(d.key)}">Clear</button>
              </div>
            </div>
            <input type="text" class="asi-dash__filter-search" placeholder="Search…"
                   data-role="filter-search" data-key="${escapeHtml(d.key)}">
            <div class="asi-dash__filter-options" data-role="filter-options" data-key="${escapeHtml(d.key)}"></div>
          </div>`)
        .join('');

      this.el.filters.querySelectorAll('[data-role="filter-toggle"]').forEach((header) => {
        header.addEventListener('click', (e) => {
          if (e.target.closest('button')) return; // All/Clear shouldn't toggle collapse
          header.closest('.asi-dash__filter').classList.toggle('is-collapsed');
        });
      });

      await Promise.all(filterableDims.map(async (dim) => {
        const container = this.el.filters.querySelector(
          `[data-role="filter-options"][data-key="${cssEscape(dim.key)}"]`
        );
        try {
          const url = `${this.apiBase}/api/dimension-values?dataset=${encodeURIComponent(ds.id)}&dim=${encodeURIComponent(dim.key)}`;
          const res = await fetch(url);
          const body = await res.json();
          container.innerHTML = (body.values || [])
            .map((v) => {
              const decoded = dim.decode && dim.decode[String(v)];
              const label = decoded ? `${decoded} (${v})` : String(v);
              return `<label class="asi-dash__filter-option">
                        <input type="checkbox" value="${escapeHtml(String(v))}">
                        <span>${escapeHtml(label)}</span>
                      </label>`;
            })
            .join('');
          container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.addEventListener('change', () => {
              this.updateFilterCount(dim.key);
              this.runQuery();
            });
          });
        } catch (err) {
          // leave the filter empty on failure — it's optional, not fatal
        }
      }));

      this.el.filters.querySelectorAll('input[data-role="filter-search"]').forEach((input) => {
        input.addEventListener('input', () => {
          const container = this.el.filters.querySelector(
            `[data-role="filter-options"][data-key="${cssEscape(input.dataset.key)}"]`
          );
          const q = input.value.trim().toLowerCase();
          container.querySelectorAll('label.asi-dash__filter-option').forEach((row) => {
            row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none';
          });
        });
      });

      this.el.filters.querySelectorAll('button[data-role="filter-all"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const container = this.el.filters.querySelector(
            `[data-role="filter-options"][data-key="${cssEscape(btn.dataset.key)}"]`
          );
          container.querySelectorAll('label.asi-dash__filter-option').forEach((row) => {
            if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = true;
          });
          this.updateFilterCount(btn.dataset.key);
          this.runQuery();
        });
      });

      this.el.filters.querySelectorAll('button[data-role="filter-clear"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const container = this.el.filters.querySelector(
            `[data-role="filter-options"][data-key="${cssEscape(btn.dataset.key)}"]`
          );
          container.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
          this.updateFilterCount(btn.dataset.key);
          this.runQuery();
        });
      });

      this.runQuery();
    }

    // Shows how many values are selected in a (possibly collapsed) filter,
    // so collapsing everything by default doesn't hide active selections.
    updateFilterCount(key) {
      const container = this.el.filters.querySelector(
        `[data-role="filter-options"][data-key="${cssEscape(key)}"]`
      );
      const badge = this.el.filters.querySelector(
        `[data-role="filter-count"][data-key="${cssEscape(key)}"]`
      );
      if (!container || !badge) return;
      const n = container.querySelectorAll('input[type="checkbox"]:checked').length;
      badge.textContent = n > 0 ? String(n) : '';
    }

    collectFilters() {
      const filters = {};
      this.el.filters.querySelectorAll('[data-role="filter-options"]').forEach((container) => {
        const values = Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
        if (values.length) filters[container.dataset.key] = values;
      });
      return filters;
    }

    // --- Highlights: multiple categories, each with its own color -------

    async refreshHighlightOptions() {
      this.el.highlights.innerHTML = '';
      this.highlightRows = [];
      this.highlightValues = [];

      const ds = this.currentDataset();
      const xKey = this.el.x.value;
      if (!ds || !xKey) return;
      const xDim = ds.dimensions.find((d) => d.key === xKey);

      try {
        const url = `${this.apiBase}/api/dimension-values?dataset=${encodeURIComponent(ds.id)}&dim=${encodeURIComponent(xKey)}`;
        const res = await fetch(url);
        const body = await res.json();
        this.highlightValues = (body.values || []).map((v) => {
          const decoded = xDim && xDim.decode && xDim.decode[String(v)];
          return { value: String(v), label: decoded ? `${decoded} (${v})` : String(v) };
        });
      } catch (err) {
        this.highlightValues = [];
      }
    }

    addHighlightRow() {
      if (!this.highlightValues.length) return;
      const id = `hl-${this.highlightRowSeq++}`;
      const usedColors = new Set(this.highlightRows.map((r) => r.colorInput.value));
      const nextColor = HIGHLIGHT_COLORS.find((c) => !usedColors.has(c))
        || HIGHLIGHT_COLORS[this.highlightRows.length % HIGHLIGHT_COLORS.length];

      const row = document.createElement('div');
      row.className = 'asi-dash__highlight-row';
      row.innerHTML = `
        <select data-role="highlight-category">
          ${this.highlightValues.map((v) => `<option value="${escapeHtml(v.value)}">${escapeHtml(v.label)}</option>`).join('')}
        </select>
        <input type="color" data-role="highlight-color" value="${nextColor}">
        <button type="button" data-role="highlight-remove" aria-label="Remove highlight">×</button>
      `;
      this.el.highlights.appendChild(row);

      const select = row.querySelector('[data-role="highlight-category"]');
      const colorInput = row.querySelector('[data-role="highlight-color"]');
      const removeBtn = row.querySelector('[data-role="highlight-remove"]');

      select.addEventListener('change', () => this.redraw());
      colorInput.addEventListener('input', () => this.redraw());
      removeBtn.addEventListener('click', () => {
        row.remove();
        this.highlightRows = this.highlightRows.filter((r) => r.id !== id);
        this.redraw();
      });

      this.highlightRows.push({ id, rowEl: row, select, colorInput });
      this.redraw();
    }

    buildHighlightMap() {
      const map = new Map();
      for (const row of this.highlightRows) {
        if (row.select.value) map.set(row.select.value, row.colorInput.value);
      }
      return map;
    }

    // --- Query + render ---------------------------------------------------

    async runQuery() {
      const ds = this.currentDataset();
      if (!ds || !this.el.x.value || !this.el.y.value) return;
      const body = {
        dataset: ds.id,
        x: this.el.x.value,
        y: this.el.y.value,
        agg: this.el.agg.value,
        weighted: this.el.weighted.checked,
        chartType: this.el.chartType.value,
        filters: this.collectFilters(),
      };
      this.el.status.textContent = 'Loading…';
      try {
        const res = await fetch(`${this.apiBase}/api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'query failed');
        this.el.status.textContent = '';
        this.lastResult = { ds, body, data };
        this.redraw();
      } catch (err) {
        this.el.status.textContent = `Error: ${err.message}`;
      }
    }

    // Re-renders the last fetched result with whatever chart type/color/
    // Top-N/highlights are currently set — no network round trip.
    redraw() {
      if (!this.lastResult) return;
      const { ds, body, data } = this.lastResult;
      this.draw(ds, { ...body, chartType: this.el.chartType.value }, data);
    }

    draw(ds, body, data) {
      const xDim = ds.dimensions.find((d) => d.key === body.x);

      let rows = data.labels.map((raw, i) => ({ raw, value: data.values[i] }));
      const topN = this.el.topn.value;
      if (topN !== 'all') {
        const n = parseInt(topN, 10);
        rows = [...rows]
          .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
          .slice(0, n);
      }

      const labels = rows.map((r) => {
        const decoded = xDim && xDim.decode && xDim.decode[String(r.raw)];
        return decoded ? `${decoded} (${r.raw})` : String(r.raw);
      });
      const values = rows.map((r) => r.value);
      const rawValues = rows.map((r) => String(r.raw));
      const highlightMap = this.buildHighlightMap();

      this.lastDrawn = { ds, body, labels, values, rawValues, highlightMap };

      if (this.chart) this.chart.destroy();
      const renderer = CHART_RENDERERS[body.chartType] || CHART_RENDERERS.bar;
      this.chart = renderer(this.el.canvas.getContext('2d'), labels, values, this.el.color.value, rawValues, highlightMap);
    }

    // --- Export: PNG (full labels, no hover needed) + CSV ----------------

    // Builds a short multi-line caption (dataset/X/Y/aggregation/weighted,
    // plus a filters summary) so an exported chart is self-explanatory even
    // outside the dashboard, without needing the on-screen controls next to it.
    buildCaption(ds, body) {
      const xDim = ds.dimensions.find((d) => d.key === body.x);
      const yMeasure = ds.measures.find((m) => m.key === body.y);
      const aggLabel = yMeasure && yMeasure.ratio ? 'ratio' : body.agg;
      const weightLabel = body.weighted ? 'weighted' : 'raw';
      const lines = [
        `${ds.label} — ${xDim ? xDim.label : body.x} × ${yMeasure ? yMeasure.label : body.y} (${aggLabel}, ${weightLabel})`,
      ];

      const filterParts = [];
      for (const [key, values] of Object.entries(body.filters || {})) {
        const dim = ds.dimensions.find((d) => d.key === key);
        const label = dim ? dim.label : key;
        const valueText = values.length > 3
          ? `${values.length} selected`
          : values.map((v) => {
            const decoded = dim && dim.decode && dim.decode[String(v)];
            return decoded ? `${decoded} (${v})` : String(v);
          }).join(', ');
        filterParts.push(`${label}: ${valueText}`);
      }
      if (filterParts.length) {
        let filterLine = `Filters — ${filterParts.join('; ')}`;
        if (filterLine.length > 120) filterLine = `${filterLine.slice(0, 117)}...`;
        lines.push(filterLine);
      }
      return lines;
    }

    exportFilename(ds, body, ext) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      return `asi-${ds.id}-${body.x}-${body.y}-${stamp}.${ext}`;
    }

    // Re-renders the currently-displayed data (same Top-N/highlight state,
    // same full decoded labels) onto an offscreen canvas with no tick
    // truncation, so the downloaded PNG needs no hovering to be readable.
    downloadChartImage() {
      if (!this.lastDrawn) return;
      const { ds, body, labels, values, rawValues, highlightMap } = this.lastDrawn;
      const caption = this.buildCaption(ds, body);

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(900, labels.length * 32);
      canvas.height = 560 + caption.length * 24;
      canvas.style.position = 'absolute';
      canvas.style.left = '-9999px';
      canvas.style.top = '-9999px';
      document.body.appendChild(canvas);

      const tempChart = buildExportChart(
        canvas, body.chartType, labels, values, this.el.color.value, rawValues, highlightMap, caption
      );

      const link = document.createElement('a');
      link.href = tempChart.toBase64Image('image/png', 1);
      link.download = this.exportFilename(ds, body, 'png');
      document.body.appendChild(link);
      link.click();
      link.remove();

      tempChart.destroy();
      canvas.remove();
    }

    downloadCSV() {
      if (!this.lastDrawn) return;
      const { ds, body, labels, values } = this.lastDrawn;
      const xDim = ds.dimensions.find((d) => d.key === body.x);
      const yMeasure = ds.measures.find((m) => m.key === body.y);

      const rows = [
        [xDim ? xDim.label : body.x, yMeasure ? yMeasure.label : body.y],
        ...labels.map((l, i) => [l, values[i]]),
      ];
      const csvText = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');

      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = this.exportFilename(ds, body, 'csv');
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }
  }

  function init() {
    document.querySelectorAll('[data-asi-dashboard]').forEach((el) => new ASIDashboardWidget(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.ASIDashboard = { init: (el) => new ASIDashboardWidget(el), CHART_RENDERERS };
})();
