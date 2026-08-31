// ASI Block B — Owner Details. One row per (yr, dsl) — unit-grain, joins
// directly onto the spine, no rollup needed.
module.exports = {
  id: 'block_b',
  label: 'Block B — Owner Details',
  grain: 'unit',
  file: 'block_b.csv',
  idColumn: 'ab01',

  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    ab01: 'VARCHAR',
    b02: 'INTEGER',
    b03: 'VARCHAR', // CIN — often a placeholder of all-9s, not used
    b04: 'INTEGER',
    b05: 'INTEGER',
    b06f: 'VARCHAR',
    b06t: 'VARCHAR',
    b07: 'INTEGER',
    b08: 'INTEGER',
    b09: 'INTEGER',
    b11: 'INTEGER',
  },

  dimensions: [
    {
      key: 'b02', label: 'Type of Organisation', filterable: true,
      decode: {
        1: 'Individual Proprietorship', 2: 'Partnership', 3: 'Limited Liability Partnership',
        4: 'Government Company - Public', 5: 'Government Company - Private',
        6: 'Non-Government Company - Public', 7: 'Non-Government Company - Private',
        8: 'Co-operative Society', 9: 'Others (HUF, Trusts, Wakf Boards, Handlooms, KVIC, etc.)',
      },
    },
    { key: 'b04', label: 'ISO Certification (14000 Series)?', filterable: true, decode: { 1: 'Yes', 2: 'No' } },
    { key: 'b08', label: 'Foreign Share in Capital?', filterable: true, decode: { 1: 'Yes', 2: 'No' } },
    {
      key: 'b09', label: 'R&D Unit?', filterable: true,
      decode: { 1: 'Yes, registered with DST/DBT', 2: 'Yes, registered with others', 3: 'No' },
    },
    { key: 'b11', label: 'Offered Formal Training?', filterable: true, decode: { 1: 'Yes', 2: 'No' } },
  ],

  measures: [
    { key: 'b05', label: 'Year of Initial Production' },
    { key: 'b07', label: 'Number of Months of Operation' },
  ],
};
