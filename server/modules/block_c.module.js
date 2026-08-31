// ASI Block C — Fixed Assets. Item-grain: exactly 10 fixed asset-type rows
// per unit (confirmed empirically — c_11 takes only values 1-10), where
// code 10 is a pre-computed "Total Fixed Assets" row, not something to sum
// over. Rollup entries pivot specific codes into named unit-level columns
// (never a blanket SUM, which would double-count against the Total row) —
// transcribed directly from the source R script's `C_summary`.
//
// Asset-type codes 1/2/3/10 are confidently decoded because the R script's
// own variable names confirm them (land/building/plant_machinery/fixed_assets
// totals). Codes 4-9 are never individually named there, so they're left
// as raw codes rather than guessed.
module.exports = {
  id: 'block_c',
  label: 'Block C — Fixed Assets',
  grain: 'item',
  file: 'block_c.csv',
  idColumn: 'ac01',

  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    ac01: 'VARCHAR',
    c_11: 'INTEGER',
    c_13: 'DOUBLE',
    c_14: 'DOUBLE',
    c_15: 'DOUBLE',
    c_16: 'DOUBLE',
    c_17: 'DOUBLE',
    c_18: 'DOUBLE',
    c_19: 'DOUBLE',
    c_110: 'DOUBLE',
    c_111: 'DOUBLE',
    c_112: 'DOUBLE',
    c_113: 'DOUBLE',
  },

  dimensions: [
    {
      key: 'c_11', label: 'Asset Type Code', filterable: true,
      decode: { 1: 'Land', 2: 'Building', 3: 'Plant & Machinery', 10: 'Total Fixed Assets' },
    },
  ],

  measures: [
    { key: 'c_13', label: 'Gross Value — Opening (Rs.)' },
    { key: 'c_14', label: 'Gross Value — Addition Due to Revaluation (Rs.)' },
    { key: 'c_15', label: 'Gross Value — Actual Addition (Rs.)' },
    { key: 'c_16', label: 'Gross Value — Deduction & Adjustment (Rs.)' },
    { key: 'c_17', label: 'Gross Value — Closing (Rs.)' },
    { key: 'c_18', label: 'Depreciation — Up to Year Beginning (Rs.)' },
    { key: 'c_19', label: 'Depreciation — Provided During Year (Rs.)' },
    { key: 'c_110', label: 'Depreciation — Adjustment for Sold/Discarded (Rs.)' },
    { key: 'c_111', label: 'Depreciation — Up to Year End (Rs.)' },
    { key: 'c_112', label: 'Net Value — Opening (Rs.)' },
    { key: 'c_113', label: 'Net Value — Closing (Rs.)' },
  ],

  rollup: [
    {
      as: 'land_net_closing', label: 'Land — Net Value Closing (Rs.)',
      dependsOn: ['c_11', 'c_113'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 1 THEN ${c.c_113} END)`,
    },
    {
      as: 'building_net_closing', label: 'Building — Net Value Closing (Rs.)',
      dependsOn: ['c_11', 'c_113'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 2 THEN ${c.c_113} END)`,
    },
    {
      as: 'plant_machinery_net_closing', label: 'Plant & Machinery — Net Value Closing (Rs.)',
      dependsOn: ['c_11', 'c_113'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 3 THEN ${c.c_113} END)`,
    },
    {
      as: 'plant_machinery_gross_closing', label: 'Plant & Machinery — Gross Value Closing (Rs.)',
      dependsOn: ['c_11', 'c_17'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 3 THEN ${c.c_17} END)`,
    },
    {
      as: 'fixed_assets_gross_opening', label: 'Total Fixed Assets — Gross Value Opening (Rs.)',
      dependsOn: ['c_11', 'c_13'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 10 THEN ${c.c_13} END)`,
    },
    {
      as: 'fixed_assets_revaluation', label: 'Total Fixed Assets — Revaluation Addition (Rs.)',
      dependsOn: ['c_11', 'c_14'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 10 THEN ${c.c_14} END)`,
    },
    {
      as: 'actual_addition_fixed_assets', label: 'Total Fixed Assets — Actual Addition (Rs.)',
      dependsOn: ['c_11', 'c_15'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 10 THEN ${c.c_15} END)`,
    },
    {
      as: 'fixed_assets_deduction_adjustment', label: 'Total Fixed Assets — Deduction/Adjustment (Rs.)',
      dependsOn: ['c_11', 'c_16'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 10 THEN ${c.c_16} END)`,
    },
    {
      as: 'fixed_assets_gross_closing', label: 'Total Fixed Assets — Gross Value Closing (Rs.)',
      dependsOn: ['c_11', 'c_17'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 10 THEN ${c.c_17} END)`,
    },
    {
      as: 'depreciation_item10', label: 'Total Fixed Assets — Depreciation Provided (Rs.)',
      dependsOn: ['c_11', 'c_19'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 10 THEN ${c.c_19} END)`,
    },
    {
      as: 'fixed_assets_depr_adjustment_sold', label: 'Total Fixed Assets — Depreciation Adjustment Sold/Discarded (Rs.)',
      dependsOn: ['c_11', 'c_110'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 10 THEN ${c.c_110} END)`,
    },
    {
      as: 'fixed_assets_net_opening', label: 'Total Fixed Assets — Net Value Opening (Rs.)',
      dependsOn: ['c_11', 'c_112'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 10 THEN ${c.c_112} END)`,
    },
    {
      as: 'fixed_assets_net_closing', label: 'Total Fixed Assets — Net Value Closing (Rs.)',
      dependsOn: ['c_11', 'c_113'],
      sql: (c) => `MAX(CASE WHEN ${c.c_11} = 10 THEN ${c.c_113} END)`,
    },
    // Annexure VIII: Depreciation = sum(c_i9) over asset types 1-7,9
    // (excluding 8 = Capital Work-in-Progress, which isn't depreciated).
    {
      as: 'depreciation_annexure', label: 'Depreciation (Annexure VIII, excl. Capital WIP) (Rs.)',
      dependsOn: ['c_11', 'c_19'],
      sql: (c) => `SUM(CASE WHEN ${c.c_11} IN (1,2,3,4,5,6,7,9) THEN ${c.c_19} END)`,
    },
    // Annexure VIII: Net Fixed Capital Formation (before adding back R&D,
    // F7) = sum(net_closing - net_opening - revaluation) over the same
    // asset-type set.
    {
      as: 'nfcf_without_f7', label: 'Net Fixed Capital Formation excl. R&D (Annexure VIII) (Rs.)',
      dependsOn: ['c_11', 'c_113', 'c_112', 'c_14'],
      sql: (c) => `SUM(CASE WHEN ${c.c_11} IN (1,2,3,4,5,6,7,9)
                    THEN (${c.c_113} - ${c.c_112} - ${c.c_14}) END)`,
    },
  ],
};
