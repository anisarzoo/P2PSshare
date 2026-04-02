const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { ExpressPeerServer } = require('peer');

const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || '0.0.0.0';
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 240);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const PEER_PATH = normalizePath(process.env.PEER_PATH || '/peerjs');
const ALLOW_DISCOVERY = process.env.ALLOW_DISCOVERY === 'true';

const ENABLE_HTTPS = process.env.ENABLE_HTTPS === 'true';
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || '';
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || '';
const TLS_CA_FILE = process.env.TLS_CA_FILE || '';

const corsPolicy = parseCorsPolicy(process.env.CORS_ORIGIN || '*');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);

app.use(morgan('combined'));

app.use(
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use((req, res, next) => {
  const requestOrigin = normalizeOrigin(req.headers.origin);
  const allowedOrigin = resolveAllowedOrigin(requestOrigin, corsPolicy);

  if (requestOrigin && !allowedOrigin) {
    res.status(403).json({ ok: false, error: 'origin_not_allowed' });
    return;
  }

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    if (allowedOrigin !== '*') {
      appendVaryHeader(res, 'Origin');
    }
  }

  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'connectvia-signal-server',
    peerPath: PEER_PATH,
    protocol: ENABLE_HTTPS ? 'https' : 'http',
    corsMode: corsPolicy.wildcard ? 'wildcard' : 'allowlist',
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', (_req, res) => {
  res.json({ ok: true });
});

const { server, protocol } = createServer(app);

const peerServer = ExpressPeerServer(server, {
  path: '/',
  proxied: TRUST_PROXY,
  allow_discovery: ALLOW_DISCOVERY,
});

peerServer.on('connection', (client) => {
  console.log(`[peer] connected ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[peer] disconnected ${client.getId()}`);
});

app.use(PEER_PATH, peerServer);

server.listen(PORT, HOST, () => {
  console.log(`ConnectVia signaling server listening on ${protocol}://${HOST}:${PORT}${PEER_PATH}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[server] ${signal} received, closing listener...`);
    server.close(() => process.exit(0));
  });
}

function createServer(expressApp) {
  if (!ENABLE_HTTPS) {
    return {
      server: http.createServer(expressApp),
      protocol: 'http',
    };
  }

  if (!TLS_KEY_FILE || !TLS_CERT_FILE) {
    throw new Error('ENABLE_HTTPS=true requires TLS_KEY_FILE and TLS_CERT_FILE');
  }

  const tlsOptions = {
    key: fs.readFileSync(TLS_KEY_FILE),
    cert: fs.readFileSync(TLS_CERT_FILE),
  };

  if (TLS_CA_FILE) {
    tlsOptions.ca = fs.readFileSync(TLS_CA_FILE);
  }

  return {
    server: https.createServer(tlsOptions, expressApp),
    protocol: 'https',
  };
}

function normalizePath(value) {
  if (!value) {
    return '/peerjs';
  }

  return value.startsWith('/') ? value : `/${value}`;
}

function parseCorsPolicy(rawValue) {
  const raw = String(rawValue || '*').trim();
  if (!raw || raw === '*') {
    return { wildcard: true, origins: new Set() };
  }

  const origins =
    raw
      .split(',')
      .map((entry) => normalizeOrigin(entry))
      .filter(Boolean);

  return { wildcard: false, origins: new Set(origins) };
}

function resolveAllowedOrigin(requestOrigin, policy) {
  if (policy.wildcard) {
    return '*';
  }

  if (!requestOrigin) {
    return null;
  }

  return policy.origins.has(requestOrigin) ? requestOrigin : null;
}

function normalizeOrigin(origin) {
  if (!origin) {
    return '';
  }

  return String(origin).trim().replace(/\/+$/, '');
}

function appendVaryHeader(res, value) {
  const current = String(res.getHeader('Vary') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!current.includes(value)) {
    current.push(value);
  }

  if (current.length > 0) {
    res.setHeader('Vary', current.join(', '));
  }
}
