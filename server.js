/**
 * 匿名聊天 + 飘飘瓶服务器
 * Node.js + ws + http，端口 80
 */

// ── 依赖 ───────────────────────────────────────────────
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 基础配置 ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS    = 5 * 60 * 1000;  // 房间无人 5 分钟后销毁
const PING_INTERVAL  = 25 * 1000;       // 心跳间隔 25s
const PING_TIMEOUT   = 10 * 1000;       // 未响应 10s 后踢出
const MAX_MSG_LEN    = 500;             // 文字消息最大字符数
const MAX_IMG_BYTES  = 700 * 1024;      // 图片消息最大字节（700KB，含Base64开销）
const MAX_ROOMS      = 2000;            // 最多同时存在房间数
const MAX_CLIENTS_PER_ROOM = 50;        // 每个房间最多人数

// ── 飘飘瓶配置 ────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data', 'messages.json');
const SENSITIVE_WORDS = []; // 可添加违禁词
const RATE_LIMIT = 10;      // 最多次数
const RATE_WINDOW = 60000;   // 时间窗口 1分钟

const ipRateLimit = {};

// ── 飘飘瓶数据存储 ────────────────────────────────────
function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}));
}

function loadMessages() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveMessages(messages) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(messages, null, 2));
}

// ── 飘飘瓶工具函数 ────────────────────────────────────
function generateId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (!ipRateLimit[ip]) ipRateLimit[ip] = [];
  ipRateLimit[ip] = ipRateLimit[ip].filter(t => now - t < RATE_WINDOW);
  if (ipRateLimit[ip].length >= RATE_LIMIT) return false;
  ipRateLimit[ip].push(now);
  return true;
}

function cleanExpiredMessages() {
  const messages = loadMessages();
  const now = Date.now();
  let changed = false;
  for (const id in messages) {
    const msg = messages[id];
    if (msg.expires_at && new Date(msg.expires_at).getTime() < now) {
      if (!msg.destroyed) {
        messages[id] = { destroyed: true, destroyed_at: new Date().toISOString() };
        changed = true;
      }
    }
  }
  if (changed) saveMessages(messages);
}

// 每分钟清理一次过期留言
setInterval(cleanExpiredMessages, 60 * 1000);

// ── HTTP 服务器 ───────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlPath = req.url.split('?')[0];

  // ── API 路由 ──
  if (urlPath.startsWith('/api/')) {
    handleAPI(req, res, urlPath);
    return;
  }

  // ── 首页 ──
  if (urlPath === '/') {
    serveFile(res, 'index.html', 'text/html; charset=utf-8');
    return;
  }

  // ── 飘飘瓶页面 /msg/:id ──
  if (urlPath.startsWith('/msg/')) {
    serveFile(res, 'msg.html', 'text/html; charset=utf-8');
    return;
  }

  // ── 静态资源（带扩展名的路径）───
  const ext = path.extname(urlPath);
  if (ext) {
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.ico':  'image/x-icon',
      '.png':  'image/png',
      '.svg':  'image/svg+xml',
      '.woff2':'font/woff2',
    };
    const filePath = path.join(__dirname, urlPath);
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    serveFile(res, urlPath, mimeTypes[ext] || 'application/octet-stream');
    return;
  }

  // ── 房间路径（如 /abc123）───
  serveFile(res, 'chat.html', 'text/html; charset=utf-8');
});

