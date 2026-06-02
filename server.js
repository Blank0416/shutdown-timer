// Shutdown Timer - Node.js server (zero dependencies)
// Sets a Windows shutdown timer with real-time countdown via SSE

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = 4399;
const PUBLIC_DIR = path.join(__dirname, "public");

// ── In-memory timer state ──────────────────────────────────────────
let timerState = {
  active: false,
  remainingMs: 0,
  targetTime: null,    // ISO string of when shutdown will happen
  createdAt: null,
};

let sseClients = [];   // active SSE connections
let tickInterval = null;

// ── MIME types ─────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

// ── Shutdown helpers ───────────────────────────────────────────────
function scheduleShutdown(seconds) {
  return new Promise((resolve, reject) => {
    execFile("shutdown", ["/s", "/t", String(seconds)], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function abortShutdown() {
  return new Promise((resolve, reject) => {
    execFile("shutdown", ["/a"], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ── Timer logic ────────────────────────────────────────────────────
function startTimer(remainingMs) {
  stopTimer();
  timerState.active = true;
  timerState.remainingMs = remainingMs;
  timerState.targetTime = new Date(Date.now() + remainingMs).toISOString();
  timerState.createdAt = new Date().toISOString();

  // Schedule actual Windows shutdown
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  scheduleShutdown(seconds).catch((err) => {
    broadcast({ type: "error", message: `关机命令失败: ${err.message}` });
  });

  // Broadcast every second
  tickInterval = setInterval(() => {
    timerState.remainingMs = Math.max(0, timerState.remainingMs - 1000);
    broadcastState();
    if (timerState.remainingMs <= 0) {
      stopTimer();
      broadcast({ type: "shutting_down", message: "正在关机…" });
    }
  }, 1000);
}

function stopTimer() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  timerState.active = false;
  abortShutdown().catch(() => {});
  broadcastState();
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

function broadcastState() {
  broadcast({
    type: "tick",
    remainingMs: timerState.remainingMs,
    targetTime: timerState.targetTime,
    active: timerState.active,
  });
}

// ── Parse request body ─────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

// ── HTTP Router ────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");

  // ── API routes ──────────────────────────────────────────────────
  if (pathname === "/api/state" && method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(timerState));
    return;
  }

  if (pathname === "/api/start" && method === "POST") {
    const body = await readBody(req);
    let ms = 0;

    if (body.type === "countdown") {
      ms = (parseInt(body.minutes, 10) || 0) * 60 * 1000;
    } else if (body.type === "time") {
      // target time as "HH:MM"
      const [h, m] = (body.time || "").split(":").map(Number);
      if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "无效时间格式，使用 HH:MM" }));
        return;
      }
      const now = new Date();
      let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
      if (target <= now) target = new Date(target.getTime() + 86400000); // next day
      ms = target.getTime() - now.getTime();
    } else {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: '需要 type: "countdown" 或 type: "time"' }));
      return;
    }

    if (ms < 60000 && ms !== 0) {
      // Allow 0 for "right now", otherwise minimum 1 minute
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "最少设 1 分钟" }));
      return;
    }

    startTimer(ms);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, remainingMs: ms }));
    return;
  }

  if (pathname === "/api/stop" && method === "POST") {
    stopTimer();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── SSE stream ─────────────────────────────────────────────────
  if (pathname === "/api/events" && method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sseClients.push(res);
    // Send current state immediately
    broadcastState();
    // Remove on disconnect
    req.on("close", () => {
      sseClients = sseClients.filter((c) => c !== res);
    });
    return;
  }

  // ── Static files ────────────────────────────────────────────────
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "content-type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ── Start server ────────────────────────────────────────────────────
const server = http.createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ⏰ Shutdown Timer running at http://127.0.0.1:${PORT}`);
  console.log(`  Press Ctrl+C to stop the server\n`);
});

// Clean shutdown
process.on("SIGINT", () => {
  console.log("\n  Aborting shutdown & stopping server…");
  abortShutdown().catch(() => {});
  process.exit(0);
});
