const express = require('express');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { execFile } = require('child_process');
const mongoose = require('mongoose');

require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const jwtSecret = process.env.JWT_SECRET || process.env.SECRET_KEY || 'your_super_secret_key';
const databaseApiBase = String(
  process.env.DATABASE_API_BASE || process.env.FASTAPI_BASE || process.env.API_BASE || 'http://127.0.0.1:8000'
)
  .trim()
  .replace(/\/+$/, '');
const chainId = String(process.env.CHAIN_ID || '11155111').trim();
const rpcUrl = String(process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com').trim();
const votingContractAddress = String(process.env.VOTING_CONTRACT_ADDRESS || '').trim();
const requireMongoOnStartup = String(process.env.REQUIRE_MONGO_ON_STARTUP || 'true')
  .trim()
  .toLowerCase() !== 'false';
const mongoServerSelectionTimeoutMs = Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 10000);

function normalizeMongoUri(rawValue) {
  let value = String(rawValue || '').trim();

  if (!value) {
    return '';
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }

  value = value.replace(/^(?:MONGODB_URI|MONGO_URI)\s*=\s*/i, '').trim();
  return value;
}

function resolveMongoUri() {
  const candidates = [
    ['MONGODB_URI', process.env.MONGODB_URI],
    ['MONGO_URI', process.env.MONGO_URI],
  ];

  for (const [source, rawValue] of candidates) {
    const normalized = normalizeMongoUri(rawValue);
    if (/^mongodb(?:\+srv)?:\/\//i.test(normalized)) {
      return { source, uri: normalized };
    }
  }

  for (const [source, rawValue] of candidates) {
    const normalized = normalizeMongoUri(rawValue);
    if (normalized) {
      return { source, uri: normalized };
    }
  }

  return { source: null, uri: '' };
}

function maskMongoUri(uri) {
  if (!uri) {
    return '(empty)';
  }

  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri)) {
    return `${uri.slice(0, 24)}${uri.length > 24 ? '...' : ''}`;
  }

  return uri.replace(/\/\/([^:]+):([^@]+)@/i, '//$1:***@');
}

const { source: mongoUriSource, uri: mongoUri } = resolveMongoUri();

function buildProxyRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return JSON.stringify(req.body || {});
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(req.body || {}).toString();
  }

  return undefined;
}

async function proxyDatabaseApi(req, res) {
  if (!databaseApiBase) {
    return res.status(503).json({ message: 'Database API base is not configured.' });
  }

  try {
    const targetUrl = new URL(req.originalUrl, `${databaseApiBase}/`);
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      if (['host', 'connection', 'content-length'].includes(key.toLowerCase())) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: buildProxyRequestBody(req),
      redirect: 'manual',
    });

    res.status(upstream.status);
    for (const [key, value] of upstream.headers.entries()) {
      if (['content-type', 'content-disposition', 'cache-control', 'location'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.send(buffer);
  } catch (error) {
    return res.status(502).json({
      message: `Database API proxy failed for ${req.originalUrl}`,
      detail: error.message,
      target: databaseApiBase,
    });
  }
}

const configuredOrigins = new Set();
for (const raw of [process.env.FRONTEND_URL, process.env.CORS_ALLOWED_ORIGINS]) {
  for (const origin of String(raw || '').split(',')) {
    const normalized = origin.trim().replace(/\/+$/, '');
    if (normalized) configuredOrigins.add(normalized);
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const normalized = String(origin).trim().replace(/\/+$/, '');
  if (configuredOrigins.has(normalized)) return true;
  try {
    const url = new URL(normalized);
    return url.hostname.endsWith('.vercel.app');
  } catch {
    return false;
  }
}

const corsOptions = {
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

const adminSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, default: 'admin' },
    full_name: { type: String, default: 'System Admin' },
    is_active: { type: Boolean, default: true },
  },
  {
    collection: process.env.ADMIN_COLLECTION || 'admins',
    versionKey: false,
  }
);

const AdminModel = mongoose.models.Admin || mongoose.model('Admin', adminSchema);

async function seedDefaultAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin001';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const role = process.env.ADMIN_ROLE || 'admin';
  const fullName = process.env.ADMIN_FULL_NAME || 'System Admin';

  await AdminModel.updateOne(
    { username },
    {
      $setOnInsert: {
        username,
        password,
        role,
        full_name: fullName,
        is_active: true,
      },
    },
    { upsert: true }
  );
}

