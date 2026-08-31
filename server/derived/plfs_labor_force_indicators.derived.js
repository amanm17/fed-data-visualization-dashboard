// PLFS headline labor-force indicators — LFPR, Worker Population Ratio
// (WPR), and Unemployment Rate (UER), each computed two ways: "Usual
// Status" (principal + subsidiary activity combined, the standard MoSPI
// headline basis) and "Current Weekly Status" (CWS).
//
// Status codes CONFIRMED against MoSPI's official Schedule 10.4 (First
// Visit) instruction document ("Codes for Block 5.1" / "Codes for block
// 6"), not just assumed:
//   pas/sas: 11 own-account, 12 employer, 21 unpaid family worker,
//     31 regular salaried/wage, 41 casual-public-works, 51 casual-other
//     -> all EMPLOYED. 81 -> seeking/available for work -> UNEMPLOYED.
//     91-97 (attending education/domestic duties/rentier/disabled/other)
//     -> NOT IN LABOR FORCE.
//   acws (CWS): same base codes, PLUS 42 (casual, MGNREGA), 61/62 (has a
//     household-enterprise job, absent that day for sickness/other), 71/72
//     (has regular salaried job, absent for sickness/other), 82 (didn't
//     seek but available), 98 (casual worker, absent due to temporary
//     sickness) -> 61/62/71/72/98 count as EMPLOYED (they have a job, just
//     absent that day — same treatment as 41/51), 81/82 -> UNEMPLOYED.
// One residual gap: this confirms the *pre-2025* Schedule 10.4; CPERV1.txt
// is the post-July-2025 redesigned schedule, and that specific document
// wasn't available to re-confirm these codes carried over unchanged. Field
// widths/positions match exactly and nothing else in the redesign touched
// this block, so this is treated as reliable — flagged as CARRIED-OVER,
// NOT NEWLY VERIFIED for the redesigned schedule specifically.
//
// Usual Status (PS+SS): a person is employed if principal status (pas)
// shows work, OR principal status doesn't but subsidiary status (sas)
// does. Unemployed only if not employed by that rule AND pas is in the
// 80-89 "seeking work" range (a person who's principally 90+ "not in
// labor force" but has no subsidiary work either stays out of the labor
// force, not unemployed). All three rates restrict the population base to
// age >= 15, the standard PLFS reporting convention, implemented as a 0/1
// weight-indicator rather than a WHERE filter (ratio measures have no
// filter of their own — see CONTRIBUTING.md's ratio-measure section).
function inLaborForcePop(c) {
  return `(TRY_CAST(${c.age} AS DOUBLE) >= 15)`;
}
function psSsEmployed(c) {
  return `(TRY_CAST(${c.pas} AS INTEGER) < 80 OR TRY_CAST(${c.sas} AS INTEGER) < 80)`;
}
function psSsUnemployed(c) {
  return `(NOT (${psSsEmployed(c)}) AND TRY_CAST(${c.pas} AS INTEGER) BETWEEN 80 AND 89)`;
}
function psSsInLaborForce(c) {
  return `(${psSsEmployed(c)} OR ${psSsUnemployed(c)})`;
}
function cwsEmployed(c) {
  // < 80 covers 11/12/21/31/41/42/51/61/62/71/72; 98 (casual worker,
  // temporarily sick — has a job, just absent) is the one code outside
  // that range that still counts as employed, same as 61/62/71/72.
  return `(TRY_CAST(${c.acws} AS INTEGER) < 80 OR TRY_CAST(${c.acws} AS INTEGER) = 98)`;
}
function cwsUnemployed(c) {
  return `(TRY_CAST(${c.acws} AS INTEGER) BETWEEN 80 AND 89)`;
}
function cwsInLaborForce(c) {
  return `(${cwsEmployed(c)} OR ${cwsUnemployed(c)})`;
}
function indicator(expr) {
  return `CASE WHEN ${expr} THEN 1 ELSE 0 END`;
}
function popIndicator(c) {
  return indicator(inLaborForcePop(c));
}

module.exports = {
  appliesTo: 'plfs_person',
  measures: [
    {
      key: 'plfs_wpr_usual',
      label: 'Worker Population Ratio — Usual Status PS+SS, age 15+ (%)',
      ratio: {
        numerator: (c) => indicator(`${inLaborForcePop(c)} AND ${psSsEmployed(c)}`),
        denominator: (c) => popIndicator(c),
        scale: 100,
      },
    },
    {
      key: 'plfs_lfpr_usual',
      label: 'Labour Force Participation Rate — Usual Status PS+SS, age 15+ (%)',
      ratio: {
        numerator: (c) => indicator(`${inLaborForcePop(c)} AND ${psSsInLaborForce(c)}`),
        denominator: (c) => popIndicator(c),
        scale: 100,
      },
    },
    {
      key: 'plfs_uer_usual',
      label: 'Unemployment Rate — Usual Status PS+SS, age 15+ (%)',
      ratio: {
        numerator: (c) => indicator(`${inLaborForcePop(c)} AND ${psSsUnemployed(c)}`),
        denominator: (c) => indicator(`${inLaborForcePop(c)} AND ${psSsInLaborForce(c)}`),
        scale: 100,
      },
    },
    {
      key: 'plfs_wpr_cws',
      label: 'Worker Population Ratio — Current Weekly Status, age 15+ (%) [carried over from pre-2025 schedule]',
      ratio: {
        numerator: (c) => indicator(`${inLaborForcePop(c)} AND ${cwsEmployed(c)}`),
        denominator: (c) => popIndicator(c),
        scale: 100,
      },
    },
    {
      key: 'plfs_lfpr_cws',
      label: 'Labour Force Participation Rate — Current Weekly Status, age 15+ (%) [carried over from pre-2025 schedule]',
      ratio: {
        numerator: (c) => indicator(`${inLaborForcePop(c)} AND ${cwsInLaborForce(c)}`),
        denominator: (c) => popIndicator(c),
        scale: 100,
      },
    },
    {
      key: 'plfs_uer_cws',
      label: 'Unemployment Rate — Current Weekly Status, age 15+ (%) [carried over from pre-2025 schedule]',
      ratio: {
        numerator: (c) => indicator(`${inLaborForcePop(c)} AND ${cwsUnemployed(c)}`),
        denominator: (c) => indicator(`${inLaborForcePop(c)} AND ${cwsInLaborForce(c)}`),
        scale: 100,
      },
    },
  ],
};