function serveFile(res, filePath, contentType) {
  const absPath = path.join(__dirname, filePath);
  fs.readFile(absPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ── API 处理函数 ──────────────────────────────────────
function handleAPI(req, res, urlPath) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // POST /api/messages - 创建留言
  if (req.method === 'POST' && urlPath === '/api/messages') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        if (!checkRateLimit(ip)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '操作太频繁，请稍后再试' }));
          return;
        }

        const { content, self_destruct, destruction_delay, password } = JSON.parse(body);

        if (!content || !content.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '留言内容不能为空' }));
          return;
        }

        if (content.length > 5000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '留言内容不能超过5000字' }));
          return;
        }

        const messages = loadMessages();
        let id = generateId();
        while (messages[id]) id = generateId();

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const message = {
          id,
          content: content.trim(),
          created_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
          self_destruct: !!self_destruct,
          destruction_delay: self_destruct ? (parseInt(destruction_delay) || 10) : null,
          password: password ? crypto.createHash('sha256').update(password).digest('hex') : null,
          first_viewed_at: null,
          destroyed: false,
          replies: []
        };

        messages[id] = message;
        saveMessages(messages);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, expires_at: message.expires_at, has_password: !!password }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '服务器错误' }));
      }
    });
    return;
  }

  // GET /api/messages/:id - 读取留言
  if (req.method === 'GET' && urlPath.startsWith('/api/messages/')) {
    const parts = urlPath.split('/');
    const id = parts[3];
    const password = parts[4]; // 可选的口令参数
    const messages = loadMessages();
    const msg = messages[id];

    if (!msg) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '留言不存在或已失效' }));
      return;
    }

    if (msg.destroyed) {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '该留言已销毁', destroyed: true }));
      return;
    }

    const now = new Date();

    if (msg.expires_at && new Date(msg.expires_at) < now) {
      messages[id] = { destroyed: true, destroyed_at: now.toISOString() };
      saveMessages(messages);
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '该留言已过期销毁', destroyed: true }));
      return;
    }

    // 检查是否需要口令
    if (msg.password) {
      const inputPwdHash = crypto.createHash('sha256').update(password || '').digest('hex');
      if (inputPwdHash !== msg.password) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '需要口令', need_password: true }));
        return;
      }
    }

    // 阅后即焚逻辑
    if (msg.self_destruct && !msg.first_viewed_at) {
      messages[id].first_viewed_at = now.toISOString();
      const destroyAt = new Date(now.getTime() + (msg.destruction_delay || 10) * 1000);
      messages[id].expires_at = destroyAt.toISOString();
      saveMessages(messages);
      msg.first_viewed_at = messages[id].first_viewed_at;
      msg.expires_at = messages[id].expires_at;
    }

    if (msg.self_destruct && msg.first_viewed_at) {
      const expiresAt = new Date(msg.expires_at);
      if (expiresAt < now) {
        messages[id] = { destroyed: true, destroyed_at: now.toISOString() };
        saveMessages(messages);
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '该留言已销毁', destroyed: true }));
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: msg.id,
      content: msg.content,
      created_at: msg.created_at,
      expires_at: msg.expires_at,
      self_destruct: msg.self_destruct,
      destruction_delay: msg.destruction_delay,
      first_viewed_at: msg.first_viewed_at,
      replies: msg.replies || []
    }));
    return;
  }

  // POST /api/messages/:id/verify - 验证口令
  if (req.method === 'POST' && urlPath.match(/^\/api\/messages\/[^/]+\/verify$/)) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const id = urlPath.split('/')[3];
        const { password } = JSON.parse(body);
        const messages = loadMessages();
        const msg = messages[id];

        if (!msg || msg.destroyed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '留言不存在或已销毁' }));
          return;
        }

        if (!msg.password) {
          // 没有口令，直接返回成功
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, verified: true }));
          return;
        }

        const inputPwdHash = crypto.createHash('sha256').update(password || '').digest('hex');
        if (inputPwdHash === msg.password) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, verified: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '口令错误' }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '服务器错误' }));
      }
    });
    return;
  }

  // POST /api/messages/:id/replies - 发送回复
  if (req.method === 'POST' && urlPath.match(/^\/api\/messages\/[^/]+\/replies$/)) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        if (!checkRateLimit(ip)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '操作太频繁，请稍后再试' }));
          return;
        }

        const id = urlPath.split('/')[3];
        const { content, password } = JSON.parse(body);
        const messages = loadMessages();
        const msg = messages[id];

        // 验证口令
        if (msg && msg.password) {
          const inputPwdHash = crypto.createHash('sha256').update(password || '').digest('hex');
          if (inputPwdHash !== msg.password) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '口令错误' }));
            return;
          }
        }

        if (!msg || msg.destroyed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '留言不存在或已销毁' }));
          return;
        }

        if (msg.expires_at && new Date(msg.expires_at) < new Date()) {
          res.writeHead(410, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '留言已过期，无法回复' }));
          return;
        }

        if (!content || !content.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '回复内容不能为空' }));
          return;
        }

        if (content.length > 2000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '回复内容不能超过2000字' }));
          return;
        }

        const reply = {
          id: crypto.randomUUID().slice(0, 8),
          content: content.trim(),
          created_at: new Date().toISOString()
        };

        if (!messages[id].replies) messages[id].replies = [];
        messages[id].replies.push(reply);
        saveMessages(messages);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, reply }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '服务器错误' }));
      }
    });
    return;
  }

  // DELETE /api/messages/:id - 手动销毁留言
  if (req.method === 'DELETE' && urlPath.startsWith('/api/messages/')) {
    const id = urlPath.split('/')[3];
    const messages = loadMessages();

    if (!messages[id]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '留言不存在' }));
      return;
    }

    messages[id] = { destroyed: true, destroyed_at: new Date().toISOString() };
    saveMessages(messages);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: '留言已销毁' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'API不存在' }));
}

