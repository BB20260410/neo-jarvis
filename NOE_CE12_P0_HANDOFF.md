# CE12 P0 交接 - Noe / Neo 贾维斯

更新时间：2026-06-02  
交接对象：下一位执行者 / 下一窗口 / CE10 交付验收。

## 1. 一句话结论

Noe / Neo 贾维斯的 CE12 P0 产品化基础已进入文档收口：可以继续验收，但完整 Jarvis 产品未完成。

## 2. 当前边界

- 工作区：`/Users/hxx/Desktop/Neo 贾维斯`
- 原项目：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`
- Noe 端口：51835
- 原项目端口：51735
- BaiLongma 只读审计镜像：`BaiLongma-audit/`

禁止事项：

- 不在原项目目录开发。
- 不全量复制 BaiLongma。
- 不开启未审计真实工具执行。
- 不真实外发、删除或批量移动。
- 不把阶段完成写成完整产品完成。

## 3. 先读文件

1. `NOE_CE12_P0_DOCS_CANONICAL.md`
2. `NOE_CE12_P0_OPERATIONS_MANUAL.md`
3. `NOE_CE12_P0_EVIDENCE_INDEX.md`
4. `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`
5. `package.json`
6. `src/server/routes/noe.js`
7. `public/src/web/brain-ui.js`
8. `scripts/ce12-p0-verify-all.mjs`

旧 `NOE_PHASE9_DOCS_CANONICAL.md` 只作为历史参考，里面有 CE12 前的过期结论。

## 4. 接手命令

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run verify:node22
npm run verify:p0:docs
npm run verify:p0:fast
```

验收前跑：

```bash
npm run verify:p0
```

如果要证明 51835 不影响 51735，并且原项目 51735 已经运行：

```bash
npm run test:p0:funcverify
```

## 5. 当前已完成的 P0

- FR-P0-1 Node22 fail-fast / re-exec gate。
- FR-P0-2 旧 Brain UI e2e deprecated 转发到新 P0 e2e。
- FR-P0-3 Brain UI 执行可视化 7 个锚点。
- FR-P0-4 NoeLoop 最小 Act Pipeline，危险操作默认审批或阻断。
- FR-P0-5 Electron smoke。
- FR-P0-6 交付证据闭环。
- FR-P0-7 MiniMaxSpawnAdapter patch-only 原型。

## 6. 后续补审点

- MiniMax M3 中文侧审计需要补一次有 assistant 审计文本的可复验证据。
- Browser/iab 当前不可用，UI 交互证据使用 Playwright 降级。
- `verify:p0:fast` 与 full evidence 建议拆分 latest 文件，避免 fast 覆盖 full latest。
- Electron 仍未签名、公证或 DMG 分发。
- Voice、Social I/O、完整 Jarvis 体验仍未实现。

## 7. 给下一窗口的 copy-paste prompt

```text
请接手 Noe / Neo 贾维斯 CE12 P0。

工作区只用：
/Users/hxx/Desktop/Neo 贾维斯

不要改原项目：
/Users/hxx/Desktop/00_项目/05_Claude可视化面板

先读：
1. NOE_CE12_P0_DOCS_CANONICAL.md
2. NOE_CE12_P0_OPERATIONS_MANUAL.md
3. NOE_CE12_P0_HANDOFF.md
4. NOE_CE12_P0_EVIDENCE_INDEX.md
5. NOE_CE12_P0_REQUIREMENTS_CANONICAL.md

先跑：
npm run verify:node22
npm run verify:p0:docs
npm run verify:p0:fast

当前口径：
CE12 P0 产品化基础可继续验收，但完整 Jarvis 产品未完成。
危险操作默认审批或 blocked_safety，不做真实外发、删除、批量移动。
MiniMax M3 只做中文侧审计辅助，只有可复验证硬风险才阻断。

如果进入 CE10 交付验收，跑 npm run verify:p0，并把 exit code、报告路径、截图/日志路径写入验收文档。
not done until: README/交接/变更说明/操作手册/证据索引都和真实命令、真实文件路径一致。
```

## P1 当前入口补充 - 2026-06-02

- 当前事实源仍以 `NOE_CE12_P0_DOCS_CANONICAL.md` 为准；完整 Jarvis 产品未完成。
- CE12 P0 产品化基础已完成验收，后续进入 P1 产品化收敛。
- 新增/收敛入口：`NOE_M3_SUGGESTION_ONLY.md`、`NOE_PRODUCT_NEXT_PLAN.md`、`NOE_CE12_P0_EVIDENCE_INDEX.md`、`NOE_CE12_P0_ACCEPTANCE_CANONICAL.md`、`NOE_CE12_P0_RETROSPECTIVE_CANONICAL.md`。
- M3 suggestion-only：M3 可提出建议、缺口扫描和 patch plan；不得直接 shell/read/write/apply_patch/delete/move。
- 新增重点：内部 `POST /api/noe/m3/suggest`、Memory M1、本地只读文件索引、full/fast/partial evidence latest 分离。
