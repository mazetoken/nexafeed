import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

// ============================================================================
// CONFIG
// ============================================================================

const SERVERS = [
  { host: 'electrum.nexa.org', port: 20004, protocol: 'wss' },
  { host: 'onekey-electrum.bitcoinunlimited.info', port: 20004, protocol: 'wss' },
  { host: 'rostrum.otoplo.com', port: 443, protocol: 'wss' },
  { host: 'electrum.nexa.org', port: 20003, protocol: 'ws' },
];

const PORT = parseInt(process.env.PORT ?? '3000');
const PING_INTERVAL = 15_000;
const HEALTH_CHECK_INTERVAL = 20_000;
const STALE_THRESHOLD = 45_000;
const MAX_RECONNECT_DELAY = 60_000;
const CLIENT_PING_MS = 25_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// ============================================================================
// STATE
// ============================================================================

let ws = null;
let rpcId = 1;
let isConnected = false;
let isReconnecting = false;
let reconnectAttempts = 0;
let serverIndex = 0;
let pingTimer = null;
let lastMessageAt = Date.now();
let lastKnownBlock = null;

const pending = new Map(); // id → { resolve, reject, timer }
const clients = new Set(); // active SSE response objects

// ============================================================================
// SSE — broadcast + dead client sweep
// ============================================================================

function broadcast(block) {
  const data = `data: ${JSON.stringify(block)}\n\n`;
  for (const res of clients) {
    try { res.write(data); }
    catch { clients.delete(res); }
  }
}

setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); }
    catch { clients.delete(res); }
  }
}, CLIENT_PING_MS);

// ============================================================================
// HTTP SERVER
// ============================================================================

const PUBLIC = join(process.cwd(), 'public');

const server = createServer(async (req, res) => {
  // SSE stream endpoint
  if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    clients.add(res);
    if (lastKnownBlock) res.write(`data: ${JSON.stringify(lastKnownBlock)}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  // static file serving
  let urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = join(PUBLIC, urlPath);

  // basic path traversal guard
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ============================================================================
// RPC
// ============================================================================

function sendRpc(method, params = [], timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WebSocket not open'));
    }

    rpcId = (rpcId % 100_000) + 1;
    const id = rpcId;

    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function resolveRpc(id, result) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(result);
}

function rejectRpc(id, err) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  const msg = typeof err === 'string' ? err : err?.message ?? 'RPC error';
  entry.reject(new Error(msg));
}

function clearAllPending(reason = 'Connection closed') {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

// ============================================================================
// HEADER PARSER
// ============================================================================

function parseNexaHeader(hex) {
  const bytes = Uint8Array.from(hex.match(/.{1,2}/g), b => parseInt(b, 16));
  const view = new DataView(bytes.buffer);
  let offset = 32 + 4 + 32 + 32 + 32; // prev + target + ancestor + merkle + filter

  const timestamp = view.getUint32(offset, true);
  offset += 4;

  let height = 0, hMul = 1;
  while (offset < bytes.length) {
    const b = bytes[offset++];
    height += (b & 0x7f) * hMul;
    if ((b & 0x80) === 0) break;
    hMul *= 128;
  }

  offset += 32 + 8; // chainwork + size

  let txCount = 0, tMul = 1;
  while (offset < bytes.length) {
    const b = bytes[offset++];
    txCount += (b & 0x7f) * tMul;
    if ((b & 0x80) === 0) break;
    tMul *= 128;
  }

  return { height, txCount, timestamp: new Date(timestamp * 1000).toISOString() };
}

// ============================================================================
// CONNECTION
// ============================================================================

function currentUrl() {
  const s = SERVERS[serverIndex];
  return `${s.protocol}://${s.host}:${s.port}`;
}

function connect() {
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    ws.close();
    ws = null;
  }

  console.log(`🔌 Connecting to ${currentUrl()}`);
  ws = new WebSocket(currentUrl());
  ws.onopen = onOpen;
  ws.onmessage = (event) => onMessage(event.data);
  ws.onclose = (event) => onClose(event.code);
  ws.onerror = (event) => onError(event);
}

async function onOpen() {
  console.log(`✅ Connected to ${currentUrl()}`);
  isConnected = true;
  isReconnecting = false;
  reconnectAttempts = 0;
  lastMessageAt = Date.now();
  startPing();

  try {
    await sendRpc('server.version', ['Nexa-TX-Watch 1.0', '1.4']);
    const result = await sendRpc('blockchain.headers.subscribe', []);


    if (result?.hex) {
      const parsed = parseNexaHeader(result.hex);
      if (!lastKnownBlock || result.height > lastKnownBlock.height) {
        lastKnownBlock = {
          height: result.height,
          txCount: parsed.txCount,
          timestamp: parsed.timestamp,
          source: 'subscribe-ack',
        };
        broadcast(lastKnownBlock);
        //console.log(`📦 Tip #${result.height} — ${parsed.txCount} txs`);
      }
    }

  } catch (err) {
    console.error('Handshake error:', err.message);
  }
}

function onMessage(raw) {
  lastMessageAt = Date.now();

  let msg;
  try { msg = JSON.parse(raw); }
  catch (e) { console.error('JSON parse error:', e.message); return; }

  if (msg.id != null) {
    if (msg.error) rejectRpc(msg.id, msg.error);
    else resolveRpc(msg.id, msg.result);
    return;
  }

  if (msg.method === 'blockchain.headers.subscribe') {
    const header = Array.isArray(msg.params) ? msg.params[0] : msg.params;
    if (!header?.hex) return;
    try {
      const parsed = parseNexaHeader(header.hex);
      if (lastKnownBlock && header.height <= lastKnownBlock.height) return;
      lastKnownBlock = {
        height: header.height,
        txCount: parsed.txCount,
        timestamp: parsed.timestamp,
      };
      broadcast(lastKnownBlock);
      //console.log(`🚀 Block #${header.height} — ${parsed.txCount} txs`);
    } catch (e) {
      console.error('Header parse error:', e.message);
    }
  }
}

function onClose(code) {
  isConnected = false;
  stopPing();
  clearAllPending();
  console.log(`⚠️  Disconnected (code ${code})`);
  scheduleReconnect();
}

function onError(event) {
  console.error('WebSocket error:', event?.message ?? 'unknown');
}

// ============================================================================
// RECONNECT
// ============================================================================

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  reconnectAttempts++;
  const delay = Math.min(3_000 * 1.5 ** Math.min(reconnectAttempts, 8), MAX_RECONNECT_DELAY);
  console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
  setTimeout(() => {
    serverIndex = (serverIndex + 1) % SERVERS.length;
    connect();
  }, delay);
}

// ============================================================================
// PING
// ============================================================================

function startPing() {
  stopPing();
  pingTimer = setInterval(async () => {
    if (!isConnected) return;
    try { await sendRpc('server.ping', []); }
    catch { /* onClose will handle it */ }
  }, PING_INTERVAL);
}

function stopPing() {
  if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

setInterval(() => {
  if (isReconnecting) return;
  if (!isConnected) {
    console.log('🏥 Not connected — reconnecting');
    scheduleReconnect();
    return;
  }
  if (Date.now() - lastMessageAt > STALE_THRESHOLD) {
    console.log('🏥 Stale connection — forcing reconnect');
    isConnected = false;
    ws?.close();
    scheduleReconnect();
  }
}, HEALTH_CHECK_INTERVAL);

// ============================================================================
// START
// ============================================================================

connect();
server.listen(PORT, () => console.log(`🚀 Nexa TX Visualizer → http://localhost:${PORT}`));