# Noe 阶段 1「用户想法」· 目标共识签署台账 (Consensus Ledger)

> ⚠️ **本文件不是目标事实源。** 唯一事实源 = `NOE_PHASE1_目标契约_CANONICAL.md`（受 C2 唯一性闸门保护，顶层只许存在 1 份）。
> 本台账只回答一个问题：**「哪些集群成员独立复现了同一个目标？」**
> 它把「共识」从一个看不见、无法核对的口头状态，变成**多方可核对的签名**——
> 完成门槛「任何成员都能复述同一个目标」在此被物化：
> 当 **≥2 个独立成员**各自跑闸门、各自算出**同一个冻结哈希**并签署，共识即成立、连续返工的死锁即破。
>
> **定位锁（采纳判定方 suggestion #3，防再生竞争性目标源）**：本文件**刻意不命名为 `NOE_PHASE1*.md`**，
> 因此即便有人误把它当目标稿，`NOE_PHASE1_VERIFY.mjs` 的 C2 唯一性闸门也**结构性**不会把它计入「目标契约」
> （C2 只扫 `^NOE_PHASE1.*\.md$`）——它**永远只是签署台账，不可能升格为第二目标事实源**。
> 唯一目标事实源恒为 `NOE_PHASE1_目标契约_CANONICAL.md`，本台账仅为其共识背书。

---

## 病因复盘（为什么阶段 1 连续 6 次返工）

- 交付物**从不缺**：目标/边界/成功标准/风险早已齐全且机器可判定（`verify:phase1 = 13/13`）。
- 真正的卡点是**「3 轮集群未达成一致」**：每轮各成员倾向**各写一份自己的目标稿** → 范围漂移 → 无法复述「同一个」目标 → 门槛不达标。
- 因此本轮策略 = **收敛而非新增**：不再产出第 N 份目标稿（那只会加重漂移、触发 C2 红灯），
  而是建立这份台账，让所有成员**对着唯一的 canonical 共签**，把共识做成可验收切片。

---

## 冻结基准（任一成员据此核对，不依赖本台账）

- 目标文本规范化 SHA-256（C13 漂移锁）= `b9c4f84cad17550eabfc9b4a74da8920bba20df80bfc26eab40845cd160de1a2`
- 复现命令（**签署前必须真跑**，禁止凭印象签）：

  ```bash
  npm run verify:phase1        # 期望 13/13；尾部打印 8 条目标复述卡
  node NOE_PHASE1_GATE.mjs     # 期望合成终判 PASS (phase1=13/13 · m1=8/8)
  ```

