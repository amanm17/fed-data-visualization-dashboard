// ASI Block I — Directly Imported Items Consumed. Item-grain, same shape
// as Block H but simpler: a handful of imported-commodity item rows (II1
// 1-6ish) plus one fixed grand-total row at code 7 (confirmed — code 7 has
// the highest row count of any II1 value, matching "always-present total"
// behavior). Only the total is needed downstream, matching the source R
// script's `I_summary` exactly.
const UNIT_OF_QUANTITY_CODES = require('./data/unit_of_quantity_codes');

module.exports = {
  id: 'block_i',
  label: 'Block I — Imported Inputs Consumed',
  grain: 'item',
  file: 'block_i.csv',
  idColumn: 'AI01',

  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    AI01: 'VARCHAR',
    II1: 'INTEGER',
    II3: 'VARCHAR',
    II4: 'INTEGER',
    II5: 'DOUBLE',
    II6: 'DOUBLE',
    II7: 'DOUBLE',
  },

  dimensions: [
    {
      key: 'II1', label: 'Row Code (Item Serial / Summary Row)', filterable: false,
      decode: { 7: 'Total Imported Inputs' },
    },
    { key: 'II3', label: 'Item Code (NPCMS)', filterable: false },
    { key: 'II4', label: 'Unit of Quantity', filterable: true, decode: UNIT_OF_QUANTITY_CODES },
  ],

  measures: [
    { key: 'II5', label: 'Quantity Consumed' },
    { key: 'II6', label: 'Purchase Value (Rs.)' },
    { key: 'II7', label: 'Rate per Unit (Rs.)' },
  ],

  rollup: [
    {
      as: 'imported_total_inputs', label: 'Total Imported Inputs — Purchase Value (Rs.)',
      dependsOn: ['II1', 'II6'],
      sql: (c) => `MAX(CASE WHEN ${c.II1} = 7 THEN ${c.II6} END)`,
    },
  ],
};
