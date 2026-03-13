const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const { execFile } = require('child_process');

require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve static frontend assets
app.use('/css', express.static(path.join(__dirname, 'src/css')));
app.use('/js', express.static(path.join(__dirname, 'src/js')));
app.use('/dist', express.static(path.join(__dirname, 'src/dist')));
app.use('/assets', express.static(path.join(__dirname, 'src/assets')));

// Authorization middleware
const authorizeUser = (req, res, next) => {
  const token = req.query.Authorization?.split('Bearer ')[1];

  if (!token) {
    return res.status(401).send('<h1 align="center"> Login to Continue </h1>');
  }

  try {
    const decodedToken = jwt.verify(token, process.env.SECRET_KEY, { algorithms: ['HS256'] });
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid authorization token' });
  }
};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/login.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/login.html'));
});

app.get('/js/login.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/js/login.js'));
});

app.get('/css/login.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/css/login.css'));
});

app.get('/css/index.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/css/index.css'));
});

app.get('/css/admin.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/css/admin.css'));
});

app.get('/assets/eth5.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/assets/eth5.jpg'));
});

app.get('/js/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/js/app.js'));
});

app.get('/admin.html', authorizeUser, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/admin.html'));
});

app.get('/candidate-nomination.html', authorizeUser, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/candidate_nomination.html'));
});

app.get('/index.html', authorizeUser, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/index.html'));
});

app.get('/voter.html', (req, res) => {
  res.redirect(302, '/vote.html');
});

app.get('/vote.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/vote.html'));
});

app.get('/verify-vote.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/verify_vote.html'));
});

app.get('/verify_vote.html', (req, res) => {
  res.redirect(302, '/verify-vote.html');
});

app.get('/explorer.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/explorer.html'));
});

app.get('/loading.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/loading.html'));
});

app.get('/dist/login.bundle.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/dist/login.bundle.js'));
});

app.get('/dist/app.bundle.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/dist/app.bundle.js'));
});

app.post('/admin/sync-chain-to-db', authorizeUser, (req, res) => {
  const scriptPath = path.join(__dirname, 'scripts', 'sync_chain_to_db.js');
  execFile(process.execPath, [scriptPath], { env: process.env }, (err, stdout, stderr) => {
    if (stderr) {
      console.warn('sync stderr:', stderr);
    }
    const text = (stdout || '').toString().trim();
    try {
      const json = JSON.parse(text || '{}');
      if (err) {
        return res.status(500).json(json.ok === false ? json : { ok: false, error: err.message });
      }
      return res.json(json);
    } catch (e) {
      return res.status(500).json({ ok: false, error: `Sync failed: ${err ? err.message : 'unknown'}`, raw: text });
    }
  });
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/favicon.ico'));
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
