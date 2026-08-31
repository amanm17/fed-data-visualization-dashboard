// PLFS (Periodic Labour Force Survey) — person-level file, post-July-2025
// redesigned quarterly-panel schedule, visit 1 (CPERV1.txt). Standalone
// dataset: no relationship to the ASI spine at all (different survey,
// different sampling frame, no shared join key), so this module sets
// `standalone: true` to opt out of both the ASI unit_summary fold-in and
// the automatic ASI-spine weight join (see registry.js) — it carries its
// own multiplier (`mult`) and is queried entirely on its own view.
//
// Ingestion: CPERV1.txt is fixed-width text (byte positions from
// PLFS_Layout.csv), not real CSV — every actual field is read via
// `substr()` on one raw line column rather than DuckDB's normal per-column
// CSV typing. `csvOptions` below reads each line as a single VARCHAR using
// a delimiter byte (0x01) that never occurs in the data, with quoting
// disabled (fixed-width text isn't quoted CSV). Field byte positions come
// from server/modules/data/plfs_person_layout.js, generated once from the
// layout file (regenerate that file if the layout changes; don't hand-edit
// byte positions here).
//
// Confirmed empirically against a real decoded row (see conversation):
// records are exactly 371 bytes + CRLF, matching the layout's last byte
// position exactly. `mult` has an implied 2-decimal scale (confirmed: raw
// '119669' -> real weight 1196.69); `ern_reg`/`ern_self` are whole rupees,
// no implied decimal (confirmed by user).
//
// Curated exposure: 136 of the layout's 153 fields are exposed as
// dimensions/measures (the excluded 17 are sample-design/key metadata —
// file_id, sch, bstrm, strm, sstrm, sro, grp, mfsu, sss, ssu, srl, nsc,
// totalsd, zst, caph, smallh, panel — not meaningful chart axes). This
// file has no `yr` column and doesn't need one: the whole file is a single
// survey year: (multiple quarters are merged in via the `qtr`/`month`
// columns, but year itself is out of scope per user confirmation).
//
// idColumn is nominal only ('person_key' isn't a materialized column) —
// since this module is standalone, idColumn is never referenced in any
// generated SQL (grep-confirmed: registry.js/buildSql.js only use
// idColumn for spine/rollup joins, none of which apply here). The real
// per-row key is qtr+month+visit+st+dc+nss_reg+mfsu+sss+ssu+srl, all of
// which remain independently queryable/derivable from the raw line.
const layoutFields = require('./data/plfs_person_layout.js');
const nic2008 = require('./data/nic2008_decode.json');
const stateDecode = require('./data/plfs_state_decode.json');
const districtDecode = require('./data/plfs_district_decode.json');
// NCO-2004, 3-digit "Family" level — confirmed as the correct classification
// (not NCO-2015) directly from MoSPI's Schedule 10.4 instruction document:
// "occupation: 3-digit code as per NCO-2004." Transcribed from a public
// research-archive mirror of the same code list distributed with NSS/PLFS
// documentation (not the primary DGE site, which only hosts NCO-2015) —
// 507 codes, spot-checked against the schedule's own examples.
const nco2004Decode = require('./data/nco2004_decode.json');

// Delimiter guaranteed not to appear in fixed-width numeric/code data — the
// standard trick for reading whole lines as a single CSV column.
const NEVER_OCCURRING_SEP = '';

function nullTrimSubstr(lineRef, start, len) {
  return `NULLIF(TRIM(substr(${lineRef}, ${start}, ${len})), '')`;
}

function measureEntry(f) {
  return {
    key: f.key,
    label: f.label,
    derived: true,
    dependsOn: ['line'],
    sql: (c) => `TRY_CAST(${nullTrimSubstr(c.line, f.start, f.len)} AS DOUBLE)`,
  };
}

