<div align="center">

<img src="assets/screenshot-cognitive.png" width="760" alt="Neo cognitive interface"/>

# ⚡ Neo · Noe

## Your personal AI operating system — one that remembers, grows, and belongs only to you

*The personal AI OS that remembers, evolves, and runs entirely on your machine.*

[![tests](https://github.com/BB20260410/neo-jarvis/actions/workflows/test.yml/badge.svg)](https://github.com/BB20260410/neo-jarvis/actions/workflows/test.yml) &nbsp;
![License](https://img.shields.io/badge/License-AGPL--3.0-black) &nbsp;
![Node](https://img.shields.io/badge/Node-22.x-black) &nbsp;
![Local--First](https://img.shields.io/badge/Local--First-Privacy%20by%20default-black) &nbsp;
![Self--Evolving](https://img.shields.io/badge/%F0%9F%94%84-Self--Evolving-black)

### Give everyone an AI companion that truly understands them — and improves itself.

**🌐 English · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)**

</div>

---

## 🌌 Why Neo

Today's AI is smart — but **forgetful, passive, and living on someone else's servers**. You reintroduce yourself every day; it forgets the moment it answers. Close the lid, and it's a stranger again.

**Neo aims to be something else.**

A companion that remembers you, sees your screen, and hears you speak; a workspace where **a team** of AI models fights alongside you instead of one model going it alone; a system that, while you rest, **reflects on itself, improves itself, and makes itself better.**

And it's **yours alone.** It runs on your own machine — data, memory, and thinking all stay local. This isn't a thin client for a cloud product. This is **your** AI OS.

---

## ✨ What Neo can do

> 🔄 **It evolves itself** — Neo reflects on its state, sets its own improvement direction, **rewrites its own source code**, runs the tests, and only ships after passing a double-green gate and multi-model review. AI as a growing system, not a frozen tool.

> 🧩 **A team of AIs, not one** — a local primary brain + a reviewer brain + strong cloud models, split by task and cross-verifying each other. One model's hallucination gets caught by another.

> 💾 **Never forgets** — three-layer persistent memory (semantic knowledge base + file memory + memory graph). It remembers you across sessions and proactively brings learned lessons into the next conversation. The more you use it, the better it knows you.

> 🎙️👁️🤝 **Hears, sees, and reaches out** — local speech in/out, a vision model that reads your screen, and *restrained* proactivity — it speaks up at the right moment instead of spamming you.

> 🪞 **A transparent inner life** — stream of consciousness, goals, expectations, and emotional state (VAD / Global Workspace) all visualized. You can *see what it's thinking*, not a black box.

---

## 📸 Real interface

> All screenshots are Neo running locally at `http://127.0.0.1:51835`.

**Main workspace** — direct chat / multi-model collaboration / project breakdown / tools & terminal, all in one entry
![Main workspace](assets/screenshot-index.png)

**Inner view** — a 3D situational globe showing runtime state, self-checks, tasks, and memory at a glance
![Inner view](assets/screenshot-mind.png)

---

## 🔬 Self-evolution is actually running

```
   Reflect on its own data (what could be better?)
            │
            ▼
   Autonomously propose a direction ──► Value anchor: has a real technical target? verifiable? not just gaming the score?
            │
            ▼
   Model rewrites its own source (prefer small, real logic improvements)
            │
            ▼
   Double-green gate: tests green before AND after the change  ──►  roll back on failure
            │
            ▼
   Multi-model review ──► ship + log on pass / honestly record on fail
```

A value anchor plus a reward-hacking circuit breaker keep it from churning meaningless changes just to "look like it's evolving." This is not a roadmap item — it's a mechanism **running today**.

---

## 🚀 Roadmap · Where we're headed

> The following is the **product vision and goals**, with honest progress markers: 🟢 shipped / 🟡 in progress / 🔵 planned.

**Phase 1 · A living personal AI OS** 🟢
Local-first architecture, multi-AI cluster, three-layer memory, voice/vision/proactive companionship, and the self-evolution loop — **shipped and running**.

**Phase 2 · Getting better at evolving** 🟡
Raise the landing rate and exploration breadth of self-evolution, make the memory graph truly participate in reasoning, and expand the toolset it can call autonomously. Make Neo a little stronger every day.

**Phase 3 · A seamless multimodal co-pilot** 🔵
Voice, vision, text, and tools unified; smarter proactivity (knowing when you need it and when to stay quiet); the same "it" continued across your devices.

**Ultimate vision · A Jarvis for everyone** 🔵
An AI operating system that is entirely yours, runs on your own machine, knows you better the more you use it, and can both think and act on your behalf. Not rented intelligence — your own.

---

## 🛠️ Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js 22.x + Express + WebSocket, all ES Modules |
| Frontend | Vanilla Web GUI (no heavy framework), packageable as a macOS `.app` |
| Data | SQLite as the data foundation + local vector search |
| Models | Local via LM Studio / Ollama (qwen, gemma, etc.); optional cloud models |
| Quality | Full unit test suite + end-to-end walkthrough + performance/health audit gates |

---

## 🚀 Quick start

**Requires Node.js 22.x** — `npm start` goes through a version guard (`scripts/ensure-node22.mjs`) that requires Node 22 specifically, not just "22 or newer". If your default `node` is another major version, install Node 22 (e.g. `nvm install 22`) or point `NOE_NODE_BIN` at a Node 22 binary.

```bash
# 1) Install dependencies
npm install --omit=dev   # runtime only — ~210 MB in node_modules, enough to run the panel
# npm install            # full install for development / running tests — ~850 MB+ (adds Electron, Playwright, Vitest…)

# 2) Start (defaults to 127.0.0.1:51835, local-only)
npm start

# 3) Open the URL printed in the startup log — it carries your owner token:
#    🚀 Noe @ http://127.0.0.1:51835/?t=<owner-token>
```

> **Important:** open the exact URL from the log, **with the `?t=...` part**. Opening plain `http://127.0.0.1:51835` loads the page shell, but every API call will return 401 — the `?t=` token is what authenticates you as the owner (the frontend stores it in `sessionStorage`). On macOS, `npm start` from an interactive terminal auto-opens the correct URL in your browser. A `.env` file is optional — see [`.env.example`](.env.example) for the main switches.

<details>
<summary>Slow install in mainland China? / 中国大陆安装加速</summary>

```bash
npm config set registry https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```
</details>

---

## 🧭 First run — what to expect

- **The UI is currently Chinese-first.** An English interface is on the roadmap; for now the codebase comments, logs, and this README are the English entry points.
- **With no local model and no cloud key,** the panel starts and you can explore every page, but chat replies will fail — Neo needs at least one brain. The quickest first step: run [LM Studio](https://lmstudio.ai) (default `http://127.0.0.1:1234/v1`) or [Ollama](https://ollama.com) (default `http://127.0.0.1:11434`) with any capable local model, then copy `.env.example` to `.env` and point `NOE_LMSTUDIO_URL` / `NOE_OLLAMA_URL` at it. Cloud CLIs (Claude Code, Codex, Gemini CLI) are auto-detected as plugins if installed.
- **Voice and vision need companion local services** (a Whisper STT server, a VLM served over an OpenAI-compatible endpoint) — each has its switch in `.env.example`. **Self-evolution is off by default** (`NOE_SELF_EVOLUTION=1` to arm it; it stays in dry-run unless `NOE_SELF_EVOLUTION_REAL_APPLY=1`).
- A set of local "inner life" features (heartbeat, inner monologue, goals, affect) is on by default via the `free` autonomy profile; set `NOE_AUTONOMY_PROFILE=off` for a quiet panel.

---

## 🎯 Honest note

Neo is a **personal / experimental project**, privacy-first and local-first. The **shipped** capabilities (self-evolution loop, multi-AI collaboration, three-layer memory, voice/vision) genuinely run — they're not demos. **Roadmap phases 2 & 3 and the ultimate vision are goals we're working toward, not yet complete.** What you see here is a real, growing system — and what it aspires to become.

---

## 📄 License

**AGPL-3.0.** Free for personal, educational, and open-source use — if you modify Neo or run it as a network service, your changes must also be open-sourced under AGPL. **Using Neo inside a closed-source commercial product requires a separate commercial license** — open an issue to inquire.

**What's free vs. paid, honestly:** without any license file Neo runs in the **free tier**, and the core of the product is fully usable — chat, debate rooms, three-layer memory, all local-brain features, voice/vision, and the self-evolution loop are **not** license-gated. What a paid Pro/Team license currently unlocks: **squad & arena multi-AI room modes**, **more than 3 MCP servers**, **more than 3 room adapters**, and **multiple workspaces** (Team). The license check is a local Ed25519-signed file — no phone-home, no account. And since this is AGPL source, you can of course patch those gates out in your own fork; the paid license exists to fund development and to grant what AGPL can't (closed-source commercial use).

💼 **Commercial licensing** → [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)  ·  🤝 **Want to contribute?** → [CONTRIBUTING.md](CONTRIBUTING.md)

<div align="center">
<br/>
<sub>⚡ Neo · Give everyone an AI that is truly their own — and evolves.</sub>
</div>
