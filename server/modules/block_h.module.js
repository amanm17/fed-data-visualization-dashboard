// ASI Block H — Indigenous Items Consumed. Item-grain: a mix of sparse
// commodity-item rows (HI1 1-11ish, one per distinct item the unit
// reported, via NPCMS code HI3) plus fixed summary rows appended at known
// codes (12-23) — e.g. code 23 is already a pre-computed grand total.
// Confirmed empirically (HI1 has 161 distinct values; codes 12/16/17/21-23
// are near-universal, matching "always-present summary row" behavior).
// Rollup entries pivot the named summary codes, matching the source R
// script's `H_summary` exactly. Item rows (1-11, 24+) are left raw — they
// vary per unit's actual reported commodities.
const UNIT_OF_QUANTITY_CODES = require('./data/unit_of_quantity_codes');

module.exports = {
  id: 'block_h',
  label: 'Block H — Indigenous Inputs Consumed',
  grain: 'item',
  file: 'block_h.csv',
  idColumn: 'AH01',

  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    AH01: 'VARCHAR',
    HI1: 'INTEGER',
    HI3: 'VARCHAR',
    HI4: 'INTEGER',
    HI5: 'DOUBLE',
    HI6: 'DOUBLE',
    HI7: 'DOUBLE',
  },

  dimensions: [
    {
      key: 'HI1', label: 'Row Code (Item Serial / Summary Row)', filterable: false,
      decode: {
        12: 'Basic Items (Total)', 13: 'Non-Basic Chemicals', 14: 'Packing Items',
        15: 'Electricity — Own Generated', 16: 'Electricity — Purchased',
        17: 'Petrol/Diesel/Oil/Lubricants', 18: 'Coal', 19: 'Gas', 20: 'Other Fuel',
        21: 'Consumable Stores', 22: 'Non-Basic Items (Total)', 23: 'Total Indigenous Inputs',
      },
    },
    { key: 'HI3', label: 'Item Code (NPCMS)', filterable: false },
    { key: 'HI4', label: 'Unit of Quantity', filterable: true, decode: UNIT_OF_QUANTITY_CODES },
  ],

  measures: [
    { key: 'HI5', label: 'Quantity Consumed' },
    { key: 'HI6', label: 'Purchase Value (Rs.)' },
    { key: 'HI7', label: 'Rate per Unit (Rs.)' },
  ],

  rollup: (() => {
    const codes = [
      [12, 'h12_basic_items', 'Basic Items (Total)'],
      [13, 'h13_non_basic_chemicals', 'Non-Basic Chemicals'],
      [14, 'h14_packing_items', 'Packing Items'],
      [15, 'h15_electricity_own_generated', 'Electricity — Own Generated'],
      [16, 'h16_electricity_purchased', 'Electricity — Purchased'],
      [17, 'h17_petrol_diesel_oil_lubricants', 'Petrol/Diesel/Oil/Lubricants'],
      [18, 'h18_coal', 'Coal'],
      [19, 'h19_gas', 'Gas'],
      [20, 'h20_other_fuel', 'Other Fuel'],
      [21, 'h21_consumable_store', 'Consumable Stores'],
    ];
    const entries = codes.map(([code, key, label]) => ({
      as: key, label: `${label} — Purchase Value (Rs.)`,
      dependsOn: ['HI1', 'HI6'],
      sql: (c) => `MAX(CASE WHEN ${c.HI1} = ${code} THEN ${c.HI6} END)`,
    }));
    entries.push(
      {
        // Same value/code as h12_basic_items — the R script defines both
        // names, and pc_17 (materials consumed) references h12_basic_items
        // specifically, so both are kept for parity.
        as: 'indigenous_basic_inputs', label: 'Basic Items (Total) — Purchase Value (Rs.)',
        dependsOn: ['HI1', 'HI6'],
        sql: (c) => `MAX(CASE WHEN ${c.HI1} = 12 THEN ${c.HI6} END)`,
      },
      {
        as: 'indigenous_non_basic_inputs', label: 'Non-Basic Items (Total) — Purchase Value (Rs.)',
        dependsOn: ['HI1', 'HI6'],
        sql: (c) => `MAX(CASE WHEN ${c.HI1} = 22 THEN ${c.HI6} END)`,
      },
      {
        as: 'indigenous_total_inputs', label: 'Total Indigenous Inputs — Purchase Value (Rs.)',
        dependsOn: ['HI1', 'HI6'],
        sql: (c) => `MAX(CASE WHEN ${c.HI1} = 23 THEN ${c.HI6} END)`,
      },
    );
    return entries;
  })(),
};