// Dimensions still fully chartable (X/Y axis, highlights) even when not
// filterable — this only controls whether they get a filter checkbox box.
// With 85 dimensions, rendering a box for every one made the filter panel
// unnavigable (vs. ~9 for a typical ASI block). These are the ones judged
// rarely useful as a top-level filter: the 7-day daily activity calendar's
// per-day-per-activity status/industry codes (28 fields — nobody filters
// by "status on day 3, activity 2"), vocational-training/education-detail
// sub-fields (14), and principal/subsidiary job-characteristic detail
// fields plus unemployment-reason detail (22) — the headline fields next
// to each of these (pas/sas/acws, ind_pas/ind_sas, has_sas, gedu_lvl, etc.)
// stay filterable.
const NOT_FILTERABLE = new Set([
  ...layoutFields.filter((f) => /^(das|ind)\d\d$/.test(f.key)).map((f) => f.key),
  'tedu_lvl', 'grade', 'iflastyr', 'curr_att', 'secondary',
  'voc', 'trg', 'trg_com', 'voc_compl', 'voc_fld', 'voc_dur', 'voc_typ', 'voc_fund', 'voc_cert',
  'loc_pas', 'etyp_pas', 'wrkr_pas', 'job_pas', 'leave_pas', 'ssec_pas', 'ecoprd_pas',
  'loc_sas', 'etyp_sas', 'wrkr_sas', 'job_sas', 'leave_sas', 'ssec_sas', 'ecoprd_sas',
  'wrk_365', 'dur_pas', 'dur_sas', 'eff_pas', 'dur_unp', 'evr_wrk', 'rea_nw', 'rea',
]);

function dimensionEntry(f, decode) {
  return {
    key: f.key,
    label: f.label,
    derived: true,
    dependsOn: ['line'],
    filterable: !NOT_FILTERABLE.has(f.key),
    sql: (c) => nullTrimSubstr(c.line, f.start, f.len),
    ...(decode ? { decode } : {}),
  };
}

const stField = layoutFields.find((f) => f.key === 'st');
const dcField = layoutFields.find((f) => f.key === 'dc');
const ageField = layoutFields.find((f) => f.key === 'age');

const dimensions = [];
const measures = [];

for (const f of layoutFields) {
  if (f.kind === 'measure') {
    if (f.key === 'mult') {
      // Implied 2-decimal scale — confirmed against real data (see header).
      measures.push({
        ...measureEntry(f),
        sql: (c) => `TRY_CAST(${nullTrimSubstr(c.line, f.start, f.len)} AS DOUBLE) / 100`,
      });
    } else {
      measures.push(measureEntry(f));
    }
    continue;
  }

  let decode;
  if (f.key === 'st') decode = stateDecode;
  else if (f.key === 'sec') decode = { 1: 'Rural', 2: 'Urban' }; // universal NSS-family convention
  else if (f.key === 'ind_pas' || f.key === 'ind_sas') decode = nic2008['5'];
  else if (f.key === 'aind_cws' || /^ind\d\d$/.test(f.key)) decode = nic2008['2'];
  else if (f.key === 'ocu_pas' || f.key === 'ocu_sas' || f.key === 'ocu_cws') decode = nco2004Decode;
  dimensions.push(dimensionEntry(f, decode));
}

// Raw `dc` alone repeats across states (NSS district serials are only
// unique *within* a state — confirmed against the 771-row official code
// list, which has no globally-unique district code), so decoding needs the
// combined state+district code as the lookup key. `dc` itself stays
// available undecoded above for anyone who wants the bare code.
dimensions.push({
  key: 'district',
  label: 'District',
  derived: true,
  dependsOn: ['line'],
  filterable: true,
  sql: (c) => `${nullTrimSubstr(c.line, stField.start, stField.len)} || ${nullTrimSubstr(c.line, dcField.start, dcField.len)}`,
  decode: districtDecode,
});

// Standard PLFS reporting age bands.
dimensions.push({
  key: 'age_group',
  label: 'Age Group',
  derived: true,
  dependsOn: ['line'],
  filterable: true,
  sql: (c) => {
    const age = `TRY_CAST(${nullTrimSubstr(c.line, ageField.start, ageField.len)} AS DOUBLE)`;
    return `CASE
      WHEN ${age} IS NULL THEN NULL
      WHEN ${age} < 15 THEN '0-14'
      WHEN ${age} < 30 THEN '15-29'
      WHEN ${age} < 45 THEN '30-44'
      WHEN ${age} < 60 THEN '45-59'
      ELSE '60+'
    END`;
  },
});

module.exports = {
  id: 'plfs_person',
  label: 'PLFS Person-Level (Visit 1)',
  grain: 'unit', // one row per person already — no rollup needed (see header)
  standalone: true,
  file: 'CPERV1.txt',
  idColumn: 'person_key', // nominal only — see header comment

  csvOptions: {
    header: false,
    sep: NEVER_OCCURRING_SEP,
    quote: '',
  },

  columns: {
    line: 'VARCHAR',
  },

  weight: { column: 'mult' },

  dimensions,
  measures,
};