let mongoReadyPromise = null;

async function ensureMongoConnection() {
  if (!mongoUri) {
    console.error('Mongo connection skipped: MONGODB_URI is not configured.');
    return false;
  }

  if (mongoose.connection.readyState === 1) {
    return true;
  }

  if (!mongoReadyPromise) {
    mongoReadyPromise = mongoose
      .connect(mongoUri, {
        serverSelectionTimeoutMS: Number.isFinite(mongoServerSelectionTimeoutMs)
          ? mongoServerSelectionTimeoutMs
          : 10000,
      })
      .then(async () => {
        await seedDefaultAdmin();
        return true;
      })
      .catch((error) => {
        console.error(`Mongo env source: ${mongoUriSource || 'none'} (${maskMongoUri(mongoUri)})`);
        console.error('Mongo connection failed:', error.message);
        mongoReadyPromise = null;
        return false;
      });
  }

  return mongoReadyPromise;
}

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
    const decodedToken = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
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

app.get('/healthz', async (_req, res) => {
  const mongoConnected = await ensureMongoConnection();
  res.json({
    ok: true,
    mongo: mongoConnected ? 'connected' : 'disconnected',
  });
});

async function handleLogin(req, res) {
  const username = String(req.query.username || req.body.username || req.query.voter_id || req.body.voter_id || '').trim();
  const password = String(req.query.password || req.body.password || '').trim();

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  const mongoConnected = await ensureMongoConnection();
  if (!mongoConnected) {
    return res.status(503).json({ message: 'Login service unavailable. Check Render env vars and MongoDB.' });
  }

  try {
    const admin = await AdminModel.findOne({
      username,
      password,
      is_active: { $ne: false },
    }).lean();

    if (!admin) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const role = admin.role || 'admin';
    const token = jwt.sign(
      {
        username,
        voter_id: username,
        role,
      },
      jwtSecret,
      {
        algorithm: 'HS256',
        expiresIn: '12h',
      }
    );

    return res.json({ token, role });
  } catch (error) {
    console.error('Login failed:', error.message);
    return res.status(500).json({ message: 'Login failed' });
  }
}

app.get('/login', handleLogin);
app.post('/login', handleLogin);
app.get('/admin/login', handleLogin);
app.post('/admin/login', handleLogin);

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

app.get('/js/runtime-config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(
    [
      `window.__API_BASE__ = ${JSON.stringify(process.env.FRONTEND_API_BASE || '')};`,
      `window.__RPC_URL__ = ${JSON.stringify(rpcUrl)};`,
      `window.__CHAIN_ID__ = ${JSON.stringify(chainId)};`,
      `window.__VOTING_ADDRESS__ = ${JSON.stringify(votingContractAddress)};`,
    ].join('\n')
  );
});

app.get('/admin.html', authorizeUser, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/html/admin.html'));
});

app.get('/admin', authorizeUser, (req, res) => {
  const authorization = req.query.Authorization;
  if (authorization) {
    return res.redirect(302, `/admin.html?Authorization=${encodeURIComponent(authorization)}`);
  }
  return res.redirect(302, '/admin.html');
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

app.all(
  [
    '/candidates',
    '/election/dates',
    '/vote/audit',
    '/vote/report',
    '/admin/voters',
    '/admin/candidates',
    '/admin/election/dates',
    '/admin/election/stop',
    '/admin/election/restart',
    '/admin/vote-audit/export',
    '/admin/database/clear',
    '/admin/candidate-nominations',
    '/admin/candidate-nominations/check',
    '/admin/candidate-nominations/keys',
    '/voter/by-qr',
    '/voter/confirm-scan',
    /^\/media\/.*/,
  ],
  proxyDatabaseApi
);

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/favicon.ico'));
});

const PORT = process.env.PORT || 8080;

async function startServer() {
  if (requireMongoOnStartup) {
    const mongoConnected = await ensureMongoConnection();
    if (!mongoConnected) {
      console.error('Server startup aborted: MongoDB connection is required before listening for requests.');
      process.exit(1);
    }
  } else if (mongoUri) {
    ensureMongoConnection().catch((error) => {
      console.error('Mongo background connection failed:', error.message);
    });
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});
