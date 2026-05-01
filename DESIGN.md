# 匿名聊天室 — 项目设计文档

> **版本**：v1.0.0
> **更新日期**：2026-05-01
> **作者**：随心名彻

---

## 一、项目概述

### 1.1 项目简介

**匿名聊天室**是一款专注于隐私保护的临时对话工具，包含两大核心功能模块：

| 模块 | 说明 | 入口 |
|------|------|------|
| **匿名聊天室** | 随机房间号 + WebSocket 实时聊天 + 消息阅后即焚 | 首页 → 匿名聊天 Tab |
| **飘飘瓶** | 匿名留言 + 口令保护 + 阅后即焚 + 限时销毁 | 首页 → 飘飘瓶 Tab |

### 1.2 核心特性

- ✅ **无注册** — 无需账号、手机号、邮箱
- ✅ **无记录** — 不存储聊天记录，关闭即消失
- ✅ **完全匿名** — 随机生成昵称，无 IP 关联
- ✅ **阅后即焚** — 消息自动销毁，可选延迟时间
- ✅ **口令保护** — 飘飘瓶留言可选 4 位以上口令加密
- ✅ **24h 过期** — 飘飘瓶留言默认 24 小时自动销毁
- ✅ **图片发送** — 支持 Base64 图片（≤700KB）
- ✅ **响应式设计** — 适配桌面端与移动端
- ✅ **暗色/亮色** — 支持系统主题自动切换

### 1.3 技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **后端** | Node.js 原生 HTTP + `ws` | 无框架，轻量高效 |
| **前端** | 原生 HTML/CSS/JS | 无框架依赖，约 3000 行代码 |
| **存储** | JSON 文件（`data/messages.json`） | 无数据库，符合隐私理念 |
| **通信** | WebSocket（ws 库） | 聊天室实时通信 |
| **加密** | SHA256（密码哈希） | 口令保护 |
| **部署** | Docker（node:18-alpine） | ModelScope 创空间 |

### 1.4 项目结构

```
20260324091103/
├── server.js          # 后端核心（HTTP + WebSocket + API）
├── index.html         # 首页（Tab 切换：聊天室 / 飘飘瓶）
├── chat.html          # 聊天室页面
├── msg.html           # 飘飘瓶留言页
├── package.json       # 项目配置（依赖 ws）
├── Dockerfile         # Docker 部署配置
└── data/
    └── messages.json  # 飘飘瓶留言数据存储
```

---

## 二、系统架构

### 2.1 架构图

```
┌─────────────────────────────────────────────────────────┐
│                        用户浏览器                        │
│  ┌─────────┐  ┌─────────────┐  ┌─────────────────┐    │
│  │index.html│  │ chat.html   │  │ msg.html        │    │
│  │(首页Tab) │  │ (聊天室)     │  │ (飘飘瓶留言)     │    │
│  └────┬────┘  └──────┬──────┘  └────────┬────────┘    │
│       │              │                   │              │
│       │    WebSocket │                  │ HTTP REST   │
└───────┼──────────────┼──────────────────┼─────────────┘
        │              │                  │
        ▼              ▼                  ▼
┌───────────────────────────────────────────────────────┐
│                  Node.js HTTP Server                    │
│  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ HTTP API     │  │ WebSocket Server              │  │
│  │ /api/messages│  │ ws 库                         │  │
│  └──────────────┘  └──────────────────────────────┘  │
│                         │                              │
│  ┌──────────────────────────────────────────────┐    │
│  │           Room Manager（内存 Map）            │    │
│  │  rooms: Map<roomCode, {clients, lastActivity}>│    │
│  └──────────────────────────────────────────────┘    │
│                         │                              │
│  ┌──────────────────────────────────────────────┐    │
│  │         Message Store（JSON 文件）            │    │
│  │  data/messages.json                          │    │
│  └──────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────┘
```

### 2.2 路由设计

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 首页（index.html） |
| `/{roomCode}` | GET | 聊天室（chat.html） |
| `/msg/{msgId}` | GET | 飘飘瓶留言页（msg.html） |
| `/api/messages` | POST | 创建留言 |
| `/api/messages/:id` | GET | 读取留言 |
| `/api/messages/:id` | DELETE | 销毁留言 |
| `/api/messages/:id/verify` | POST | 验证口令 |
| `/api/messages/:id/replies` | POST | 发送回复 |

---

## 三、功能模块详解

### 3.1 匿名聊天室

#### 3.1.1 进入房间

**入口方式**：
1. **随机进入**：点击「随机进入房间」，前端生成 6 位随机房间号（字母+数字）
2. **指定进入**：输入 4-8 位房间号，点击「进入」

