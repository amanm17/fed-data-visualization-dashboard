// ASI Block E — Employment and Labour Cost. Item-grain: exactly 10 fixed
// worker-category rows per unit (confirmed empirically — EI1 takes only
// values 1-10). Rollup entries pivot each category into a named unit-level
// column, matching the source R script's `E_summary` exactly.
module.exports = {
  id: 'block_e',
  label: 'Block E — Employment & Labour Cost',
  grain: 'item',
  file: 'block_e.csv',
  idColumn: 'AE01',

  columns: {
    yr: 'INTEGER',
    blk: 'VARCHAR',
    AE01: 'VARCHAR',
    EI1: 'INTEGER',
    EI3: 'INTEGER',
    EI4: 'INTEGER',
    EI5: 'INTEGER',
    EI6: 'INTEGER',
    EI7: 'INTEGER',
    EI8: 'DOUBLE',
  },

  dimensions: [
    {
      key: 'EI1', label: 'Worker Category Code', filterable: true,
      decode: {
        1: 'Male Direct Workers', 2: 'Female Direct Workers', 3: 'Transgender Direct Workers',
        4: 'Direct Workers (Total)', 5: 'Contract Workers', 6: 'Total Workers',
        7: 'Supervisory Staff', 8: 'Other Employees', 9: 'Unpaid Family Members',
        10: 'Total Employees',
      },
    },
  ],

  measures: [
    { key: 'EI3', label: 'Mandays Worked — Manufacturing' },
    { key: 'EI4', label: 'Mandays Worked — Non-Manufacturing' },
    { key: 'EI5', label: 'Mandays Worked — Total' },
    { key: 'EI6', label: 'Average Number of Persons Worked' },
    { key: 'EI7', label: 'Number of Mandays Paid For' },
    { key: 'EI8', label: 'Wages/Salaries (Rs.)' },
  ],

  rollup: (() => {
    const categories = [
      [1, 'male_direct_workers', 'Male Direct Workers'],
      [2, 'female_direct_workers', 'Female Direct Workers'],
      [3, 'transgender_direct_workers', 'Transgender Direct Workers'],
      [4, 'direct_workers', 'Direct Workers (Total)'],
      [5, 'contract_workers', 'Contract Workers'],
      [6, 'total_workers', 'Total Workers'],
      [7, 'supervisory_staff', 'Supervisory Staff'],
      [8, 'other_employees', 'Other Employees'],
      [9, 'unpaid_family_members', 'Unpaid Family Members'],
      [10, 'total_employees', 'Total Employees'],
    ];
    const entries = categories.map(([code, key, label]) => ({
      as: key, label: `${label} — Average Persons Worked`,
      dependsOn: ['EI1', 'EI6'],
      sql: (c) => `MAX(CASE WHEN ${c.EI1} = ${code} THEN ${c.EI6} END)`,
    }));
    entries.push(
      {
        as: 'total_worker_wages', label: 'Total Workers — Wages/Salaries (Rs.)',
        dependsOn: ['EI1', 'EI8'],
        sql: (c) => `MAX(CASE WHEN ${c.EI1} = 6 THEN ${c.EI8} END)`,
      },
      {
        as: 'total_employee_wages', label: 'Total Employees — Wages/Salaries (Rs.)',
        dependsOn: ['EI1', 'EI8'],
        sql: (c) => `MAX(CASE WHEN ${c.EI1} = 10 THEN ${c.EI8} END)`,
      },
      {
        as: 'total_worker_mandays', label: 'Total Workers — Mandays Worked (Total)',
        dependsOn: ['EI1', 'EI5'],
        sql: (c) => `MAX(CASE WHEN ${c.EI1} = 6 THEN ${c.EI5} END)`,
      },
      {
        as: 'total_employee_mandays', label: 'Total Employees — Mandays Worked (Total)',
        dependsOn: ['EI1', 'EI5'],
        sql: (c) => `MAX(CASE WHEN ${c.EI1} = 10 THEN ${c.EI5} END)`,
      },
      {
        as: 'unpaid_family_mandays', label: 'Unpaid Family Members — Mandays Worked (Total)',
        dependsOn: ['EI1', 'EI5'],
        sql: (c) => `MAX(CASE WHEN ${c.EI1} = 9 THEN ${c.EI5} END)`,
      },
    );
    return entries;
  })(),
};
