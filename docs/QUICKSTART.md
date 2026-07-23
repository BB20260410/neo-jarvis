# Quick start · Neo 贾维斯

约 10 分钟在本机跑通 **Home** 对话入口。

## 要求

- macOS / Linux（Windows 可用 WSL）
- **Node.js 22**（见仓库 `.nvmrc`）
- 可选：本地模型（Ollama / LM Studio）或自备云 API key

## 三步

```bash
git clone https://github.com/BB20260410/neo-jarvis.git
cd neo-jarvis
npm install
npm run verify:node22
npm run start:noe
```

浏览器打开（**必须**带 owner token）：

```bash
open "http://127.0.0.1:51835/home.html?t=$(cat ~/.noe-panel/owner-token.txt)"
```

首次启动会在 `~/.noe-panel/owner-token.txt` 生成 token。**不要**把 token 提交进 git 或发到公开帖。

## 日常配置

1. Home → **设置**：模型 Base URL + 模型 ID + 语音开关（不必手改 `.env`）。
2. 密钥：复制 `.env.example` → `.env` 仅填你需要的项，或专家面板「完整模型/密钥」。
3. 安全：自进化 **默认 dry-run**；真改需双开关，见 [`SECURITY.md`](../SECURITY.md)。

## 演示 60 秒

见 [`DEMO_60S.md`](./DEMO_60S.md)。

## 出问题

| 现象 | 处理 |
|------|------|
| 无法对话 | URL 是否含 `?t=`；token 是否 ≥32 字符 |
| 端口占用 | `PORT=51836 npm start`（勿与文档默认混用时写清） |
| Node 版本 | `npm run verify:node22` / 安装 Node 22 |
| 想开真改 | **先读 SECURITY**；演示与默认路径不要开 |

更完整说明见根目录 [`README.md`](../README.md)。