// ── WebSocket 服务器 ───────────────────────────────────
const wss = new WebSocketServer({ server });

// 房间结构: Map<roomCode, { clients: Map<id, ClientInfo>, lastActivity: timestamp }>
const rooms = new Map();
let clientSeq = 0;

// 广播给房间内所有人（可排除指定 id）
function broadcast(roomCode, message, excludeId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const [id, info] of room.clients) {
    if (id !== excludeId && info.ws.readyState === WebSocket.OPEN) {
      try { info.ws.send(payload); } catch (_) {}
    }
  }
}

// 广播给包含自己的所有人
function broadcastAll(roomCode, message) {
  broadcast(roomCode, message, null);
}

// 广播在线人数 + 昵称列表
function broadcastOnline(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const nicks = [...room.clients.values()].map(c => c.nick).filter(Boolean);
  broadcastAll(roomCode, { type: 'online', count: room.clients.size, nicks });
}

// 清理过期空房间（每 30s 执行一次）
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
      console.log(`[×] 房间 ${code} 已销毁（超时无人）`);
    }
  }
}, 30_000);

// ── WebSocket 心跳（防止僵尸连接）────────────────────
const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws._isAlive === false) {
      ws.terminate();
      continue;
    }
    ws._isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, PING_INTERVAL);

wss.on('close', () => clearInterval(pingTimer));

