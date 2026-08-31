// Labor-productivity/composition ratios — computed as SUM(numerator) /
// SUM(denominator) over whatever's grouped/filtered ("ratio of
// aggregates"), not a per-unit value averaged afterward. That distinction
// matters: an average of each unit's own ratio would let one tiny unit's
// extreme value skew the number, which is wrong for productivity/share
// metrics. See server/query/buildSql.js's buildRatioAggExpr, which is what
// actually evaluates these at query time (never baked into a view column,
// unlike the per-unit `sql`/`dependsOn` derived measures elsewhere in this
// directory).
//
// These four choices were confirmed directly rather than picked
// unilaterally — recorded here (not just the final pick) since the
// alternatives-considered reasoning doesn't live anywhere else durable:
//
// - Workforce base, used in all three measures below that need a
//   headcount: "Total Employees" (Block E code 10 — production workers +
//   supervisory/office staff + unpaid family members, the broadest ASI
//   headcount). Rejected: "Total Workers" (code 6, production workers
//   only — a narrower shop-floor productivity lens) and "Direct Workers"
//   (code 4, excludes contract workers too, narrower still).
// - Investment base for Employment per Crore: "Fixed Capital" (pc_03 —
//   net land/buildings/plant/machinery), the standard capital-intensity
//   denominator in labor economics. Rejected: "Invested Capital" (pc_06 —
//   Fixed Capital + Physical Working Capital), a broader capital base but
//   less standard for this specific ratio.
// - Labor Income % numerator: "Total Emoluments" (employee wages + bonus +
//   PF + welfare — the full cost of labor), not employee wages alone
//   (rejected as too narrow, ignores bonus/PF/welfare).
// - Labor Income % denominator: "Gross Value Added" (pc_19), the standard
//   base for a labor-share-of-value-added metric. Rejected: "Net Value
//   Added" (pc_21, i.e. after depreciation) — a defensible alternative,
//   just not the one picked.
module.exports = {
  appliesTo: 'unit_summary',
  measures: [
    {
      key: 'output_per_worker',
      label: 'Output per Worker (Rs.)',
      ratio: {
        numerator: (c) => c.pc_15_total_output,
        denominator: (c) => c.total_employees,
      },
    },
    {
      key: 'employment_per_crore_fixed_capital',
      label: 'Employment per ₹ Crore of Fixed Capital (persons)',
      ratio: {
        numerator: (c) => c.total_employees,
        denominator: (c) => c.pc_03_fixed_capital,
        scale: 1e7, // fixed capital is in Rs.; "per crore" = per 1e7 Rs.
      },
    },
    {
      key: 'labor_income_pct',
      label: 'Labor Income (% of GVA)',
      ratio: {
        numerator: (c) => `(${c.total_employee_wages} + ${c.bonus} + ${c.pf} + ${c.welfare})`,
        denominator: (c) => c.pc_19_gross_value_added,
        scale: 100,
      },
    },
    {
      key: 'women_workforce_share_pct',
      label: 'Women Workforce Share (%)',
      ratio: {
        numerator: (c) => c.female_direct_workers,
        denominator: (c) => c.total_employees,
        scale: 100,
      },
    },
  ],
};
