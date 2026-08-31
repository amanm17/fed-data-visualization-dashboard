// Turns an already-validated query request into parameterized SQL.
// Column/table identifiers here only ever come from the matched registry
// entry (validate.js already confirmed the key exists in that dataset's
// whitelist) — filter *values* are always bound as prepared-statement
// parameters, never concatenated into the SQL string.
const { quoteIdent } = require('./registry');

// Same raw/weighted aggregation switch as always, but taking an arbitrary
// SQL expression instead of assuming a bare column — this is what lets
// ratio measures (below) reuse it for each side of a division.
function buildAggExprFromSql(exprSql, agg, weighted, weightExpr) {
  if (!weighted) {
    switch (agg) {
      case 'sum': return `SUM(${exprSql})`;
      case 'avg': return `AVG(${exprSql})`;
      case 'count': return `COUNT(*)`;
      case 'min': return `MIN(${exprSql})`;
      case 'max': return `MAX(${exprSql})`;
      default: throw new Error(`unreachable agg "${agg}"`);
    }
  }
  switch (agg) {
    case 'sum': return `SUM(${exprSql} * ${weightExpr})`;
    // Weighted average = sum(value*mult)/sum(mult), NOT avg of pre-weighted rows.
    case 'avg': return `SUM(${exprSql} * ${weightExpr}) / NULLIF(SUM(${weightExpr}), 0)`;
    case 'count': return `SUM(${weightExpr})`;
    // Weighting a min/max isn't meaningful — pass through unweighted.
    case 'min': return `MIN(${exprSql})`;
    case 'max': return `MAX(${exprSql})`;
    default: throw new Error(`unreachable agg "${agg}"`);
  }
}

function buildAggExpr(yKey, agg, weighted, weightExpr) {
  return buildAggExprFromSql(quoteIdent(yKey), agg, weighted, weightExpr);
}

// Ratio measures (e.g. Output per Worker) are SUM(numerator)/SUM(denominator)
// — a "ratio of aggregates," not a per-unit value that gets aggregated like
// every other measure. Confirmed deliberately: an average of each unit's own
// ratio would let one tiny unit's extreme value skew the result. Both sides
// always SUM (raw or weighted) regardless of the requested `agg` — picking
// "avg"/"count"/etc for a ratio measure wouldn't mean anything coherent, so
// the frontend disables the Aggregation control whenever one is selected.
function buildRatioAggExpr(ratio, weighted, weightExpr) {
  // `c` turns any property access into a quoted column reference on the
  // query's `t` alias — a ratio's numerator/denominator can be a single
  // existing measure or a small sum of raw columns, so (unlike per-unit
  // derived measures) there's no fixed whitelist to build `c` from here.
  const c = new Proxy({}, { get: (_, prop) => `t.${quoteIdent(String(prop))}` });
  const numExpr = ratio.numerator(c);
  const denExpr = ratio.denominator(c);
  const numAgg = buildAggExprFromSql(numExpr, 'sum', weighted, weightExpr);
  const denAgg = buildAggExprFromSql(denExpr, 'sum', weighted, weightExpr);
  const ratioSql = `(${numAgg}) / NULLIF((${denAgg}), 0)`;
  return ratio.scale && ratio.scale !== 1 ? `(${ratioSql}) * ${ratio.scale}` : ratioSql;
}

function buildQuery(validated) {
  const { dataset, xDim, yMeasure, agg, weighted, filters } = validated;
  const view = quoteIdent(dataset.view);
  const params = [];

  let fromClause = `${view} AS t`;
  let weightExpr = `t.${quoteIdent(dataset.weight.column)}`;

  if (weighted && dataset.weight.needsJoin) {
    const spineView = quoteIdent(dataset.weight.spineView);
    fromClause = `${view} AS t
      LEFT JOIN ${spineView} AS __spine
        ON t.${quoteIdent(dataset.idColumn)} = __spine.${quoteIdent(dataset.weight.spineIdColumn)}
       AND t.yr = __spine.yr`;
    weightExpr = `__spine.mult`;
  }

  const whereParts = [];
  for (const f of filters) {
    const placeholders = f.values.map(() => '?').join(', ');
    whereParts.push(`t.${quoteIdent(f.dim.key)} IN (${placeholders})`);
    params.push(...f.values);
  }
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const xExpr = `t.${quoteIdent(xDim.key)}`;
  const aggExpr = yMeasure.ratio
    ? buildRatioAggExpr(yMeasure.ratio, weighted, weightExpr)
    : buildAggExpr(yMeasure.key, agg, weighted, weightExpr);

  const sql = `
    SELECT ${xExpr} AS label, ${aggExpr} AS value
    FROM ${fromClause}
    ${whereClause}
    GROUP BY ${xExpr}
    ORDER BY ${xExpr}
  `;

  return { sql, params };
}

module.exports = { buildQuery };
