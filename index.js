require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-challenges-service' }));

app.use('/challenges', require('./routes/challenges'));

const PORT = process.env.PORT || 3008;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah Challenges service running on http://localhost:${PORT}`);
  });
}

module.exports = app;
