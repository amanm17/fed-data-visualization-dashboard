const path = require('path');
const express = require('express');
const cors = require('cors');
const metadataHandler = require('./routes/metadata');
const queryHandler = require('./routes/query');
const dimensionValuesHandler = require('./routes/dimensionValues');
const comtradeRouter = require('./routes/comtrade');
const { initRegistry } = require('./query/registry');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/metadata', metadataHandler);
app.post('/api/query', queryHandler);
app.get('/api/dimension-values', dimensionValuesHandler);
// UN Comtrade Trade Explorer — a standalone module, unrelated to the ASI/
// PLFS module registry above (live-fetch + shared cache, not a CSV-backed
// DuckDB view), so it's mounted directly rather than going through
// initRegistry().
app.use('/api/comtrade', comtradeRouter);

const PORT = process.env.PORT || 4000;

initRegistry()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`ASI dashboard server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize module registry:', err);
    process.exit(1);
  });
