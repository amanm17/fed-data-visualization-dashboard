// ASI Block J — Products & By-Products Manufactured. Item-grain: a handful
// of product-commodity item rows (J11 1-11ish) plus one fixed summary row
// at code 12 (confirmed — code 12 has the highest row count of any J11
// value, matching "always-present total" behavior). Rollup entries pivot
// that summary row's fields, matching the source R script's `J_summary`
// exactly.
const UNIT_OF_QUANTITY_CODES = require('./data/unit_of_quantity_codes');

module.exports = {
  id: 'block_j',
  label: 'Block J — Products & By-Products',
  grain: 'item',
  file: 'block_j.csv',
  idColumn: 'AJ01',

  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    AJ01: 'VARCHAR',
    J11: 'INTEGER',
    J13: 'VARCHAR',
    J14: 'INTEGER',
    J15: 'DOUBLE',
    J16: 'DOUBLE',
    J17: 'DOUBLE',
    J18: 'DOUBLE',
    J19: 'DOUBLE',
    J110: 'DOUBLE',
    J111: 'DOUBLE',
    J112: 'DOUBLE',
    J113: 'DOUBLE',
  },

  dimensions: [
    {
      key: 'J11', label: 'Row Code (Item Serial / Summary Row)', filterable: false,
      decode: { 12: 'Total Products/By-Products' },
    },
    { key: 'J13', label: 'Item Code (NPCMS)', filterable: false },
    { key: 'J14', label: 'Unit of Quantity', filterable: true, decode: UNIT_OF_QUANTITY_CODES },
  ],

  measures: [
    { key: 'J15', label: 'Quantity Manufactured' },
    { key: 'J16', label: 'Quantity Sold' },
    { key: 'J17', label: 'Gross Sale Value (Rs.)' },
    { key: 'J18', label: 'Goods & Services Tax (Rs.)' },
    { key: 'J19', label: 'Excise Duty/Sales Tax/VAT/Other Taxes (Rs.)' },
    { key: 'J110', label: 'Other Distributive Expenses (Rs.)' },
    { key: 'J111', label: 'Subsidy (Rs.)' },
    { key: 'J112', label: 'Per Unit Net Sale Value (Rs.)' },
    { key: 'J113', label: 'Ex-Factory Value (Rs.)' },
  ],

  rollup: [
    {
      as: 'gross_sale_value_item12', label: 'Total Products — Gross Sale Value (Rs.)',
      dependsOn: ['J11', 'J17'],
      sql: (c) => `MAX(CASE WHEN ${c.J11} = 12 THEN ${c.J17} END)`,
    },
    {
      as: 'gst_item12', label: 'Total Products — GST (Rs.)',
      dependsOn: ['J11', 'J18'],
      sql: (c) => `MAX(CASE WHEN ${c.J11} = 12 THEN ${c.J18} END)`,
    },
    {
      as: 'excise_vat_other_taxes_item12', label: 'Total Products — Excise/VAT/Other Taxes (Rs.)',
      dependsOn: ['J11', 'J19'],
      sql: (c) => `MAX(CASE WHEN ${c.J11} = 12 THEN ${c.J19} END)`,
    },
    {
      as: 'other_distributive_expenses_item12', label: 'Total Products — Other Distributive Expenses (Rs.)',
      dependsOn: ['J11', 'J110'],
      sql: (c) => `MAX(CASE WHEN ${c.J11} = 12 THEN ${c.J110} END)`,
    },
    {
      as: 'subsidy_item12', label: 'Total Products — Subsidy (Rs.)',
      dependsOn: ['J11', 'J111'],
      sql: (c) => `MAX(CASE WHEN ${c.J11} = 12 THEN ${c.J111} END)`,
    },
    {
      as: 'ex_factory_value_item12', label: 'Total Products — Ex-Factory Value (Rs.)',
      dependsOn: ['J11', 'J113'],
      sql: (c) => `MAX(CASE WHEN ${c.J11} = 12 THEN ${c.J113} END)`,
    },
  ],
};
