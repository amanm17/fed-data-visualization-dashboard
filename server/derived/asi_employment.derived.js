// "Total Persons Engaged" — a standard ASI concept (MoSPI's own ASI
// methodology write-up defines it as Employees + unpaid working
// proprietors/family members/co-operative members), but not one of the 27
// numbered "Principal Characteristics" in
// asi_principal_characteristics.derived.js, so it gets its own small file
// rather than becoming an unnumbered 28th entry there.
//
// Computed the same way MoSPI itself derives an average headcount from raw
// survey responses — "the number of persons... is an average number
// obtained by dividing mandays worked by the number of days the factory
// had worked during the reference year" — rather than by summing the
// already-averaged per-category headcount rollups (`total_employees` +
// `unpaid_family_members`) block_e.module.js also exposes. Confirmed with
// the user directly: this mandays/working-days formula is the one wanted.
//
// This is a plain per-unit measure baked into the view, like the 27 PC
// measures — NOT a `ratio` measure like asi_productivity_ratios.derived.js.
// A `ratio` entry would compute SUM(mandays)/SUM(wdays) across every unit
// in a chart's GROUP BY, which is a different (aggregate-level) quantity;
// what's wanted here is each unit's own average headcount, computed once
// per unit, which can then be summed/weighted-summed/averaged across
// chart dimensions exactly like any other measure.
module.exports = {
  appliesTo: 'unit_summary',
  measures: [
    {
      key: 'total_persons_engaged',
      label: 'Total Persons Engaged',
      dependsOn: ['total_employee_mandays', 'unpaid_family_mandays', 'wdays'],
      // CAST ... AS DOUBLE so integer/integer division isn't truncated;
      // NULLIF guards a unit that reported zero working days (yields NULL,
      // excluded from charts/aggregates, rather than a divide-by-zero error).
      sql: (c) => `(CAST(${c.total_employee_mandays} AS DOUBLE) + ${c.unpaid_family_mandays}) / NULLIF(${c.wdays}, 0)`,
    },
  ],
};
