# Commercial License · 商业授权

> **中文版在下方 / Chinese version below.**

Neo (Noe) is **dual-licensed**: free and open under **AGPL-3.0**, or under a **commercial license** for closed-source / proprietary use.

---

## English

### TL;DR
Neo's open-source edition is licensed under **GNU AGPL-3.0**. If you cannot or do not wish to comply with AGPL-3.0 (for example, you want to keep your own code closed-source), you need a **commercial license**. This document explains when you need one and how to get it.

### ✅ You do NOT need a commercial license if…
- You use Neo for **personal, educational, research, or evaluation** purposes; **or**
- The product/service that uses or modifies Neo is **itself released under AGPL-3.0** — i.e. you publish your source code, and if you run it as a network service, you also make that service's complete source available to its users (this is the core requirement of AGPL).

In these cases the free AGPL-3.0 license already covers you. You owe nothing.

### 💼 You DO need a commercial license if…
- You want to use, modify, bundle, or embed Neo in a **closed-source / proprietary** product **without** releasing your source under AGPL; **or**
- You offer Neo (modified or not) as a **hosted / SaaS / network service** and do **not** want to disclose your service's source code; **or**
- Your organization's legal or compliance policy **prohibits the use of AGPL** software.

### 📋 License tiers

Neo's commercial pricing is intentionally set at **roughly half of comparable market rates**, to keep adoption easy.

| Tier | Who it's for | Price *(≈ half of market)* |
|---|---|---|
| **Personal / OSS** | Individuals, students, researchers, and projects that are themselves AGPL | **Free** (use AGPL-3.0) |
| **Indie / Small team** | Solo developers or small teams using Neo in a closed-source product | **$99 / year** (or $10 / month) |
| **Business / SaaS** | Companies using Neo closed-source or as a hosted service | **from $475 / year** |
| **Enterprise** | Redistribution / embedding, priority support, SLAs, custom terms | **from $5,000 / year**, negotiable |

> **How these were set**: mainstream AI subscriptions run ~$20/mo (ChatGPT Plus, Claude Pro, Cursor Pro); open-source **dual-license** SaaS like **Sidekiq Pro** runs ~$950/yr, with redistribution/appliance tiers far higher (~$15k/yr). Neo's prices are pitched at about **half** of these comparables. As an early-stage project, terms are flexible and final pricing is confirmed in a signed agreement — the table is a starting point, not a binding quote.

### 🔑 What a commercial license grants
- A **waiver of the AGPL-3.0 copyleft obligations** for your licensed use — you may keep your own modifications and service code closed-source.
- The right to **use Neo in closed-source / proprietary products and services**.
- Optionally, by separate agreement: **priority support, service-level agreements (SLAs), custom features, and indemnification**.

A commercial license covers **only** the use it explicitly describes. It does not transfer ownership of Neo, and does not grant trademark rights.

### 📮 How to obtain a commercial license
1. Open an issue titled **`[Commercial License]`** at **https://github.com/BB20260410/neo-jarvis/issues**, describing your intended use; **or**
2. Email **`ilifelahepeq54@gmail.com`**.

Please include: your company, intended use (closed-source product / SaaS / internal tool), expected scale, and any support needs.

### 🔓 What the free tier actually contains (honest note)

Independent of the legal license above, the codebase ships a small **runtime feature gate** (`src/license/LicenseManager.js` — a local, offline Ed25519-signed license file; no phone-home, no account). Without a license file, Neo runs in the **free tier**, and the core of the product is fully usable: chat, debate rooms, three-layer memory, all local-brain features, voice/vision, and the self-evolution loop are **not** gated. What a paid Pro/Team license key currently unlocks in the running product: **squad & arena multi-AI room modes**, **more than 3 MCP servers**, **more than 3 room adapters**, and **multiple workspaces** (Team). Since the source is AGPL, you can patch these gates out in your own fork — buying a license funds development and, separately, grants the closed-source rights described above.

### ❓ FAQ
- **"We just want to try it internally."** Evaluation and internal testing are fine under AGPL. A commercial license is needed when you ship or operate it without complying with AGPL.
- **"We modified Neo and open-sourced our fork under AGPL."** Then you don't need a commercial license.
- **"Is AGPL 'viral'?"** AGPL requires that derivative works and network services built on Neo also be released under AGPL. The commercial license exists precisely to lift that requirement for you.

---

## 简体中文

### 一句话
Neo 的开源版采用 **GNU AGPL-3.0**。如果你无法或不愿遵守 AGPL-3.0(比如你想让自己的代码保持闭源),就需要一份**商业授权**。本文说明什么时候需要、以及怎么获取。

