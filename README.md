# 匿名聊天室 💬

一个简单、轻量级的匿名聊天和留言应用，无需注册，保护隐私。

## ✨ 功能特性

### 💬 匿名聊天室
- 实时 WebSocket 通信
- 无需注册，即开即用
- 支持创建和加入房间
- 每个房间最多 50 人
- 全局最多 500 个并发连接

### 🍶 飘飘瓶留言
- 匿名留言功能
- 支持口令保护
- 阅后即焚
- 24 小时自动过期
- 支持图片留言（≤ 700KB）

## 🚀 快速开始

### 本地运行

```bash
# 克隆仓库
git clone https://github.com/suixinmingche/Anonymous-Chat-room.git
cd Anonymous-Chat-room

# 安装依赖
npm install

# 启动服务器
node server.js
```

访问：http://localhost:3000

### 部署到 Oracle Cloud

详细部署步骤请查看 [部署文档](DESIGN.md)

## 📁 项目结构

```
.
├── server.js          # Node.js 服务器（HTTP + WebSocket）
├── index.html        # 首页
├── chat.html         # 聊天室页面
├── msg.html          # 飘飘瓶留言页面
├── package.json      # 项目配置
├── Dockerfile        # Docker 部署配置
└── data/            # 数据存储目录
    └── messages.json
```

## 🔧 技术栈

- **后端**: Node.js + ws (WebSocket)
- **前端**: 原生 HTML/CSS/JavaScript
- **数据存储**: JSON 文件
- **部署**: 支持 Oracle Cloud / ModelScope 创空间

## ⚙️ 配置

可以通过环境变量配置：

```bash
# 监听端口（默认 3000）
PORT=3000

# 其他配置在 server.js 中修改：
# - MAX_ROOMS: 最多房间数（默认 2000）
# - MAX_CLIENTS_PER_ROOM: 每房间人数（默认 50）
# - MAX_GLOBAL_CLIENTS: 全局连接数（默认 500）
```

## 📊 访问地址

- **首页**: http://your-domain/
- **聊天室**: http://your-domain/chat.html
- **飘飘瓶**: http://your-domain/msg.html

## 🛡️ 隐私保护

- 不收集用户信息
- 不保存聊天记录
- 留言 24 小时后自动删除
- 支持阅后即焚

## 📝 License

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📧 联系方式

- GitHub: [@suixinmingche](https://github.com/suixinmingche)

---

**⚠️ 免责声明**: 本项目仅供学习交流使用，请勿用于非法用途。
