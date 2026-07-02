<div align="center">

<img src="assets/screenshot-cognitive.png" width="760" alt="Neo 认知界面"/>

# ⚡ Neo · Noe

## 你的私人 AI 操作系统 —— 有记忆、会成长、只属于你

*The personal AI OS that remembers, evolves, and runs entirely on your machine.*

[![tests](https://github.com/BB20260410/neo-jarvis/actions/workflows/test.yml/badge.svg)](https://github.com/BB20260410/neo-jarvis/actions/workflows/test.yml) &nbsp;
![License](https://img.shields.io/badge/License-AGPL--3.0-black) &nbsp;
![Node](https://img.shields.io/badge/Node-22.x-black) &nbsp;
![Local--First](https://img.shields.io/badge/Local--First-Privacy%20by%20default-black) &nbsp;
![Self--Evolving](https://img.shields.io/badge/%F0%9F%94%84-Self--Evolving-black)

### 让每个人都拥有一个真正懂自己、且会自我进化的 AI 副驾。

**🌐 [English](README.md) · 简体中文 · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)**

</div>

---

## 🌌 为什么是 Neo

今天的 AI,聪明,却**健忘、被动、住在别人的服务器上**。你每天重新介绍自己,它答完就忘;你合上盖子,它与你再无关系。

**Neo 想成为另一种存在。**

一个记得你、看得见你屏幕、听得懂你说话的伙伴;一个用**一群** AI 模型替你并肩作战、而非单打独斗的工作台;一个在你休息时**自己反思、自己改进、把自己变得更好**的系统。

而且——它**只属于你**。跑在你自己的机器上,数据、记忆、思考都在本地。这不是一个云端产品的客户端,这是**你的** AI OS。

---

## ✨ Neo 能做什么

> 🔄 **会自我进化** — 它能反思现状、给自己定进化方向、**真的改写自己的源码**、跑测试验证、通过双绿门与多模型复核后才落地。AI 不再是静止的工具,而是会成长的系统。

> 🧩 **一群 AI,而非一个** — 本地主脑 + 复核脑 + 云端强模型,按任务分工、交叉验证。一个模型的幻觉,会被另一个当场逮住。

> 💾 **永不遗忘** — 三层持久记忆(语义知识库 + 文件记忆 + 记忆图谱),跨会话记得你,还会把学到的经验主动带进下一次对话。越用越懂你。

> 🎙️👁️🤝 **能听、能看、会主动** — 本地语音收发、视觉读屏,以及克制式的主动陪伴——在对的时机开口,而不是刷屏打扰。

> 🪞 **透明的内心** — 意识流、目标系统、期望账本、情感状态(VAD / 全局工作区 GWT)全部可视化。你看得见它在想什么,而不是一个黑盒。

---

## 📸 真实界面

> 均为 Neo 真实运行界面(本地 `http://127.0.0.1:51835`)。

**主工作台** — 直接聊天 / 多模型协作 / 项目拆活 / 工具终端,一站进入
![主工作台](assets/screenshot-index.png)

**内心透视** — 3D 态势地球,把运行状态、自检、任务、记忆尽收眼底
![内心透视](assets/screenshot-mind.png)

---

## 🔬 「自我进化」真的在跑

```
   反思自身数据(哪里能更好?)
            │
            ▼
   自主生成进化方向 ──► 价值锚:有技术着力点?可验证?非刷分?
            │
            ▼
   模型改写自己的源码(优先小而真的逻辑改进)
            │
            ▼
   双绿门:改动前测试全绿 + 改动后仍全绿  ──►  失败即回滚
            │
            ▼
   多模型复核 ──► 通过则落地 + 记账 / 失败则诚实记录
```

价值锚 + reward-hacking 熔断,确保它**不为"看起来在进化"而刷无意义改动**。这不是路线图上的愿景——这是**现在就在运转**的机制。

---

## 🚀 Roadmap · 我们要抵达的地方

> 以下为**产品愿景与目标**,标注了当前进度:🟢 已跑通 / 🟡 进行中 / 🔵 规划中。

**阶段一 · 活着的个人 AI OS** 🟢
本地优先架构、多 AI 集群、三层记忆、语音/视觉/主动陪伴、自我进化飞轮——**已跑通**。

**阶段二 · 越来越会进化** 🟡
提高自我进化的落地率与探索广度、让记忆图谱真正参与推理、扩展可自主调用的工具生态。让 Neo 每一天都比昨天更强一点。

**阶段三 · 无缝的全模态副驾** 🔵
语音、视觉、文本、工具一体化;更聪明的主动陪伴(懂你何时需要、何时该安静);跨设备延续同一个"它"。

**终极愿景 · 每个人的 Jarvis** 🔵
一个完全属于你、跑在你自己机器上、越用越懂你、能替你思考也能替你行动的个人 AI 操作系统。不是租来的智能,是你自己的。

---

## 🛠️ 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js 22.x + Express + WebSocket,全 ES Module |
| 前端 | 原生 Web GUI(无重框架),可打包为 macOS `.app` |
| 数据 | SQLite 数据底座 + 本地向量检索 |
| 模型 | 本地经 LM Studio / Ollama(qwen、gemma 等);云端可选接入 |
| 质量 | 全量单元测试 + 端到端 walkthrough + 性能/健康审计门 |

---

## 🚀 快速开始

**需要 Node.js 22.x** —— `npm start` 会经过版本守卫(`scripts/ensure-node22.mjs`),严格要求 Node 22 大版本,不是"22 以上都行"。若你的默认 `node` 是其他大版本,请安装 Node 22(如 `nvm install 22`),或用 `NOE_NODE_BIN` 指向一个 Node 22 可执行文件。

```bash
# 1) 安装依赖
npm install --omit=dev   # 纯运行 —— node_modules 约 210 MB,足够把面板跑起来
# npm install            # 完整安装(开发/跑测试)—— 约 850 MB+,含 Electron、Playwright、Vitest 等

# 2) 启动(默认 127.0.0.1:51835,仅本地监听)
npm start

# 3) 打开启动日志里打印的那个 URL —— 它带着你的 owner token:
#    🚀 Noe @ http://127.0.0.1:51835/?t=<owner-token>
```

> **重要:** 必须打开日志里**带 `?t=...` 的完整 URL**。直接开 `http://127.0.0.1:51835` 能看到页面骨架,但所有 API 都会返回 401 —— `?t=` 里的 token 才是 owner 身份凭证(前端会把它存进 `sessionStorage`)。macOS 上在交互终端 `npm start` 会自动用浏览器打开正确的 URL。`.env` 文件可选 —— 主要开关见 [`.env.example`](.env.example)。

<details>
<summary>中国大陆安装加速</summary>

```bash
npm config set registry https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```
</details>

---

## 🧭 首次运行会看到什么

- **没有本地模型、没有云端 key 时**,面板能正常启动、每个页面都能逛,但聊天会失败 —— Neo 至少需要一个"脑子"。最快的第一步:跑起 [LM Studio](https://lmstudio.ai)(默认 `http://127.0.0.1:1234/v1`)或 [Ollama](https://ollama.com)(默认 `http://127.0.0.1:11434`)加载任意能用的本地模型,然后 `cp .env.example .env`,把 `NOE_LMSTUDIO_URL` / `NOE_OLLAMA_URL` 指过去。装了 Claude Code / Codex / Gemini CLI 的话会被自动识别为插件。
- **语音和视觉需要伴生本地服务**(Whisper STT 服务、经 OpenAI 兼容端点提供的视觉模型),开关都在 `.env.example`。**自我进化默认关闭**(`NOE_SELF_EVOLUTION=1` 开启;不设 `NOE_SELF_EVOLUTION_REAL_APPLY=1` 时始终是 dry-run,不会真改代码)。
- 一批本地"内心生活"功能(心跳/内心独白/目标/情感)默认经 `free` 自主档位通电;想要一个安静的面板,设 `NOE_AUTONOMY_PROFILE=off`。

---

## 🎯 诚实说明

Neo 是一个**个人 / 实验性项目**,隐私优先、本地优先。**已跑通**的能力(自我进化飞轮、多 AI 协作、三层记忆、语音/视觉)都是真实运转的,不是 demo;**Roadmap 阶段二、三与终极愿景是我们要抵达的目标,尚未完成**。这里展示的是一个真实、正在生长的系统,以及它想成为的样子。

---

## 📄 License

**AGPL-3.0。** 个人、学习、开源项目可自由免费使用——若你修改 Neo 或将其作为联网服务运行,你的改动也必须以 AGPL 开源。**在闭源商业产品中使用 Neo 需另行获取商业授权** —— 请开 issue 咨询。

**免费与付费的真实边界:** 不放任何 license 文件时,Neo 以 **free 档**运行,产品核心完全可用 —— 聊天、辩论房间、三层记忆、全部本地脑功能、语音/视觉、自我进化飞轮都**不**受 license 门控。付费 Pro/Team license 当前解锁的是:**squad 与 arena 多 AI 房间模式**、**超过 3 个 MCP server**、**超过 3 个房间适配器**、**多 workspace**(Team)。license 校验是本地 Ed25519 签名文件 —— 不联网、不注册账号。这是 AGPL 源码,你当然可以在自己的 fork 里改掉这些门;付费授权的意义在于支持开发,以及获得 AGPL 给不了的权利(闭源商用)。

💼 **商业授权** → [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)  ·  🤝 **想参与贡献?** → [CONTRIBUTING.md](CONTRIBUTING.md)

<div align="center">
<br/>
<sub>⚡ Neo · 让每个人都拥有一个真正属于自己、会自我进化的 AI。</sub>
</div>