**房间号规则**：
- 长度：4-8 位
- 字符：仅允许 `a-z` 和 `0-9`（小写化处理）
- 格式：`/^[a-z0-9]{4,8}$/`

**昵称生成**：
- 格式：`[形容词] + [名词]`（如「沉默的狐狸」「流浪的繁星」）
- 形容词库：30 个（如「温柔的」「孤独的」「遥远的」）
- 名词库：30 个（如「狐狸」「灰狼」「白鲸」）
- 重复检测：与当前房间已用昵称去重

#### 3.1.2 WebSocket 通信协议

**客户端 → 服务器消息**：

```javascript
// 加入房间
{ type: 'join', room: 'abc123', nick: '沉默的狐狸' }

// 发送文字消息
{ type: 'msg', text: '你好！', burn: 10, msgId: '1712345678_abc' }

// 发送图片
{ type: 'img', imgData: 'data:image/jpeg;base64,...', burn: 10, msgId: '...' }
```

**服务器 → 客户端消息**：

```javascript
// 加入成功
{ type: 'joined', id: 42, nick: '沉默的狐狸', count: 3 }

// 文字消息
{ type: 'msg', nick: '流浪的繁星', text: '你好', burn: 10, ts: 1712345678000, fromId: 43, msgId: '...' }

// 图片消息
{ type: 'img', nick: '...', imgData: '...', burn: 10, ts: ..., fromId: 43, msgId: '...' }

// 在线人数更新
{ type: 'online', count: 5, nicks: ['沉默的狐狸', '流浪的繁星', ...] }

// 系统消息
{ type: 'system', text: '房间人数已满' }
```

#### 3.1.3 阅后即焚机制

**消息生命周期**：
1. 发送消息时选择「消失时间」（3s / 10s / 30s / 60s / 关闭）
2. 接收方看到消息倒计时
3. 倒计时归零后，消息播放消散动画（opacity + scale + blur）并从 DOM 移除

**消失动画**：
```css
.msg-wrap.burning {
  transition: opacity .45s ease, transform .45s ease, filter .45s ease;
  opacity: 0;
  transform: scale(.88) translateY(-4px);
  filter: blur(6px);
}
```

#### 3.1.4 图片发送

**限制**：
- 格式：仅支持 `image/*`（自动转为 Base64 JPEG）
- 大小：压缩前最长边 ≤ 1200px，质量 0.78
- 最终大小：≤ 700KB（含 Base64 开销）

**流程**：
1. 用户选择图片 → FileReader 读取
2. Canvas 压缩（等比缩放 + JPEG 压缩）
3. 大小校验（≤ 500KB 压缩后）
4. WebSocket 发送 `type: 'img'` 消息
5. 接收方渲染图片，支持点击放大预览

#### 3.1.5 房间管理

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `ROOM_TTL_MS` | 5 分钟 | 房间无人后保留时间 |
| `MAX_ROOMS` | 2000 | 服务器最大房间数 |
| `MAX_CLIENTS_PER_ROOM` | 50 | 每房间最大人数 |
| `PING_INTERVAL` | 25 秒 | WebSocket 心跳间隔 |
| `PING_TIMEOUT` | 10 秒 | 未响应踢出时间 |

**清理机制**：
- 每 30 秒清理一次空房间（`clients.size === 0 && now - lastActivity > ROOM_TTL_MS`）
- WebSocket 心跳检测僵尸连接（`ws.ping()` + `_isAlive` 标志）

#### 3.1.6 聊天室 UI

**组件结构**：
- **顶部栏**：房间号 + 在线人数 + 分享按钮 + 新建按钮
- **聊天区**：消息列表 + 空状态引导
- **在线成员面板**：右侧浮动显示在线昵称
- **底部输入**：消失时间选择 + 昵称显示 + 输入框 + 表情 + 图片 + 发送

**消息气泡样式**：
- **自己消息**：渐变背景（`--accent → --accent2`），黑字
- **他人消息**：深色卡片背景，左边框显示昵称颜色
- **系统消息**：灰色背景，居中显示

---

### 3.2 飘飘瓶留言

#### 3.2.1 创建留言

**入口**：首页 → 飘飘瓶 Tab

**表单字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | textarea | 留言内容，≤ 5000 字 |
| `self_destruct` | checkbox | 是否阅后即焚 |
| `destruction_delay` | select | 阅后即焚延迟（10s/30s/60s/5min） |
| `password` | password | 可选口令，≥ 4 位 |

