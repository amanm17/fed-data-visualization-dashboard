// Embeddable "Financial Analyzer" widget. Drop one <div
// data-financial-analyzer></div> plus this script (and its dependencies:
// financial-core.js, SheetJS's `xlsx`, and Chart.js) on any page.
//
// A JS port of app_financial.py (Streamlit) — same logic (see
// financial-core.js for the extraction/common-size/aggregate-average
// port), different UI toolkit. Everything runs client-side: uploaded
// Screener.in "Data Sheet" files (.xlsx/.csv) are parsed in the browser via
// SheetJS and never leave the machine.
(function () {
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function formatNumber(n) {
    if (n === null || n === undefined) return '—';
    return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function dedupe(list) {
    return Array.from(new Set(list));
  }

  const PALETTE = ['#4c72b0', '#dd8452', '#55a868', '#c44e52', '#8172b2', '#937860', '#da8bc3', '#8c8c8c', '#ccb974', '#64b5cd'];
  function colorForIndex(i) { return PALETTE[i % PALETTE.length]; }

  function renderTable(section, opts) {
    opts = opts || {};
    if (!section || !section.rows.length) {
      return '<div class="fin-analyzer__nodata">No data</div>';
    }
    const suffix = opts.percent ? '%' : '';
    const head = `<tr><th>Line Item</th>${section.years.map((y) => `<th>${escapeHtml(y)}</th>`).join('')}</tr>`;
    const body = section.rows.map((r) => {
      const cells = section.years.map((y) => {
        const v = r.values[y];
        return `<td>${v === null || v === undefined ? '—' : formatNumber(v) + suffix}</td>`;
      }).join('');
      return `<tr><td>${escapeHtml(r.name)}</td>${cells}</tr>`;
    }).join('');
    return `<div class="fin-analyzer__table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  // Reads one uploaded file (xlsx or csv) into { name, rows } — `rows` is
  // the array-of-arrays financial-core.js expects. Company name prefers
  // the sheet's own "COMPANY NAME" cell (more reliable/readable than a
  // filename), falling back to the filename the same way app_financial.py
  // does when that cell isn't present.
  async function readUploadedFile(file) {
    const isCsv = /\.csv$/i.test(file.name);
    let rows;
    if (isCsv) {
      const text = await file.text();
      const wb = XLSX.read(text, { type: 'string' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    } else {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const sheetName = wb.SheetNames.includes('Data Sheet') ? 'Data Sheet' : wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    }

    const companyRow = rows.find((r) => r && String(r[0]).trim().toUpperCase() === 'COMPANY NAME');
    const name = (companyRow && companyRow[1])
      ? String(companyRow[1]).trim()
      : file.name.replace(/ - Data Sheet\.csv$/i, '').replace(/\.(csv|xlsx)$/i, '');

    return { name, rows };
  }

  class FinancialAnalyzerWidget {
    constructor(root) {
      this.root = root;
      this.companies = {};
      this.render();
    }

    render() {
      this.root.classList.add('fin-analyzer');
      this.root.innerHTML = `
        <div class="fin-analyzer__upload" data-role="dropzone">
          <p>Upload multiple Screener.in "Data Sheet" exports (.xlsx or .csv) to analyze and compare them. Files are parsed entirely in your browser — nothing is uploaded anywhere.</p>
          <input type="file" data-role="file-input" accept=".xlsx,.csv" multiple>
        </div>
        <div class="fin-analyzer__status" data-role="status"></div>
        <div class="fin-analyzer__tabs" data-role="tabs">
          <div class="fin-analyzer__tab-bar">
            <button type="button" class="fin-analyzer__tab-btn is-active" data-tab="individual">Individual Analysis</button>
            <button type="button" class="fin-analyzer__tab-btn" data-tab="aggregate">Aggregate Averages</button>
            <button type="button" class="fin-analyzer__tab-btn" data-tab="trends">Comparative Trends</button>
            <button type="button" class="fin-analyzer__tab-btn" data-tab="cstrends">Avg Common Size Trends</button>
          </div>
          <div class="fin-analyzer__panel is-active" data-panel="individual"></div>
          <div class="fin-analyzer__panel" data-panel="aggregate"></div>
          <div class="fin-analyzer__panel" data-panel="trends"></div>
          <div class="fin-analyzer__panel" data-panel="cstrends"></div>
        </div>
      `;

      this.el = {
        dropzone: this.root.querySelector('[data-role="dropzone"]'),
        fileInput: this.root.querySelector('[data-role="file-input"]'),
        status: this.root.querySelector('[data-role="status"]'),
        tabs: this.root.querySelector('[data-role="tabs"]'),
        panels: {
          individual: this.root.querySelector('[data-panel="individual"]'),
          aggregate: this.root.querySelector('[data-panel="aggregate"]'),
          trends: this.root.querySelector('[data-panel="trends"]'),
          cstrends: this.root.querySelector('[data-panel="cstrends"]'),
        },
      };

      this.el.fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));

      ['dragenter', 'dragover'].forEach((evt) => {
        this.el.dropzone.addEventListener(evt, (e) => {
          e.preventDefault();
          this.el.dropzone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'drop'].forEach((evt) => {
        this.el.dropzone.addEventListener(evt, (e) => {
          e.preventDefault();
          this.el.dropzone.classList.remove('is-dragover');
        });
      });
      this.el.dropzone.addEventListener('drop', (e) => {
        if (e.dataTransfer.files.length) this.handleFiles(e.dataTransfer.files);
      });

      this.root.querySelectorAll('.fin-analyzer__tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.setActiveTab(btn.dataset.tab));
      });
    }

    setActiveTab(tab) {
      this.root.querySelectorAll('.fin-analyzer__tab-btn').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.tab === tab);
      });
      Object.entries(this.el.panels).forEach(([key, el]) => el.classList.toggle('is-active', key === tab));
    }

    setStatus(msg, isError) {
      this.el.status.textContent = msg;
      this.el.status.classList.toggle('is-error', !!isError);
    }

    async handleFiles(fileList) {
      const files = Array.from(fileList);
      if (!files.length) return;
      this.setStatus(`Processing ${files.length} file(s) and aligning financial periods…`);
      this.companies = {};

      for (const file of files) {
        try {
          const { name, rows } = await readUploadedFile(file);
          const parsed = FinancialCore.parseCompanySheet(rows);
          if (parsed.pl && parsed.bs) this.companies[name] = parsed;
        } catch (err) {
          console.error('Failed to parse', file.name, err); // eslint-disable-line no-console
        }
      }

      const names = Object.keys(this.companies);
      if (!names.length) {
        this.setStatus('Could not extract valid Profit & Loss / Balance Sheet blocks from the uploaded file(s). Make sure these are Screener.in "Data Sheet" exports.', true);
        this.el.tabs.classList.remove('is-ready');
        return;
      }

      this.setStatus(`Successfully processed ${names.length} compan${names.length === 1 ? 'y' : 'ies'}: ${names.join(', ')}`);
      this.computeAggregates();
      this.el.tabs.classList.add('is-ready');
      this.renderIndividualTab();
      this.renderAggregateTab();
      this.renderTrendsTab();
      this.renderCsTrendsTab();
    }

    computeAggregates() {
      const plSections = Object.values(this.companies).map((c) => c.pl).filter(Boolean);
      const bsSections = Object.values(this.companies).map((c) => c.bs).filter(Boolean);
      this.avgPl = FinancialCore.aggregateAverage(plSections);
      this.avgBs = FinancialCore.aggregateAverage(bsSections);
      this.avgRevenueRow = this.avgPl ? FinancialCore.findRevenueRow(this.avgPl) : null;
      this.avgCsPl = this.avgRevenueRow ? FinancialCore.commonSize(this.avgPl, this.avgRevenueRow.values) : null;
      // Balance Sheet is common-sized against the P&L's revenue row (same
      // as app_financial.py) — a BS has no revenue line of its own.
      this.avgCsBs = this.avgRevenueRow ? FinancialCore.commonSize(this.avgBs, this.avgRevenueRow.values) : null;
    }

    renderIndividualTab() {
      const names = Object.keys(this.companies);
      const panel = this.el.panels.individual;
      panel.innerHTML = `
        <div class="fin-analyzer__row">
          <label>Select Company to View
            <select data-role="company-select">${names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</select>
          </label>
        </div>
        <div data-role="individual-content"></div>
      `;
      const select = panel.querySelector('[data-role="company-select"]');
      const content = panel.querySelector('[data-role="individual-content"]');

      const draw = () => {
        const name = select.value;
        const { pl, bs } = this.companies[name];
        const revRow = FinancialCore.findRevenueRow(pl);
        const csPl = revRow ? FinancialCore.commonSize(pl, revRow.values) : null;
        const csBs = revRow ? FinancialCore.commonSize(bs, revRow.values) : null;
        content.innerHTML = `
          <div class="fin-analyzer__section-title">Financial Statements: ${escapeHtml(name)}</div>
          <div class="fin-analyzer__tables">${renderTable(pl)}${renderTable(bs)}</div>
          ${revRow ? `
            <div class="fin-analyzer__section-title">Common Size Analysis (Base: Total Revenue)</div>
            <div class="fin-analyzer__tables">${renderTable(csPl, { percent: true })}${renderTable(csBs, { percent: true })}</div>
          ` : '<div class="fin-analyzer__nodata">Could not identify a Sales/Revenue row for this company.</div>'}
        `;
      };
      select.addEventListener('change', draw);
      draw();
    }

    renderAggregateTab() {
      const panel = this.el.panels.aggregate;
      const n = Object.keys(this.companies).length;
      panel.innerHTML = `
        <div class="fin-analyzer__section-title">Industry / Group Averages — mean of every line item across all ${n} uploaded companies</div>
        <div class="fin-analyzer__tables">${renderTable(this.avgPl)}${renderTable(this.avgBs)}</div>
        ${this.avgCsPl ? `
          <div class="fin-analyzer__section-title">Average Common Size Analysis — average line items ÷ average total revenue</div>
          <div class="fin-analyzer__tables">${renderTable(this.avgCsPl, { percent: true })}${renderTable(this.avgCsBs, { percent: true })}</div>
        ` : '<div class="fin-analyzer__nodata">Could not identify the Revenue row to calculate aggregate common size.</div>'}
      `;
    }

    // For a line-item name, finds which section (PL or BS) a company/the
    // average reports it in, and returns { years, row } or null.
    static findItem(sections, name) {
      for (const s of sections) {
        if (!s) continue;
        const row = s.rows.find((r) => r.name === name);
        if (row) return { years: s.years, row };
      }
      return null;
    }

    renderTrendsTab() {
      const panel = this.el.panels.trends;
      const items = dedupe([...(this.avgPl ? this.avgPl.rows : []), ...(this.avgBs ? this.avgBs.rows : [])].map((r) => r.name));
      panel.innerHTML = `
        <div class="fin-analyzer__row">
          <label>Select a line item to compare across companies
            <select data-role="item-select">${items.map((i) => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join('')}</select>
          </label>
        </div>
        <div class="fin-analyzer__chart-wrap"><canvas data-role="chart"></canvas></div>
      `;
      const select = panel.querySelector('[data-role="item-select"]');
      const canvas = panel.querySelector('canvas');
      let chart = null;

      const draw = () => {
        const item = select.value;
        const datasets = [];
        Object.entries(this.companies).forEach(([name, data], idx) => {
          const found = FinancialAnalyzerWidget.findItem([data.pl, data.bs], item);
          if (!found) return;
          const points = found.years
            .map((y) => ({ x: y, y: found.row.values[y] }))
            .filter((p) => p.y !== null && p.y !== undefined);
          if (points.length) {
            const color = colorForIndex(idx);
            datasets.push({ label: name, data: points, borderColor: color, backgroundColor: color, borderWidth: 2, tension: 0.15, pointRadius: 3 });
          }
        });

        const avgFound = FinancialAnalyzerWidget.findItem([this.avgPl, this.avgBs], item);
        if (avgFound) {
          const points = avgFound.years
            .map((y) => ({ x: y, y: avgFound.row.values[y] }))
            .filter((p) => p.y !== null && p.y !== undefined);
          if (points.length) {
            datasets.push({
              label: 'GROUP AVERAGE', data: points, borderColor: '#888888', backgroundColor: '#888888',
              borderWidth: 4, borderDash: [6, 4], tension: 0.15, pointRadius: 0,
            });
          }
        }

        if (chart) chart.destroy();
        chart = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: { datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { type: 'category', title: { display: true, text: 'Financial Year' } },
              y: { title: { display: true, text: 'Reported Value' } },
            },
            plugins: { title: { display: true, text: `Comparative Trend: ${item}` } },
          },
        });
      };
      select.addEventListener('change', draw);
      draw();
    }

    renderCsTrendsTab() {
      const panel = this.el.panels.cstrends;
      if (!this.avgCsPl) {
        panel.innerHTML = '<div class="fin-analyzer__nodata">Average common size data is unavailable because a base revenue row could not be established.</div>';
        return;
      }
      const items = dedupe([...this.avgCsPl.rows, ...(this.avgCsBs ? this.avgCsBs.rows : [])].map((r) => r.name));
      panel.innerHTML = `
        <div class="fin-analyzer__row">
          <label>Select a metric to view its structural trend
            <select data-role="cs-item-select">${items.map((i) => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join('')}</select>
          </label>
        </div>
        <div class="fin-analyzer__chart-wrap"><canvas data-role="cs-chart"></canvas></div>
      `;
      const select = panel.querySelector('[data-role="cs-item-select"]');
      const canvas = panel.querySelector('canvas');
      let chart = null;

      const draw = () => {
        const item = select.value;
        const found = FinancialAnalyzerWidget.findItem([this.avgCsPl, this.avgCsBs], item);
        if (!found) return;
        const points = found.years
          .map((y) => ({ x: y, y: found.row.values[y] }))
          .filter((p) => p.y !== null && p.y !== undefined);

        if (chart) chart.destroy();
        chart = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            datasets: [{
              label: `${item} (% of Revenue)`, data: points,
              borderColor: '#4c72b0', backgroundColor: '#4c72b0', borderWidth: 2, tension: 0.15, pointRadius: 3,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { type: 'category', title: { display: true, text: 'Financial Period' } },
              y: { title: { display: true, text: 'Percentage of Revenue (%)' }, ticks: { callback: (v) => `${v}%` } },
            },
            plugins: { title: { display: true, text: `Group Average: ${item} as % of Revenue` } },
          },
        });
      };
      select.addEventListener('change', draw);
      draw();
    }
  }

  const instances = [];

  function init() {
    document.querySelectorAll('[data-financial-analyzer]').forEach((el) => {
      const widget = new FinancialAnalyzerWidget(el);
      el.__widget = widget;
      instances.push(widget);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.FinancialAnalyzer = { init: (el) => new FinancialAnalyzerWidget(el), instances };
})();
