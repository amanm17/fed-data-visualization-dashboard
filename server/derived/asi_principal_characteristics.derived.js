// The 27 official ASI "Principal Characteristics" (GVA, NVA, fixed capital
// formation, net profit, etc.) — cross-block formulas computed on the
// already-rolled-up unit grain (server/query/registry.js's unit_summary
// view), transcribed directly from the source R script's
// `factory[, pc_NN_... := ...]` block. Several depend on each other (e.g.
// pc_27 -> pc_26 -> pc_21 -> pc_19/pc_20) — deriveChain.js resolves the
// order automatically, so these can be listed in any order.
//
// dependsOn naming, per registry.js's conventions:
//  - spine (Block A) columns: bare key (e.g. `costop`, `bonus`, `a11`)
//  - unit-grain non-spine modules (B/F/G): `<moduleId>__<columnKey>`
//  - item-grain rollups (C/D/E/H/I/J): the rollup entry's own `as` alias
//
// Three things transcribed exactly as the R script has them, flagged in
// case any is a mistake in the source rather than intended (matching the
// source of truth given, not silently "fixing" what might be domain
// judgment):
//  - pc_11 uses Block G's G9 (rent received for land/mining royalties),
//    not G6 (rent received for plant & machinery), which its label implies.
//  - pc_18 (total inputs) excludes Block F's F5/F9/F10/F12/F13 (insurance,
//    rent for land, interest paid, transport) — only F1/F2A/F2B/F3/F4/F6/
//    F7/F8/F11 are summed.
//  - Block H's rollup defines both `h12_basic_items` and
//    `indigenous_basic_inputs` from the same code (12) — pc_17 references
//    `h12_basic_items` specifically.
module.exports = {
  appliesTo: 'unit_summary',
  measures: [
    {
      key: 'pc_01_number_of_factories', label: '1. Number of Factories (no.)',
      dependsOn: ['a11'], sql: (c) => c.a11,
    },
    {
      key: 'pc_02_factories_in_operation', label: '2. Factories in Operation (no.)',
      dependsOn: ['a12', 'a11'],
      sql: (c) => `CASE WHEN ${c.a12} IN (1,2,3) THEN ${c.a11} ELSE 0 END`,
    },
    {
      key: 'pc_03_fixed_capital', label: '3. Fixed Capital (Rs.)',
      dependsOn: ['fixed_assets_net_closing'], sql: (c) => c.fixed_assets_net_closing,
    },
    {
      key: 'pc_04_physical_working_capital', label: '4. Physical Working Capital (Rs.)',
      dependsOn: ['total_inventory_closing'], sql: (c) => c.total_inventory_closing,
    },
    {
      key: 'pc_05_working_capital', label: '5. Working Capital (Rs.)',
      dependsOn: ['working_capital'], sql: (c) => c.working_capital,
    },
    {
      key: 'pc_06_invested_capital', label: '6. Invested Capital (Rs.)',
      dependsOn: ['pc_03_fixed_capital', 'pc_04_physical_working_capital'],
      sql: (c) => `(${c.pc_03_fixed_capital} + ${c.pc_04_physical_working_capital})`,
    },
    {
      key: 'pc_07_gross_value_addition_fixed_capital', label: '7. Gross Value of Addition to Fixed Capital (Rs.)',
      dependsOn: ['actual_addition_fixed_assets'], sql: (c) => c.actual_addition_fixed_assets,
    },
    {
      key: 'pc_08_rent_paid_fixed_assets', label: '8. Rent Paid for Fixed Assets (Rs.)',
      dependsOn: ['block_f__F9'], sql: (c) => c.block_f__F9,
    },
    {
      key: 'pc_09_outstanding_loan', label: '9. Outstanding Loan (Rs.)',
      dependsOn: ['outstanding_loans'], sql: (c) => c.outstanding_loans,
    },
    {
      key: 'pc_10_interest_paid', label: '10. Interest Paid (Rs.)',
      dependsOn: ['block_f__F10'], sql: (c) => c.block_f__F10,
    },
    {
      key: 'pc_11_rent_received_fixed_assets', label: '11. Rent Received for Fixed Assets (Rs.)',
      dependsOn: ['block_g__G9'], sql: (c) => c.block_g__G9,
    },
    {
      key: 'pc_12_interest_received', label: '12. Interest Received (Rs.)',
      dependsOn: ['block_g__G10'], sql: (c) => c.block_g__G10,
    },
    {
      key: 'pc_13_gross_value_plant_machinery', label: '13. Gross Value of Plant & Machinery (Rs.)',
      dependsOn: ['plant_machinery_gross_closing'], sql: (c) => c.plant_machinery_gross_closing,
    },
    {
      key: 'pc_14_value_product_byproduct', label: '14. Value of Product and By-Product (Rs.)',
      dependsOn: ['ex_factory_value_item12'], sql: (c) => c.ex_factory_value_item12,
    },
    {
      key: 'pc_15_total_output', label: '15. Total Output (Rs.)',
      dependsOn: [
        'ex_factory_value_item12', 'block_g__G1', 'block_g__G2', 'block_g__G3', 'block_g__G4',
        'block_g__G6', 'block_g__G7', 'block_g__G8', 'block_g__G11', 'block_f__F7',
      ],
      sql: (c) => `(${c.ex_factory_value_item12} + ${c.block_g__G1} + ${c.block_g__G2} + ${c.block_g__G3}
                   + ${c.block_g__G4} + ${c.block_g__G6} + ${c.block_g__G7} + ${c.block_g__G8}
                   + ${c.block_g__G11} + ${c.block_f__F7})`,
    },
    {
      key: 'pc_16_fuels_consumed', label: '16. Fuels Consumed (Rs.)',
      dependsOn: [
        'h15_electricity_own_generated', 'h16_electricity_purchased',
        'h17_petrol_diesel_oil_lubricants', 'h18_coal', 'h19_gas', 'h20_other_fuel',
      ],
      sql: (c) => `(${c.h15_electricity_own_generated} + ${c.h16_electricity_purchased}
                   + ${c.h17_petrol_diesel_oil_lubricants} + ${c.h18_coal} + ${c.h19_gas}
                   + ${c.h20_other_fuel})`,
    },
    {
      key: 'pc_17_materials_consumed', label: '17. Materials Consumed (Rs.)',
      dependsOn: ['h12_basic_items', 'h13_non_basic_chemicals', 'h14_packing_items', 'h21_consumable_store', 'imported_total_inputs'],
      sql: (c) => `(${c.h12_basic_items} + ${c.h13_non_basic_chemicals} + ${c.h14_packing_items}
                   + ${c.h21_consumable_store} + ${c.imported_total_inputs})`,
    },
    {
      key: 'pc_18_total_inputs', label: '18. Total Inputs (Rs.)',
      dependsOn: [
        'block_f__F1', 'block_f__F2A', 'block_f__F2B', 'block_f__F3', 'block_f__F4',
        'block_f__F6', 'block_f__F7', 'block_f__F8', 'block_f__F11',
        'indigenous_total_inputs', 'imported_total_inputs',
      ],
      sql: (c) => `(${c.block_f__F1} + ${c.block_f__F2A} + ${c.block_f__F2B} + ${c.block_f__F3}
                   + ${c.block_f__F4} + ${c.block_f__F6} + ${c.block_f__F7} + ${c.block_f__F8}
                   + ${c.block_f__F11} + ${c.indigenous_total_inputs} + ${c.imported_total_inputs})`,
    },
    {
      key: 'pc_19_gross_value_added', label: '19. Gross Value Added (Rs.)',
      dependsOn: ['pc_15_total_output', 'pc_18_total_inputs'],
      sql: (c) => `(${c.pc_15_total_output} - ${c.pc_18_total_inputs})`,
    },
    {
      key: 'pc_20_depreciation', label: '20. Depreciation (Rs.)',
      dependsOn: ['depreciation_annexure'], sql: (c) => c.depreciation_annexure,
    },
    {
      key: 'pc_21_net_value_added', label: '21. Net Value Added (Rs.)',
      dependsOn: ['pc_19_gross_value_added', 'pc_20_depreciation'],
      sql: (c) => `(${c.pc_19_gross_value_added} - ${c.pc_20_depreciation})`,
    },
    {
      key: 'pc_22_net_fixed_capital_formation', label: '22. Net Fixed Capital Formation (Rs.)',
      dependsOn: ['nfcf_without_f7', 'block_f__F7'],
      sql: (c) => `(${c.nfcf_without_f7} + ${c.block_f__F7})`,
    },
    {
      key: 'pc_23_gross_fixed_capital_formation', label: '23. Gross Fixed Capital Formation (Rs.)',
      dependsOn: ['pc_22_net_fixed_capital_formation', 'pc_20_depreciation'],
      sql: (c) => `(${c.pc_22_net_fixed_capital_formation} + ${c.pc_20_depreciation})`,
    },
    {
      key: 'pc_24a_addition_stock_materials_fuels', label: '24(a). Addition in Stock — Materials, Fuels etc. (Rs.)',
      dependsOn: ['materials_fuels_stores_closing', 'materials_fuels_stores_opening'],
      sql: (c) => `(${c.materials_fuels_stores_closing} - ${c.materials_fuels_stores_opening})`,
    },
    {
      key: 'pc_24b_addition_stock_semi_finished', label: '24(b). Addition in Stock — Semi Finished Goods (Rs.)',
      dependsOn: ['semi_finished_closing', 'semi_finished_opening'],
      sql: (c) => `(${c.semi_finished_closing} - ${c.semi_finished_opening})`,
    },
    {
      key: 'pc_24c_addition_stock_finished_goods', label: '24(c). Addition in Stock — Finished Goods (Rs.)',
      dependsOn: ['finished_goods_closing', 'finished_goods_opening'],
      sql: (c) => `(${c.finished_goods_closing} - ${c.finished_goods_opening})`,
    },
    {
      key: 'pc_24_addition_in_stock', label: '24. Addition in Stock (Rs.)',
      dependsOn: ['pc_24a_addition_stock_materials_fuels', 'pc_24b_addition_stock_semi_finished', 'pc_24c_addition_stock_finished_goods'],
      sql: (c) => `(${c.pc_24a_addition_stock_materials_fuels} + ${c.pc_24b_addition_stock_semi_finished}
                   + ${c.pc_24c_addition_stock_finished_goods})`,
    },
    {
      key: 'pc_25_gross_capital_formation', label: '25. Gross Capital Formation (Rs.)',
      dependsOn: ['pc_23_gross_fixed_capital_formation', 'pc_24_addition_in_stock'],
      sql: (c) => `(${c.pc_23_gross_fixed_capital_formation} + ${c.pc_24_addition_in_stock})`,
    },
    {
      key: 'pc_26_net_income', label: '26. Net Income (Rs.)',
      dependsOn: ['pc_21_net_value_added', 'block_f__F9', 'block_f__F10'],
      sql: (c) => `(${c.pc_21_net_value_added} - ${c.block_f__F9} - ${c.block_f__F10})`,
    },
    {
      key: 'pc_27_net_profit', label: '27. Net Profit (Rs.)',
      dependsOn: ['pc_26_net_income', 'total_employee_wages', 'bonus', 'pf', 'welfare'],
      sql: (c) => `(${c.pc_26_net_income} - ${c.total_employee_wages} - ${c.bonus} - ${c.pf} - ${c.welfare})`,
    },
  ],
};
