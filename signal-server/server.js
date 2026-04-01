const http = require('http');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { ExpressPeerServer } = require('peer');

const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || '0.0.0.0';
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 240);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const PEER_PATH = normalizePath(process.env.PEER_PATH || '/peerjs');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

app.use(helmet({
  crossOriginResourcePolicy: false,
}));

app.use(morgan('combined'));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');

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
    timestamp: new Date().toISOString(),
  });
});

const server = http.createServer(app);

const peerServer = ExpressPeerServer(server, {
  path: '/',
  proxied: TRUST_PROXY,
  allow_discovery: true,
});

peerServer.on('connection', (client) => {
  console.log(`[peer] connected ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[peer] disconnected ${client.getId()}`);
});

app.use(PEER_PATH, peerServer);

server.listen(PORT, HOST, () => {
  console.log(`ConnectVia signaling server listening on http://${HOST}:${PORT}${PEER_PATH}`);
});

function normalizePath(value) {
  if (!value) {
    return '/peerjs';
  }

  return value.startsWith('/') ? value : `/${value}`;
}
