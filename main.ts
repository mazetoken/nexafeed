// @ts-types="npm:@types/express@5.0.6"
import express from "npm:express@5.2.1";

// ============================================================================
// CONFIG
// ============================================================================

interface RostrumServer { host: string; port: number; protocol: string; }

const SERVERS: RostrumServer[] = [
  { host: "electrum.nexa.org", port: 20004, protocol: "wss" },
  { host: "onekey-electrum.bitcoinunlimited.info", port: 20004, protocol: "wss" },
  { host: "rostrum.otoplo.com", port: 443, protocol: "wss" },
  { host: "electrum.nexa.org", port: 20003, protocol: "ws" },
];

const PING_INTERVAL = 15_000;
const HEALTH_CHECK_INTERVAL = 20_000;
const STALE_THRESHOLD = 45_000;
const MAX_RECONNECT_DELAY = 60_000;

// ============================================================================
// STATE
// ============================================================================

interface PendingRpc { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number; }
interface Block { height: number; txCount: number | null; timestamp: string; source?: string; }

let ws: WebSocket | null = null;
let rpcId = 1;
let isConnected = false;
let isReconnecting = false;
let reconnectAttempts = 0;
let serverIndex = 0;
let lastMessageAt = Date.now();
let pingTimer: number | null = null;
let lastKnownBlock: Block | null = null;

const pending = new Map<number, PendingRpc>();

// ============================================================================
// SSE CLIENTS
// ============================================================================

const clients = new Set<express.Response>();

function broadcast(block: Block) {
  const data = `data: ${JSON.stringify(block)}\n\n`;
  for (const res of clients) {
    try { res.write(data); }
    catch { clients.delete(res); }
  }
}

// ============================================================================
// APP
// ============================================================================

const app = express();
app.use(express.static("public"));

// SSE endpoint — replaces socket.io
app.get("/stream", (req: any, res: any) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.add(res);
  console.log(`🖥  Client connected (${clients.size} total)`);

  // Replay last known block immediately so the frontend isn't blank
  if (lastKnownBlock) res.write(`data: ${JSON.stringify(lastKnownBlock)}\n\n`);

  req.on("close", () => {
    clients.delete(res);
    console.log(`🖥  Client disconnected (${clients.size} total)`);
  });
});

// ============================================================================
// RPC
// ============================================================================

function sendRpc(method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("WebSocket not open"));
    }

    const id = rpcId++;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }
    }, timeoutMs) as unknown as number;

    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function resolveRpc(id: number, result: unknown) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(result);
}

function rejectRpc(id: number, err: unknown) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  const msg = typeof err === "string" ? err : (err as any)?.message ?? "RPC error";
  entry.reject(new Error(msg));
}

