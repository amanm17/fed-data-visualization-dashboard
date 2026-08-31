// The whitelist gate. Every value that came from the frontend (dataset id,
// X dimension, Y measure, aggregation, chart type, filter keys/values) is
// checked here against the in-memory registry built from module
// descriptors. Nothing that fails this reaches buildSql.js, and buildSql.js
// only ever uses the *matched registry entry's* own key — never the raw
// request string — when it builds SQL identifiers.
const VALID_AGGS = ['sum', 'avg', 'count', 'min', 'max'];
const VALID_CHART_TYPES = ['bar', 'line', 'pie'];

class ValidationError extends Error {}

function validateQueryRequest(registry, body) {
  const { dataset: datasetId, x, y, agg, weighted, chartType, filters } = body || {};

  if (typeof datasetId !== 'string') throw new ValidationError('"dataset" is required');
  const dataset = registry.datasets.get(datasetId);
  if (!dataset) throw new ValidationError(`Unknown dataset "${datasetId}"`);

  const dims = new Map(dataset.dimensions.map((d) => [d.key, d]));
  const measures = new Map(dataset.measures.map((m) => [m.key, m]));

  const xDim = dims.get(x);
  if (!xDim) throw new ValidationError(`Unknown X dimension "${x}" for dataset "${datasetId}"`);

  const yMeasure = measures.get(y);
  if (!yMeasure) throw new ValidationError(`Unknown Y measure "${y}" for dataset "${datasetId}"`);

  if (!VALID_AGGS.includes(agg)) {
    throw new ValidationError(`Unknown aggregation "${agg}" (must be one of ${VALID_AGGS.join(', ')})`);
  }
  const resolvedChartType = chartType === undefined ? 'bar' : chartType;
  if (!VALID_CHART_TYPES.includes(resolvedChartType)) {
    throw new ValidationError(`Unknown chart type "${chartType}" (must be one of ${VALID_CHART_TYPES.join(', ')})`);
  }
  if (typeof weighted !== 'boolean') throw new ValidationError('"weighted" must be a boolean');

  const validatedFilters = [];
  if (filters && typeof filters === 'object') {
    for (const [key, values] of Object.entries(filters)) {
      if (!Array.isArray(values) || values.length === 0) continue;
      const dim = dims.get(key);
      if (!dim) throw new ValidationError(`Unknown filter dimension "${key}" for dataset "${datasetId}"`);
      if (!dim.filterable) throw new ValidationError(`Dimension "${key}" is not filterable`);
      validatedFilters.push({ dim, values: values.map(String) });
    }
  }

  return { dataset, xDim, yMeasure, agg, weighted, chartType: resolvedChartType, filters: validatedFilters };
}

// Used by the dimension-values endpoint that powers filter option lists AND
// the highlight-category picker in the UI. Same whitelist discipline as
// everywhere else — the dimension must be declared on that dataset — but
// NOT restricted to `filterable` ones: `filterable` is a "should this show
// as a filter control" UI signal, not a security boundary, and the
// highlight picker legitimately needs values for the current X-axis
// dimension even when it isn't filterable (e.g. a high-cardinality one
// like a 5-digit industry code). The actual security check — this column
// exists in the dataset's whitelisted `dimensions` — is unchanged.
function validateDimensionRequest(registry, datasetId, dimKey) {
  if (typeof datasetId !== 'string') throw new ValidationError('"dataset" is required');
  const dataset = registry.datasets.get(datasetId);
  if (!dataset) throw new ValidationError(`Unknown dataset "${datasetId}"`);

  const dim = dataset.dimensions.find((d) => d.key === dimKey);
  if (!dim) throw new ValidationError(`Unknown dimension "${dimKey}" for dataset "${datasetId}"`);

  return { dataset, dim };
}

module.exports = {
  validateQueryRequest,
  validateDimensionRequest,
  ValidationError,
  VALID_AGGS,
  VALID_CHART_TYPES,
};
