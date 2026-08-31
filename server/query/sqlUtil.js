// Tiny shared SQL-string helpers. Split out from registry.js so
// deriveChain.js can use them without a circular require.
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqlLiteral(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

module.exports = { quoteIdent, sqlLiteral };