// ── 连接处理 ─────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = ++clientSeq;
  let currentRoom = null;
  let clientInfo   = null;

  ws._isAlive = true;
  ws.on('pong', () => { ws._isAlive = true; });

  ws.on('message', (raw) => {
    // 大小限制（防止超大消息轰炸）
    if (raw.length > MAX_IMG_BYTES) return;

    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data !== 'object') return;

    switch (data.type) {
      case 'join': {
        const room = typeof data.room === 'string' ? data.room : '';
        const nick = typeof data.nick === 'string' ? data.nick : '';
        if (!room || !nick) return;

        const safeRoom = room.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
        if (!/^[a-z0-9]{4,8}$/.test(safeRoom)) return;

        const safeNick = nick.slice(0, 24).trim() || '匿名';

        // 离开旧房间
        if (currentRoom && rooms.has(currentRoom)) {
          const oldRoom = rooms.get(currentRoom);
          oldRoom.clients.delete(clientId);
          broadcastOnline(currentRoom);
        }

        // 房间数量上限
        if (!rooms.has(safeRoom) && rooms.size >= MAX_ROOMS) {
          try { ws.send(JSON.stringify({ type: 'system', text: '服务器房间已满，请稍后再试' })); } catch (_) {}
          return;
        }

        // 创建/加入房间
        if (!rooms.has(safeRoom)) {
          rooms.set(safeRoom, { clients: new Map(), lastActivity: Date.now() });
          console.log(`[+] 房间 ${safeRoom} 已创建`);
        }
        const roomObj = rooms.get(safeRoom);

        // 每房间人数上限
        if (roomObj.clients.size >= MAX_CLIENTS_PER_ROOM) {
          try { ws.send(JSON.stringify({ type: 'system', text: '房间人数已满' })); } catch (_) {}
          return;
        }

        clientInfo = { id: clientId, nick: safeNick, ws };
        roomObj.clients.set(clientId, clientInfo);
        roomObj.lastActivity = Date.now();
        currentRoom = safeRoom;

        // 通知客户端已加入
        try {
          ws.send(JSON.stringify({
            type: 'joined',
            id: clientId,
            nick: clientInfo.nick,
            count: roomObj.clients.size,
          }));
        } catch (_) {}

        broadcastOnline(safeRoom);
        console.log(`[→] ${clientInfo.nick} 加入 #${safeRoom} (${roomObj.clients.size}人)`);
        break;
      }

      case 'msg': {
        if (!currentRoom || !clientInfo) return;
        const roomObj = rooms.get(currentRoom);
        if (!roomObj) return;

        const text = typeof data.text === 'string' ? data.text.slice(0, MAX_MSG_LEN).trim() : '';
        if (!text) return;

        const burnSec = typeof data.burn === 'number' && data.burn >= 0 ? data.burn : 10;
        const msgId   = typeof data.msgId === 'string' ? data.msgId.slice(0, 64) : String(Date.now());

        roomObj.lastActivity = Date.now();

        broadcastAll(currentRoom, {
          type:   'msg',
          nick:   clientInfo.nick,
          text,
          burn:   burnSec,
          ts:     Date.now(),
          fromId: clientId,
          msgId,
        });
        break;
      }

      case 'img': {
        if (!currentRoom || !clientInfo) return;
        const roomObj2 = rooms.get(currentRoom);
        if (!roomObj2) return;

        const imgData = typeof data.imgData === 'string' ? data.imgData : '';
        if (!imgData || !imgData.startsWith('data:image/')) return;
        if (imgData.length > MAX_IMG_BYTES) return;

        const burnSecImg = typeof data.burn === 'number' && data.burn >= 0 ? data.burn : 10;
        const msgIdImg   = typeof data.msgId === 'string' ? data.msgId.slice(0, 64) : String(Date.now());

        roomObj2.lastActivity = Date.now();

        broadcastAll(currentRoom, {
          type:    'img',
          nick:    clientInfo.nick,
          imgData,
          burn:    burnSecImg,
          ts:      Date.now(),
          fromId:  clientId,
          msgId:   msgIdImg,
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const roomObj = rooms.get(currentRoom);
      roomObj.clients.delete(clientId);
      broadcastOnline(currentRoom);
      console.log(`[←] ${clientInfo?.nick || clientId} 断开 #${currentRoom} (还剩 ${roomObj.clients.size} 人)`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[!] 客户端 ${clientId} 错误:`, err.message);
  });
});

// ── 启动 ──────────────────────────────────────────────
ensureDataDir();
server.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════╗`);
  console.log(`  ║  极简隐私网站              ║`);
  console.log(`  ║  匿名聊天 + 飘飘瓶         ║`);
  console.log(`  ║  http://localhost:${PORT}     ║`);
  console.log(`  ╚═══════════════════════════╝\n`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('\n正在关闭服务器...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  server.close(() => process.exit(0));
});
