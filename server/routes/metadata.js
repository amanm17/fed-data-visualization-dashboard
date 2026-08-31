const { initRegistry } = require('../query/registry');
const { VALID_AGGS, VALID_CHART_TYPES } = require('../query/validate');

module.exports = async function metadataHandler(req, res) {
  const registry = await initRegistry();
  const datasets = [...registry.datasets.values()].map((d) => ({
    id: d.id,
    label: d.label,
    grain: d.grain,
    dimensions: d.dimensions.map((dim) => ({
      key: dim.key,
      label: dim.label,
      filterable: !!dim.filterable,
      decode: dim.decode || null,
    })),
    // `ratio: true` tells the frontend to disable the Aggregation control
    // for this measure — the actual numerator/denominator functions never
    // leave the server, only the boolean.
    measures: d.measures.map((m) => ({ key: m.key, label: m.label, ratio: !!m.ratio })),
  }));
  res.json({ datasets, aggregations: VALID_AGGS, chartTypes: VALID_CHART_TYPES });
};
