/**
 * 匿名聊天室服务器
 * Node.js + ws，端口 80
 * 房间无人后自动销毁，消息不持久化
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 80;
const ROOM_TTL_MS    = 5 * 60 * 1000;  // 房间无人 5 分钟后销毁
const PING_INTERVAL  = 25 * 1000;       // 心跳间隔 25s
const PING_TIMEOUT   = 10 * 1000;       // 未响应 10s 后踢出
const MAX_MSG_LEN    = 500;             // 文字消息最大字符数
const MAX_IMG_BYTES  = 700 * 1024;      // 图片消息最大字节（700KB，含Base64开销）
const MAX_ROOMS      = 2000;            // 最多同时存在房间数
const MAX_CLIENTS_PER_ROOM = 50;        // 每个房间最多人数

// ── HTTP 服务器 ───────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET')     { res.writeHead(405); res.end('Method Not Allowed'); return; }

  const urlPath = req.url.split('?')[0];

  // 首页
  if (urlPath === '/') {
    serveFile(res, 'index.html', 'text/html; charset=utf-8');
    return;
  }

  // 静态资源（带扩展名的路径）
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
    // 安全检查：只允许访问项目目录内的文件
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    serveFile(res, urlPath, mimeTypes[ext] || 'application/octet-stream');
    return;
  }

  // 房间路径（如 /abc123）
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

server.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════╗`);
  console.log(`  ║  极简隐私聊天室            ║`);
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