**API 调用**：
```javascript
POST /api/messages
Content-Type: application/json

{
  "content": "写下想说的话...",
  "self_destruct": true,
  "destruction_delay": 10,
  "password": "1234"
}
```

**响应**：
```json
{
  "id": "aB3xYz12",
  "expires_at": "2026-05-02T11:29:53.000Z",
  "has_password": true
}
```

**分享链接**：`{origin}/msg/{id}`

#### 3.2.2 口令保护

**安全机制**：
- 口令 SHA256 哈希后存储（明文不落盘）
- 验证时对比哈希值
- 错误不提示「存在但需口令」，避免枚举攻击

**流程**：
1. 创建时设置口令 → 存储 SHA256 哈希
2. 访问 `/msg/{id}` → API 返回 `need_password: true`
3. 显示口令验证界面 → 输入正确口令
4. 验证通过 → 加载完整留言

#### 3.2.3 阅后即焚（飘飘瓶）

**触发时机**：首次查看时启动倒计时

**流程**：
```javascript
// 服务器端
if (msg.self_destruct && !msg.first_viewed_at) {
  messages[id].first_viewed_at = now;
  messages[id].expires_at = new Date(now.getTime() + msg.destruction_delay * 1000);
  saveMessages(messages);
}
```

**销毁时机**：
- 阅后即焚消息：查看后 `destruction_delay` 秒销毁
- 普通留言：24 小时后销毁
- 手动销毁：用户点击「销毁」按钮

#### 3.2.4 匿名回复

**限制**：
- 内容 ≤ 2000 字
- 回复者无需口令（完全匿名）
- 回复随主留言一起销毁

**API 调用**：
```javascript
POST /api/messages/:id/replies
{
  "content": "这是回复...",
  "password": "1234"  // 若主留言有口令则必填
}
```

#### 3.2.5 飘飘瓶 UI

**页面状态**：
1. **口令验证态**：显示密码输入框
2. **正常态**：显示留言内容 + 回复列表 + 回复输入框
3. **销毁态**：显示「已销毁」提示

**组件结构**：
- **顶栏**：返回首页 + Logo + 倒计时徽章
- **留言卡片**：时间 + 阅后即焚/24h过期标签 + 内容
- **对话区**：回复列表
- **回复框**：textarea + 发送按钮
- **危险操作**：销毁按钮（需二次确认）

---

## 四、安全机制

### 4.1 限流防护

| 配置 | 值 | 说明 |
|------|-----|------|
| `RATE_LIMIT` | 10 次/分钟 | 每 IP 最大操作频率 |
| `RATE_WINDOW` | 60 秒 | 时间窗口 |

**防护位置**：
- 创建留言（`/api/messages`）
- 发送回复（`/api/messages/:id/replies`）

### 4.2 输入校验

| 检查项 | 限制 |
|--------|------|
| 留言内容 | 非空，≤ 5000 字 |
| 回复内容 | 非空，≤ 2000 字 |
| 房间号 | `/^[a-z0-9]{4,8}$/` |
| 昵称 | 截断至 24 字符 |
| 消息文本 | 截断至 500 字符 |
| 图片大小 | ≤ 700KB（Base64） |

### 4.3 路径遍历防护

```javascript
// server.js
const filePath = path.join(__dirname, urlPath);
if (!filePath.startsWith(__dirname)) {
  res.writeHead(403); res.end('Forbidden'); return;
}
```

### 4.4 密码安全

- 口令使用 **SHA256** 单向哈希（不可逆）
- 明文口令仅存在于用户本地

---

## 五、部署方案

### 5.1 本地开发

```powershell
# 启动服务器
& "C:\Users\Administrator\.workbuddy\binaries\node\versions\20.18.0\node-v20.18.0-win-x64\node.exe" "c:/Users/Administrator/WorkBuddy/20260324091103/server.js"
```

### 5.2 内网穿透（natapp）

```powershell
& "C:/Users/Administrator/Desktop/natapp.exe" -log stdout -authtoken 16dd3e13f4263f9e
# 穿透地址：http://s9376924.natappfree.cc
```

### 5.3 Docker 部署（ModelScope 创空间）

**Dockerfile**：
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

**注意**：ModelScope 创空间需将 `PORT` 改为 `3000`（已配置）

---

## 六、API 文档

### 6.1 创建留言

