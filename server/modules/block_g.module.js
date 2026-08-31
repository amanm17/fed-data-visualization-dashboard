// ASI Block G — Other Output/Receipts. One row per (yr, dsl) for units
// that reported any (54,133 of 68,641 units have a row — the rest get
// COALESCEd to 0 for every measure when joined into unit_summary).
module.exports = {
  id: 'block_g',
  label: 'Block G — Other Output/Receipts',
  grain: 'unit',
  file: 'block_g.csv',
  idColumn: 'AG01',

  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    AG01: 'VARCHAR',
    G1: 'DOUBLE',
    G2: 'DOUBLE',
    G3: 'DOUBLE',
    G4: 'DOUBLE',
    G5: 'DOUBLE',
    G6: 'DOUBLE',
    G7: 'DOUBLE',
    G8: 'DOUBLE',
    G9: 'DOUBLE',
    G10: 'DOUBLE',
    G11: 'DOUBLE',
    G12: 'DOUBLE',
  },

  dimensions: [],

  measures: [
    { key: 'G1', label: 'Receipts from Manufacturing Services (Rs.)' },
    { key: 'G2', label: 'Receipts from Non-Manufacturing Services (Rs.)' },
    { key: 'G3', label: 'Value of Electricity Generated & Sold (Rs.)' },
    { key: 'G4', label: 'Value of Own Construction (Rs.)' },
    { key: 'G5', label: 'Net Balance — Goods Resold As-Is (Rs.)' },
    { key: 'G6', label: 'Rent Received — Plant & Machinery / Other Fixed Assets (Rs.)' },
    { key: 'G7', label: 'Variation in Stock of Semi-Finished Goods (Rs.)' },
    { key: 'G8', label: 'Rent Received — Buildings (Rs.)' },
    { key: 'G9', label: 'Rent Received — Land / Mining Royalties (Rs.)' },
    { key: 'G10', label: 'Interest Received (Rs.)' },
    { key: 'G11', label: 'Sale Value — Goods Resold As-Is (Rs.)' },
    { key: 'G12', label: 'Other Production Subsidies (Rs.)' },
  ],
};
