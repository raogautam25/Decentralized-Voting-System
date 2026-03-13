const express = require('express');
const path = require('path');

const app = express();
const distDir = path.join(__dirname, 'client', 'dist');

app.use(express.static(distDir, { extensions: ['html'] }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// SPA fallback so nested routes still boot the React app.
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
