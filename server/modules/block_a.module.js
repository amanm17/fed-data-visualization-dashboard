// ASI Block A — Identification block. One row per (yr, dsl) — this is the
// "spine" module: every other module's mult-weighting and shared filter
// dimensions (state, sector, scheme...) are joined in from here.
const nic2008 = require('./data/nic2008_decode.json');

// Published 2-digit NIC-2008 industry groups (matches the official ASI
// "Principal Characteristics by Industry" table) — anything else buckets
// to "Other". Confirmed a5 is always exactly 5 chars in this data (no
// re-padding needed, unlike the source R script's defensive sprintf).
const PUBLISHED_NIC2 = ['01', '08', ...Array.from({ length: 24 }, (_, i) => String(10 + i)), '38', '58'];
const nic2InList = PUBLISHED_NIC2.map((code) => `'${code}'`).join(', ');

// Official ASI "List of codes used in ASI schedule" (Codelist24.pdf).
// Keys are zero-padded strings — a7 is VARCHAR ("01".."37"), not INTEGER,
// so a bare numeric key like `4` would never match the actual value "04".
const STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh (U.T.)',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur',
  15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal',
  20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  25: 'Dadra & Nagar Haveli and Daman & Diu', 27: 'Maharashtra', 28: 'Andhra Pradesh',
  29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu',
  34: 'Puducherry', 35: 'A and N Islands', 36: 'Telangana', 37: 'Ladakh',
};

const STATUS_OF_UNIT_CODES = {
  1: 'Open',
  2: 'Existing with fixed assets and maintaining staff but not having production',
  3: 'Existing with fixed assets but not maintaining staff and not having production',
  4: 'Deleted (incl. status 3 for 3+ years, de-registration, out of coverage, etc.)',
  5: 'Existing but non-response due to closure, owner/occupier not traceable',
  7: 'Non-response — production not yet started / accounting year not closed',
  8: 'Non-response — other reasons (court/income tax case, refused return, etc.)',
};

module.exports = {
  id: 'block_a',
  label: 'Block A — Identification',
  grain: 'unit',
  isSpine: true,
  file: 'block_a.csv',
  idColumn: 'a1',

  // Whitelist of raw columns this module is allowed to expose to SQL.
  // NOTE: read_csv's explicit `columns` map must list EVERY column in the
  // file (confirmed empirically — it's positional against the header, not
  // a subset filter), even ones never exposed as a dimension/measure below.
  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    a1: 'VARCHAR',
    a2: 'VARCHAR',
    a3: 'INTEGER',
    a4: 'VARCHAR',
    a5: 'VARCHAR',
    a7: 'VARCHAR',
    a8: 'VARCHAR',
    a9: 'INTEGER',
    a10: 'VARCHAR',
    a11: 'INTEGER',
    a12: 'INTEGER',
    bonus: 'DOUBLE',
    pf: 'DOUBLE',
    welfare: 'DOUBLE',
    mwdays: 'INTEGER',
    nwdays: 'INTEGER',
    wdays: 'INTEGER',
    costop: 'DOUBLE',
    expshare: 'DOUBLE',
    mult: 'DOUBLE',
  },

  dimensions: [
    { key: 'a7', label: 'State Code', filterable: true, decode: STATE_CODES },
    { key: 'a8', label: 'District Code', filterable: true }, // not in Codelist24.pdf — raw codes
    { key: 'a9', label: 'Sector', filterable: true, decode: { 1: 'Rural', 2: 'Urban' } },
    { key: 'a3', label: 'Scheme', filterable: true, decode: { 1: 'Census', 2: 'Sample' } },
    { key: 'a12', label: 'Status of Unit', filterable: true, decode: STATUS_OF_UNIT_CODES },
    { key: 'a4', label: 'Industry (NIC-2008, 4-digit)', filterable: false, decode: nic2008['4'] },
    { key: 'a5', label: 'Industry (NIC-2008, 5-digit)', filterable: true, decode: nic2008['5'] },
    { key: 'yr', label: 'Survey Year', filterable: true },
    {
      key: 'nic2_pub',
      label: 'Industry (NIC-2008, 2-digit, published grouping)',
      filterable: true,
      decode: nic2008['2'],
      derived: true,
      dependsOn: ['a5'],
      sql: (c) => `CASE WHEN substr(${c.a5}, 1, 2) IN (${nic2InList})
                   THEN substr(${c.a5}, 1, 2) ELSE 'Other' END`,
    },
  ],

  measures: [
    { key: 'bonus', label: 'Bonus (Rs.)' },
    { key: 'pf', label: 'Provident & Other Funds (Rs.)' },
    { key: 'welfare', label: 'Workmen & Staff Welfare Expenses (Rs.)' },
    { key: 'mwdays', label: 'Working Days (Manufacturing)' },
    { key: 'nwdays', label: 'Working Days (Non-Manufacturing)' },
    { key: 'wdays', label: 'Working Days (Total)' },
    { key: 'costop', label: 'Total Cost of Production (Rs.)' },
    { key: 'expshare', label: 'Share (%) of Products Directly Exported' },
    { key: 'a11', label: 'Number of Units (Sample Group Size)' },
  ],
};
