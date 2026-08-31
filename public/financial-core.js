// Pure, environment-agnostic port of app_financial.py's extraction/analysis
// logic — no DOM, no SheetJS dependency of its own. Takes plain
// array-of-arrays (what SheetJS's `sheet_to_json(ws, {header: 1})` returns,
// in the browser or in Node) so this same file can be exercised from a
// Node test script against real sample files before ever touching the UI.
//
// A "Section" (Profit & Loss, Balance Sheet, ...) is an ARRAY of
// { name, values } rows, NOT a plain object keyed by name — Screener's own
// Balance Sheet layout repeats the label "Total" twice (Total Liabilities,
// Total Assets), which pandas tolerates via duplicate index labels but a
// plain JS object would silently collapse to one. `values` is a plain
// object keyed by year string ("2024") -> number | null.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.FinancialCore = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  function normalizeKeyword(cell) {
    return String(cell === null || cell === undefined ? '' : cell).trim().toUpperCase();
  }

  function toNumericOrNull(cell) {
    if (cell === null || cell === undefined || cell === '') return null;
    if (cell instanceof Date) return null; // a date landing in a value cell isn't a number
    const n = typeof cell === 'number' ? cell : Number(String(cell).trim());
    return Number.isFinite(n) ? n : null;
  }

  // Screener's "Report Date" header cells are real Excel dates (confirmed
  // against actual sample files) — SheetJS with `cellDates: true` hands
  // those back as JS Date objects. Excel date-only values carry no time/
  // timezone component, so UTC fields are the safe way to read them back
  // without a local-timezone off-by-one-day risk.
  function yearOf(cell) {
    if (cell instanceof Date) return String(cell.getUTCFullYear());
    const s = String(cell === null || cell === undefined ? '' : cell).trim();
    if (s.includes('-')) return s.split('-')[0];
    return s;
  }

  // rows: array-of-arrays. Finds `startKeyword` in column 0, slices through
  // (but not including) the first row matching any of `endKeywords`, then
  // within that slice finds the "Report Date" header row and everything
  // below it becomes the line-item x year matrix.
  function extractSection(rows, startKeyword, endKeywords) {
    const ends = (endKeywords || []).map(normalizeKeyword);
    const startUpper = normalizeKeyword(startKeyword);

    const startIdx = rows.findIndex((r) => normalizeKeyword(r && r[0]) === startUpper);
    if (startIdx === -1) return null;

    let endIdx = rows.length;
    for (let i = startIdx + 1; i < rows.length; i++) {
      if (ends.includes(normalizeKeyword(rows[i] && rows[i][0]))) { endIdx = i; break; }
    }
    const slice = rows.slice(startIdx, endIdx);

    const headerIdx = slice.findIndex((r) => normalizeKeyword(r && r[0]).includes('REPORT DATE'));
    if (headerIdx === -1) return null;

    const headerRow = slice[headerIdx];
    const years = headerRow.slice(1).map(yearOf);

    let section = [];
    for (let i = headerIdx + 1; i < slice.length; i++) {
      const row = slice[i];
      if (!row) continue;
      const rawName = row[0];
      const values = {};
      let anyValue = false;
      years.forEach((yr, j) => {
        const v = toNumericOrNull(row[j + 1]);
        values[yr] = v;
        if (v !== null) anyValue = true;
      });
      if (!anyValue) continue; // dropna(how='all') on the value columns
      const name = rawName === null || rawName === undefined ? '' : String(rawName).trim();
      section.push({ name, values });
    }

    // dropna(axis=1, how='all'): drop a year column if every row is null
    // for that year.
    const keepYears = years.filter((yr) => section.some((r) => r.values[yr] !== null));
    section = section.map((r) => {
      const values = {};
      keepYears.forEach((yr) => { values[yr] = r.values[yr]; });
      return { name: r.name, values };
    });

    return { years: keepYears, rows: section };
  }

  function findRevenueRow(section) {
    if (!section) return null;
    return section.rows.find((r) => {
      const n = r.name.toLowerCase();
      return n.includes('sales') || n.includes('revenue');
    }) || null;
  }

  // Every value divided by the matching year's revenue figure, x100,
  // rounded to 2dp — a true "ratio of aggregates" per year, not averaged
  // per-row first.
  function commonSize(section, revenueValues) {
    if (!section || !revenueValues) return null;
    const rows = section.rows.map((r) => {
      const values = {};
      section.years.forEach((yr) => {
        const v = r.values[yr];
        const rev = revenueValues[yr];
        values[yr] = v !== null && rev !== null && rev !== 0
          ? Math.round((v / rev) * 100 * 100) / 100
          : null;
      });
      return { name: r.name, values };
    });
    return { years: section.years, rows };
  }

  // Concatenates every row from every company's section (matching
  // pd.concat) and averages per (line-item name, year) over only the rows
  // that actually report a value that year — a company/row with no value
  // for that item/year is excluded from that specific average, not
  // treated as zero. Preserves first-seen row order (Screener's natural
  // statement order — Sales first, Net Profit last) rather than pandas'
  // default alphabetical groupby sort, since reading a P&L alphabetically
  // isn't useful to anyone.
  function aggregateAverage(sections) {
    const valid = sections.filter(Boolean);
    if (!valid.length) return null;

    const yearSet = [];
    valid.forEach((s) => s.years.forEach((yr) => { if (!yearSet.includes(yr)) yearSet.push(yr); }));
    yearSet.sort();

    const order = [];
    const sums = new Map(); // name -> { year -> {sum, count} }
    valid.forEach((s) => {
      s.rows.forEach((r) => {
        if (!sums.has(r.name)) { sums.set(r.name, {}); order.push(r.name); }
        const bucket = sums.get(r.name);
        yearSet.forEach((yr) => {
          const v = r.values[yr];
          if (v === null || v === undefined) return;
          if (!bucket[yr]) bucket[yr] = { sum: 0, count: 0 };
          bucket[yr].sum += v;
          bucket[yr].count += 1;
        });
      });
    });

    const rows = order.map((name) => {
      const bucket = sums.get(name);
      const values = {};
      yearSet.forEach((yr) => {
        const b = bucket[yr];
        values[yr] = b ? Math.round((b.sum / b.count) * 100) / 100 : null;
      });
      return { name, values };
    });

    return { years: yearSet, rows };
  }

  // Convenience: pulls both statements out of one company's raw sheet rows.
  function parseCompanySheet(rows) {
    const pl = extractSection(rows, 'PROFIT & LOSS', ['Quarters']);
    const bs = extractSection(rows, 'BALANCE SHEET', ['CASH FLOW:']);
    return { pl, bs };
  }

  return {
    normalizeKeyword,
    toNumericOrNull,
    yearOf,
    extractSection,
    findRevenueRow,
    commonSize,
    aggregateAverage,
    parseCompanySheet,
  };
});
