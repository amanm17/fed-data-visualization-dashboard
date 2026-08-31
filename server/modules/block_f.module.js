// ASI Block F — Other Expenses. One row per (yr, dsl) for units that
// reported any (58,862 of 68,641 units have a row — the rest get COALESCEd
// to 0 for every measure when joined into unit_summary).
module.exports = {
  id: 'block_f',
  label: 'Block F — Other Expenses',
  grain: 'unit',
  file: 'block_f.csv',
  idColumn: 'AF01',

  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    AF01: 'VARCHAR',
    F1: 'DOUBLE',
    F2A: 'DOUBLE',
    F2B: 'DOUBLE',
    F3: 'DOUBLE',
    F4: 'DOUBLE',
    F5: 'DOUBLE',
    F6: 'DOUBLE',
    F7: 'DOUBLE',
    F8: 'DOUBLE',
    F9: 'DOUBLE',
    F10: 'DOUBLE',
    F11: 'DOUBLE',
    F12: 'DOUBLE',
    F13: 'DOUBLE',
  },

  dimensions: [],

  measures: [
    { key: 'F1', label: 'Work Done by Others on Materials Supplied (Rs.)' },
    { key: 'F2A', label: 'Repair & Maintenance — Building & Construction (Rs.)' },
    { key: 'F2B', label: 'Repair & Maintenance — Other Fixed Assets (Rs.)' },
    { key: 'F3', label: 'Operating Expenses (Rs.)' },
    { key: 'F4', label: 'Raw Materials/Components for Own Construction (Rs.)' },
    { key: 'F5', label: 'Insurance Charges (Rs.)' },
    { key: 'F6', label: 'Rent Paid — Plant & Machinery / Other Fixed Assets (Rs.)' },
    { key: 'F7', label: 'Research & Development Expenses (Rs.)' },
    { key: 'F8', label: 'Rent Paid — Buildings (Rs.)' },
    { key: 'F9', label: 'Rent Paid — Land / Mining Royalties (Rs.)' },
    { key: 'F10', label: 'Interest Paid (Rs.)' },
    { key: 'F11', label: 'Purchase Value — Goods Resold As-Is (Rs.)' },
    { key: 'F12', label: 'Inward Transportation Cost (Rs.)' },
    { key: 'F13', label: 'Outward Transportation Cost (Rs.)' },
  ],
};