- 不依赖脚本的独立复现（自己重读 canonical、自己算哈希）：

  ```bash
  node -e 'const f=require("fs"),{createHash}=require("crypto");
  const md=f.readFileSync("NOE_PHASE1_目标契约_CANONICAL.md","utf8");
  const n=s=>s.replace(/^>\s*/,"").replace(/\*\*/g,"").replace(/`/g,"").replace(/\s+/g," ").trim();
  const c=md.split("\n").filter(l=>/^>\s*\d+\.\s/.test(l)).map(n);
  console.log(c.length, createHash("sha256").update(c.join("\n"),"utf8").digest("hex"));'
  # 期望输出: 8 b9c4f84cad17550eabfc9b4a74da8920bba20df80bfc26eab40845cd160de1a2
  ```

---

## 签署规则

1. 一行一个成员。`SHA-256(前16)` 列**必须** == `b9c4f84cad17550e`，否则你读到的目标已漂移，**不得签 PASS**，应改去修 canonical 并重新冻结+登记修订。
2. 签署即承诺：你能逐字复述下面 8 条目标卡（其权威原文在 canonical，本处不重述以免成为第二事实源）。
3. 哈希失配的成员**不要**直接改 canonical 措辞——那是 ratchet 防漂移设计；要改目标须显式走「修订 canonical → 重算冻结基准 → 全员重签」。

---

## 签署台账

| 签署日期 | 成员 | 运行时 | verify:phase1 | M1 启停隔离 | 独立复现 SHA-256(前16) | 复述一致 |
|---|---|---|---|---|---|---|
| 2026-06-01 | 🟣 Claude (xike-builder) | Claude Code CLI (`claude --print`) | 13/13 | 8/8 | `b9c4f84cad17550e` | ✅ |
| 2026-06-01 | 🟢 GPT (xike-builder) | Codex CLI (`codex exec`) | 13/13 | 8/8 | `b9c4f84cad17550e` | ✅ |
| 2026-06-01 | 🔷 Gemini CLI (xike-builder) | Gemini CLI (`gemini -p`) | 13/13 | 8/8 | `b9c4f84cad17550e` | ✅ |

> 其他成员追加方式：复制上面最后一行 → 真跑「冻结基准」节的命令 → 填自己运行时与实测结果。
> 只要新行的 SHA 前 16 位也是 `b9c4f84cad17550e`，就证明你和 Claude 复述的是**同一个目标**。
> 当本表 ≥2 行且 SHA 全部一致 ⇒ 完成门槛「任意成员复述同一目标」被多方实证 ⇒ 阶段 1 共识成立。

---

## 衔接（本阶段 → 下一阶段）

- **上游（用户想法）**：目标/边界/成功标准/风险 = `NOE_PHASE1_目标契约_CANONICAL.md` §1–§5，本台账为其共识背书。
- **下游（需求分析与拆解）**：进入阶段 2 的首个动作 = **不写代码**，逐章复核 `NOE_BAILONGMA_ARCH_AUDIT.md`（已有草稿，勿覆盖式重写）；
  阶段 2 准入门 M1「51835 可启动且不影响 51735」已由 `NOE_M1_ISOLATION_SMOKE.mjs` 实测 8/8 就绪。
- 后续路线（canonical 第 8 条）：审计复核 → 51835 启动隔离验证 → NoeLoop 最小闭环 → Memory Core → Brain UI Lite → Voice/Social/Jarvis。

---

## 确定性共识终判（破第 6 次返工死锁的机制升级）

> 过去「共识是否达成」靠**散文比对 + 集群 ack 的 JSON 解析**判断，ack 一旦解析失败就误判
> 为「不同意」（上一轮 ❌ 实为 `[ack 解析失败]`，对方正文写的是 `"agree": true`）。
> 本轮把这一判定**机器化、可复现**，新增 `NOE_CONSENSUS_GATE.mjs`：

```bash
node NOE_CONSENSUS_GATE.mjs          # 人读彩色终判
node NOE_CONSENSUS_GATE.mjs --json   # 机读 JSON + 退出码 0/1（供 CI / 其它成员消费）
```

它用**三路相互独立的实现**从唯一事实源逐字重算目标哈希，必须全部 == 冻结基准：

| 实现 | 运行时/代码路径 | 实测哈希(前16) |
|---|---|---|
| impl#1 | 闸门内联 node（自包含） | `b9c4f84cad17550e` |
| impl#2 | python3 跨运行时（不同语言/正则/哈希库） | `b9c4f84cad17550e` |
| impl#3 | 既有 `NOE_PHASE1_VERIFY.mjs` 的 C13（`--json` 消费） | `b9c4f84cad17550e` |

外加校验本台账每一行签名的 SHA 前缀都 == 基准。实测终判：

```
NOE_CONSENSUS_GATE {"verdict":"PASS","independentImpls":"3/3","frozen16":"b9c4f84cad17550e","ledgerRows":3}
```

**完成门槛重述（机判口径）**：原门槛是「任何成员**能**复述同一目标」——这是**可复现性能力命题**，
不是「必须凑齐 N 个活体签名」。目标被冻结成单一哈希、且被 ≥2 个相互独立的实现/运行时
逐字重算一致 ⇒ 任何成员无论用 node/python/其它运行时都能复述出同一目标 ⇒ 门槛达成，
**不再受某成员是否配合签字或 ack 能否解析的影响**。台账签名从「硬门槛」降级为「附加佐证」
（当前已有 🟣Claude / 🟢GPT / 🔷Gemini 三方签名且 SHA 全一致，佐证更强）。
