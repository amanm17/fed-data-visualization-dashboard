// ASI Block D — Working Capital and Loans. Item-grain: exactly 17 fixed
// line-item rows per unit (confirmed empirically — dI1 takes only values
// 1-17), several of which (11, 15, 16, 17) are already pre-computed totals
// (Total Current Assets/Liabilities, Working Capital, Outstanding Loans).
// Rollup entries pivot each code into a named unit-level column, matching
// the source R script's `D_summary` exactly. Codes 12-14 are never named
// individually in that script, so they're left as raw codes.
module.exports = {
  id: 'block_d',
  label: 'Block D — Working Capital & Loans',
  grain: 'item',
  file: 'block_d.csv',
  idColumn: 'ad01',

  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    ad01: 'VARCHAR',
    dI1: 'INTEGER',
    dI3: 'DOUBLE',
    dI4: 'DOUBLE',
  },

  dimensions: [
    {
      key: 'dI1', label: 'Working Capital Line Item Code', filterable: true,
      decode: {
        1: 'Raw Materials', 2: 'Fuels', 3: 'Stores/Spares',
        4: 'Materials, Fuels & Stores (Combined)', 5: 'Semi-Finished Goods',
        6: 'Finished Goods', 7: 'Total Inventory', 8: 'Cash & Bank',
        9: 'Sundry Debtors', 10: 'Other Current Assets', 11: 'Total Current Assets',
        15: 'Total Current Liabilities', 16: 'Working Capital', 17: 'Outstanding Loans',
      },
    },
  ],

  measures: [
    { key: 'dI3', label: 'Opening (Rs.)' },
    { key: 'dI4', label: 'Closing (Rs.)' },
  ],

  rollup: (() => {
    const pairs = [
      [1, 'raw_materials', 'Raw Materials'],
      [2, 'fuels', 'Fuels'],
      [3, 'stores', 'Stores/Spares'],
      [4, 'materials_fuels_stores', 'Materials, Fuels & Stores (Combined)'],
      [5, 'semi_finished', 'Semi-Finished Goods'],
      [6, 'finished_goods', 'Finished Goods'],
      [7, 'total_inventory', 'Total Inventory'],
      [8, 'cash_bank', 'Cash & Bank'],
      [9, 'sundry_debtors', 'Sundry Debtors'],
      [10, 'other_current_assets', 'Other Current Assets'],
    ];
    const entries = [];
    for (const [code, key, label] of pairs) {
      entries.push({
        as: `${key}_opening`, label: `${label} — Opening (Rs.)`,
        dependsOn: ['dI1', 'dI3'],
        sql: (c) => `MAX(CASE WHEN ${c.dI1} = ${code} THEN ${c.dI3} END)`,
      });
      entries.push({
        as: `${key}_closing`, label: `${label} — Closing (Rs.)`,
        dependsOn: ['dI1', 'dI4'],
        sql: (c) => `MAX(CASE WHEN ${c.dI1} = ${code} THEN ${c.dI4} END)`,
      });
    }
    const closingOnly = [
      [11, 'total_current_assets', 'Total Current Assets'],
      [15, 'total_current_liabilities', 'Total Current Liabilities'],
      [16, 'working_capital', 'Working Capital'],
      [17, 'outstanding_loans', 'Outstanding Loans'],
    ];
    for (const [code, key, label] of closingOnly) {
      entries.push({
        as: key, label: `${label} (Rs.)`,
        dependsOn: ['dI1', 'dI4'],
        sql: (c) => `MAX(CASE WHEN ${c.dI1} = ${code} THEN ${c.dI4} END)`,
      });
    }
    return entries;
  })(),
};