function clearAllPending(reason = "Connection closed") {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

// ============================================================================
// HEADER PARSER
// ============================================================================

function parseNexaHeader(hex: string): { height: number; txCount: number; timestamp: string } {
  const bytes = Uint8Array.from(hex.match(/.{1,2}/g)!, b => parseInt(b, 16));
  const view = new DataView(bytes.buffer);
  let offset = 32 + 4 + 32 + 32 + 32; // prev + target + ancestor + merkle + filter

  const timestamp = view.getUint32(offset, true);
  offset += 4;

  let height = 0, shift = 0;
  while (offset < bytes.length) {
    const b = bytes[offset++];
    height |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }

  offset += 32 + 8; // chainwork + size

  let txCount = 0, txShift = 0;
  while (offset < bytes.length) {
    const b = bytes[offset++];
    txCount |= (b & 0x7f) << txShift;
    if ((b & 0x80) === 0) break;
    txShift += 7;
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

  const url = currentUrl();
  console.log(`🔌 Connecting to ${url} (attempt ${reconnectAttempts + 1})`);

  ws = new WebSocket(url);
  ws.onopen = onOpen;
  ws.onmessage = onMessage;
  ws.onclose = onClose;
  ws.onerror = onError;
}

async function onOpen() {
  console.log(`✅ Connected to ${currentUrl()}`);
  isConnected = true;
  isReconnecting = false;
  reconnectAttempts = 0;
  lastMessageAt = Date.now();

  startPing();

  try {
    await sendRpc("server.version", ["Nexa-TX-Watch 1.0", "1.4"]);
    const result = await sendRpc("blockchain.headers.subscribe", []) as any;

    if (result?.hex) {
      const parsed = parseNexaHeader(result.hex);
      // Only broadcast if this is actually a new block we haven't seen
      if (!lastKnownBlock || result.height > lastKnownBlock.height) {
        lastKnownBlock = {
          height: result.height,
          txCount: parsed.txCount,
          timestamp: parsed.timestamp,
          source: "subscribe-ack",
        };
        broadcast(lastKnownBlock);
        console.log(`📦 Tip #${result.height} — ${parsed.txCount} txs`);
      } else {
        console.log(`📦 Tip #${result.height} already known — skipping broadcast`);
      }
    }

    console.log("✅ Subscribed to new blocks");
  } catch (err) {
    console.error("Handshake error:", (err as Error).message);
  }
}

function onMessage(event: MessageEvent) {
  lastMessageAt = Date.now();

  let msg: any;
  try { msg = JSON.parse(event.data); }
  catch (e) { console.error("JSON parse error:", (e as Error).message); return; }

  if (msg.id != null) {
    if (msg.error) rejectRpc(msg.id, msg.error);
    else resolveRpc(msg.id, msg.result);
    return;
  }

  if (msg.method === "blockchain.headers.subscribe") {
    const header = Array.isArray(msg.params) ? msg.params[0] : msg.params;
    if (!header?.hex) return;
    try {
      const parsed = parseNexaHeader(header.hex);
      // Ignore if same or older height than what we already have
      if (lastKnownBlock && header.height <= lastKnownBlock.height) {
        console.log(`⚠️  Stale push #${header.height} (have #${lastKnownBlock.height}) — skipping`);
        return;
      }
      lastKnownBlock = {
        height: header.height,
        txCount: parsed.txCount,
        timestamp: parsed.timestamp,
      };
      broadcast(lastKnownBlock);
      console.log(`🚀 New block #${header.height} — ${parsed.txCount} txs`);
    } catch (e) {
      console.error("Header parse error:", (e as Error).message);
    }
  }
}

function onClose(event: CloseEvent) {
  isConnected = false;
  stopPing();
  clearAllPending();
  console.log(`⚠️  Disconnected (code ${event.code})`);
  scheduleReconnect();
}

function onError(event: Event) {
  console.error("WebSocket error:", (event as ErrorEvent).message ?? "unknown");
}

// ============================================================================
// RECONNECT
// ============================================================================

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  reconnectAttempts++;
  const delay = Math.min(3_000 * 1.5 ** reconnectAttempts, MAX_RECONNECT_DELAY);
  console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
  setTimeout(() => {
    serverIndex = (serverIndex + 1) % SERVERS.length;
    connect();
  }, delay);
}

// ============================================================================
// KEEP-ALIVE
// ============================================================================

function startPing() {
  stopPing();
  pingTimer = setInterval(async () => {
    if (!isConnected) return;
    try { await sendRpc("server.ping", []); }
    catch { /* health check will handle stale connections */ }
  }, PING_INTERVAL) as unknown as number;
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
    console.log("🏥 Health: not connected — reconnecting");
    scheduleReconnect();
    return;
  }
  if (Date.now() - lastMessageAt > STALE_THRESHOLD) {
    console.log("🏥 Health: stale — forcing reconnect");
    isConnected = false;
    ws?.close();
    scheduleReconnect();
  }
}, HEALTH_CHECK_INTERVAL);

// ============================================================================
// START
// ============================================================================

connect();

app.listen(8000, () => console.log(`🚀 Nexa TX Visualizer → http://localhost:8000`));