```
POST /api/messages
Content-Type: application/json

Request Body:
{
  "content": string,           // 留言内容（必填，≤5000字）
  "self_destruct": boolean,    // 是否阅后即焚
  "destruction_delay": number, // 销毁延迟秒数（默认10）
  "password": string | null    // 口令（可选，≥4位）
}

Response 200:
{
  "id": string,               // 留言ID（8位）
  "expires_at": string,        // 过期时间（ISO格式）
  "has_password": boolean      // 是否有口令保护
}

Response 400:
{ "error": "留言内容不能为空" }

Response 429:
{ "error": "操作太频繁，请稍后再试" }
```

### 6.2 读取留言

```
GET /api/messages/:id
GET /api/messages/:id/:password

Response 200:
{
  "id": string,
  "content": string,
  "created_at": string,
  "expires_at": string,
  "self_destruct": boolean,
  "destruction_delay": number,
  "first_viewed_at": string | null,
  "replies": Array<{
    "id": string,
    "content": string,
    "created_at": string
  }>
}

Response 401:
{ "error": "需要口令", "need_password": true }

Response 404:
{ "error": "留言不存在或已失效" }

Response 410:
{ "error": "该留言已销毁", "destroyed": true }
```

### 6.3 验证口令

```
POST /api/messages/:id/verify
Content-Type: application/json

Request Body:
{ "password": string }

Response 200:
{ "success": true, "verified": true }

Response 401:
{ "success": false, "error": "口令错误" }
```

### 6.4 发送回复

```
POST /api/messages/:id/replies
Content-Type: application/json

Request Body:
{
  "content": string,           // 回复内容（≤2000字）
  "password": string           // 若主留言有口令则必填
}

Response 200:
{
  "success": true,
  "reply": {
    "id": string,
    "content": string,
    "created_at": string
  }
}
```

### 6.5 销毁留言

```
DELETE /api/messages/:id

Response 200:
{ "success": true, "message": "留言已销毁" }

Response 404:
{ "error": "留言不存在" }
```

---

## 七、前端样式系统

### 7.1 设计令牌

```css
:root {
  /* 暗色主题 */
  --bg: #0d0d14;
  --surface: #13131e;
  --surface2: #1a1a28;
  --surface3: #1f1f30;
  --border: #252538;
  --text: #e8e8f5;
  --accent: #00e5ff;      /* 主色调（青蓝） */
  --accent2: #c400ff;      /* 副色调（紫） */
  --burn: #ff3366;        /* 销毁色（红） */
  --success: #00e5a0;      /* 成功色（绿） */
}
```

### 7.2 字体

| 用途 | 字体 |
|------|------|
| 正文 | Inter, system-ui, sans-serif |
| 代码/数字 | JetBrains Mono |

### 7.3 动效

| 动效 | 参数 |
|------|------|
| 主题切换 | `transition: .2s cubic-bezier(.4,0,.2,1)` |
| 消息入场 | `@keyframes msgIn`（fade + translateY + scale） |
| 消息销毁 | `opacity 0 + scale(.88) + blur(6px)` |
| 背景光晕 | `driftA/B` 20-24s 循环漂移 |

---

## 八、配置参数汇总

| 参数 | 值 | 位置 | 说明 |
|------|-----|------|------|
| `PORT` | 3000 | server.js | 服务器端口 |
| `ROOM_TTL_MS` | 5 分钟 | server.js | 房间存活时间 |
| `PING_INTERVAL` | 25 秒 | server.js | 心跳间隔 |
| `PING_TIMEOUT` | 10 秒 | server.js | 心跳超时 |
| `MAX_MSG_LEN` | 500 | server.js | 文字消息最大字符 |
| `MAX_IMG_BYTES` | 700KB | server.js | 图片最大字节 |
| `MAX_ROOMS` | 2000 | server.js | 最大房间数 |
| `MAX_CLIENTS_PER_ROOM` | 50 | server.js | 每房间最大人数 |
| `RATE_LIMIT` | 10 次 | server.js | IP 限流次数 |
| `RATE_WINDOW` | 60 秒 | server.js | IP 限流窗口 |
| `IMG_MAX_SIDE` | 1200px | chat.html | 图片最长边 |
| `IMG_QUALITY` | 0.78 | chat.html | JPEG 压缩质量 |
| `IMG_MAX_BYTES` | 500KB | chat.html | 压缩后图片限制 |

---

## 九、未来扩展方向

- [ ] 添加消息加密（WebCrypto API）
- [ ] 支持多语言界面
- [ ] 添加举报/屏蔽功能
- [ ] 房间密码保护
- [ ] 消息草稿保存
- [ ] 深色主题自定义
- [ ] PWA 离线支持

---

*本文档由 WorkBuddy AI 助手生成 | 项目：匿名聊天室 v1.0.0*
