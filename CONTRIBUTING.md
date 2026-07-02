# Contributing to Neo · 贡献指南

> **中文版在下方 / Chinese version below.**

Thanks for your interest in Neo! This guide explains how to contribute and — importantly — the **Contributor License Agreement (CLA)** you agree to when you submit code.

---

## English

### Ways to contribute
- **Report a bug**: open an issue with steps to reproduce, expected vs. actual behavior, and your environment (OS, Node version).
- **Suggest a feature**: open an issue describing the problem it solves, not just the solution.
- **Submit code**: fix a bug, add a feature, improve docs — via a Pull Request (PR).

### Development setup
```bash
# Requires Node 22+
npm install
npm test            # full unit test suite — must stay green
npm run perf-check  # performance/health gates (if applicable)
```

### Pull Request workflow
1. **Fork** the repo and create a branch from `main` (e.g. `fix/typo-in-readme`).
2. Make your change. Keep it **focused** — one logical change per PR.
3. **Add or update tests.** New behavior needs a test; fixes need a regression test.
4. Run `npm test` and make sure **everything is green** (no failing tests, no new warnings).
5. Follow the existing style: **ES Modules**, the project's lint rules, and the surrounding code's conventions.
6. Open the PR with a clear title and description of **what** changed and **why**.

### Code guidelines
- Match the style, naming, and comment density of the surrounding code.
- Prefer **small, real improvements** over large speculative rewrites.
- Don't commit secrets, credentials, or personal data.
- Don't break existing tests to make yours pass.

### 🔑 Contributor License Agreement (CLA) — please read
Neo is **dual-licensed** (open source under AGPL-3.0, plus a commercial license — see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)). To keep this model legally sound, **every contribution must be covered by a CLA**.

**By opening a Pull Request to this repository, you agree to the [Contributor License Agreement (CLA.md)](CLA.md).** In short, you certify that:
1. The contribution is **your original work** (or you have the right to submit it); and
2. You **grant the project maintainer a broad license** to your contribution — including the right to **relicense it under both AGPL-3.0 and commercial terms**.

You keep the copyright to your contribution; you're simply granting the maintainer the rights needed to keep dual-licensing the project. If you cannot agree to the CLA, please don't submit code (but you're still very welcome to open issues!).

### Code of Conduct
Be respectful and constructive. Harassment or abuse won't be tolerated. Maintainers may remove comments, commits, or contributors that violate this.

---

## 简体中文

感谢你对 Neo 的关注!本指南说明如何参与贡献,以及——很重要——你提交代码时所同意的**贡献者许可协议(CLA)**。

### 参与方式
- **报告 Bug**:开 issue,附复现步骤、预期与实际行为、你的环境(操作系统、Node 版本)。
- **建议功能**:开 issue,先说清它解决什么问题,而不只是给方案。
- **提交代码**:修 bug、加功能、改文档——通过 Pull Request(PR)。

### 开发环境
```bash
# 需要 Node 22+
npm install
npm test            # 全量单元测试——必须保持全绿
npm run perf-check  # 性能/健康门(如适用)
```

### Pull Request 流程
1. **Fork** 仓库,从 `main` 建分支(如 `fix/typo-in-readme`)。
2. 做你的改动,**保持聚焦**——一个 PR 只做一件逻辑上的事。
3. **补充或更新测试。** 新行为要有测试;修 bug 要有回归测试。
4. 跑 `npm test`,确保**全绿**(无失败测试、无新增警告)。
5. 遵循现有风格:**ES Module**、项目 lint 规则、以及周边代码的约定。
6. 提 PR 时用清晰的标题和描述,说明**改了什么**和**为什么**。

### 代码规范
- 与周边代码的风格、命名、注释密度保持一致。
- 优先做**小而真实的改进**,而非大而空的重写。
- 不要提交任何密钥、凭据或个人数据。
- 不要为了让自己的测试通过而破坏已有测试。

### 🔑 贡献者许可协议(CLA)——请务必阅读
Neo 采用**双许可**(AGPL-3.0 开源版 + 商业授权,见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md))。为让这个模式在法律上站得住,**每一份贡献都必须被 CLA 覆盖**。

**当你向本仓库提交 Pull Request,即表示你同意 [贡献者许可协议(CLA.md)](CLA.md)。** 简单说,你确认:
1. 该贡献是**你的原创**(或你有权提交);并且
2. 你**授予项目维护者一份宽泛的许可**——包括将你的贡献**同时以 AGPL-3.0 和商业条款再许可**的权利。

你仍然保留贡献的著作权;你只是授予维护者继续对项目进行双许可所需的权利。如果你无法同意 CLA,请不要提交代码(但依然非常欢迎你来开 issue!)。

### 行为准则
请保持尊重与建设性。骚扰或辱骂行为不被容忍。维护者可移除违反本准则的评论、提交或贡献者。
