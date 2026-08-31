#!/usr/bin/env node
// Idempotent data-provisioning step for deployment. Run automatically
// before the server starts (see package.json's `prestart`/`predev`) —
// checks whether the ASI/PLFS data files are already present in
// ASI_DATA_DIR and, only if something's missing, downloads and unpacks a
// zip archive from DATA_ARCHIVE_URL. Safe to run on every boot: once the
// files are there (e.g. on a Render persistent disk), this is a cheap
// no-op, not a re-download.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ASI_DATA_DIR || path.join(__dirname, '..', 'data');
const ARCHIVE_URL = process.env.DATA_ARCHIVE_URL;

// Every file server/query/registry.js actually reads at startup/query time.
// PLFS_Layout.csv is NOT here — it's only used once, offline, to generate
// server/modules/data/plfs_person_layout.js, which is already committed.
const REQUIRED_FILES = [
  'CPERV1.txt',
  'block_a.csv', 'block_b.csv', 'block_c.csv', 'block_d.csv', 'block_e.csv',
  'block_f.csv', 'block_g.csv', 'block_h.csv', 'block_i.csv', 'block_j.csv',
];

function missingFiles() {
  return REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(DATA_DIR, f)));
}

function main() {
  const missing = missingFiles();
  if (missing.length === 0) {
    console.log('[ensure-data] all required data files already present, skipping download.');
    return;
  }

  if (!ARCHIVE_URL) {
    console.error(`[ensure-data] missing data file(s): ${missing.join(', ')}`);
    console.error(`[ensure-data] set DATA_ARCHIVE_URL to a direct-download link for a zip containing them, or place the files in ${DATA_DIR} manually. See DEPLOY.md.`);
    process.exit(1);
  }

  console.log(`[ensure-data] ${missing.length} file(s) missing (${missing.join(', ')}) — downloading archive...`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpZip = path.join(DATA_DIR, '__data_archive.zip');

  try {
    execSync(`curl -L --fail -o "${tmpZip}" "${ARCHIVE_URL}"`, { stdio: 'inherit' });
    execSync(`unzip -o "${tmpZip}" -d "${DATA_DIR}"`, { stdio: 'inherit' });
  } finally {
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
  }

  const stillMissing = missingFiles();
  if (stillMissing.length > 0) {
    console.error(`[ensure-data] after extracting the archive, still missing: ${stillMissing.join(', ')}`);
    console.error('[ensure-data] check that the zip has these files at its top level, not inside a subfolder.');
    process.exit(1);
  }
  console.log('[ensure-data] all required data files present.');
}

main();