### ✅ 以下情况**不需要**商业授权
- 你把 Neo 用于**个人、学习、研究或评估**;**或**
- 使用或修改 Neo 的产品/服务**本身也以 AGPL-3.0 开源**——即你公开自己的源码;如果作为联网服务运行,也向用户提供该服务的完整源码(这是 AGPL 的核心要求)。

这些情况下,免费的 AGPL-3.0 已经覆盖你,你无需付费。

### 💼 以下情况**需要**商业授权
- 你想把 Neo 用于、修改后用于、或嵌入**闭源 / 专有**产品,而**不**按 AGPL 公开源码;**或**
- 你把 Neo(无论是否修改)作为**托管 / SaaS / 联网服务**提供,且**不**愿公开服务端源码;**或**
- 你所在机构的法务/合规政策**禁止使用 AGPL** 软件。

### 📋 授权档位

Neo 的商业定价**约为市面同类产品的一半**,让人更容易采用。

| 档位 | 适用对象 | 价格 *(约为市面一半)* |
|---|---|---|
| **个人 / 开源** | 个人、学生、研究者,以及本身即 AGPL 的项目 | **免费**(用 AGPL-3.0) |
| **独立开发者 / 小团队** | 个人或小团队在闭源产品中使用 Neo | **约 ¥720 / 年**(约 $99,或 $10/月) |
| **公司 / SaaS** | 公司闭源使用,或作为托管服务提供 | **约 ¥3,400 / 年起**(约 $475) |
| **企业** | 分发 / 嵌入、优先支持、SLA、定制条款 | **约 ¥3.6 万 / 年起**(约 $5,000),面议 |

> **定价依据**:主流 AI 订阅约 $20/月(ChatGPT Plus、Claude Pro、Cursor Pro);开源**双许可** SaaS 如 **Sidekiq Pro** 约 $950/年,分发/嵌入档更高(约 $1.5 万/年)。Neo 的价格定在这些对标的约**一半**。作为早期项目,条款灵活,最终价格以签署的协议为准——上表是起点,不构成正式报价。(人民币为按约 $1≈¥7.2 折算的近似值。)

### 🔑 商业授权给予你什么
- **豁免 AGPL-3.0 的 copyleft(传染)义务**——你可以让自己的改动和服务端代码保持闭源。
- 在**闭源 / 专有产品和服务中使用 Neo**的权利。
- 可另行约定:**优先技术支持、服务等级协议(SLA)、定制功能、责任担保**。

商业授权**仅覆盖其明确描述的用途**,不转移 Neo 的所有权,也不授予商标权利。

### 📮 如何获取商业授权
1. 在 **https://github.com/BB20260410/neo-jarvis/issues** 开一个标题为 **`[Commercial License]`** 的 issue,说明你的用途;**或**
2. 邮件联系 **`ilifelahepeq54@gmail.com`**。

请附上:公司名称、用途(闭源产品 / SaaS / 内部工具)、预计规模、是否需要技术支持。

### 🔓 free 档到底有什么(诚实说明)

与上面的法律许可相互独立,代码里带有一个小的**运行时功能门**(`src/license/LicenseManager.js` —— 本地离线 Ed25519 签名文件校验;不联网、不注册账号)。不放 license 文件时,Neo 以 **free 档**运行,产品核心完全可用:聊天、辩论房间、三层记忆、全部本地脑功能、语音/视觉、自我进化飞轮都**不**受门控。付费 Pro/Team license key 当前在运行产品中解锁的是:**squad 与 arena 多 AI 房间模式**、**超过 3 个 MCP server**、**超过 3 个房间适配器**、**多 workspace**(Team)。源码是 AGPL 的,你完全可以在自己的 fork 里改掉这些门 —— 购买授权是在支持开发,同时(另一个维度上)获得上文所述的闭源权利。

### ❓ 常见问题
- **"我们只是想内部试用。"** 评估和内部测试在 AGPL 下没问题。当你在不遵守 AGPL 的前提下对外发布或运营时,才需要商业授权。
- **"我们改了 Neo,并把 fork 以 AGPL 开源了。"** 那就不需要商业授权。
- **"AGPL 会'传染'吗?"** AGPL 要求基于 Neo 的衍生作品和联网服务也以 AGPL 发布。商业授权的作用,正是为你解除这个要求。

---

> ⚖️ **Disclaimer / 免责声明**: This document is an informational template, not legal advice. For significant or high-value commercial arrangements, have it reviewed by a qualified lawyer. / 本文档是信息性模板,不构成法律意见。涉及重要或大额商业安排时,请交由专业律师审阅。
