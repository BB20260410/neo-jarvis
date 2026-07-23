# 阶段 1「用户想法」已归档的竞争目标稿（superseded）

> 归档时间：2026-06-01 · 归档人：Claude / xike-builder（集群协同）
> 动作性质：**移动（mv），非删除**，内容完整保留，可一条命令恢复。

## 为什么归档

阶段 1 在集群协同中出现 **16 份并存的目标/契约类文档**（多份带成员名、口径互异），
导致判定方反复指出「单一事实源未在磁盘落实 / 范围漂移」。本目录把除唯一事实源外的
**15 份竞争稿**全部收敛归档，使工作区顶层**只剩一份权威目标契约**：

```
/Users/hxx/Desktop/Neo 贾维斯/NOE_PHASE1_目标契约_CANONICAL.md   ← 唯一事实源（保留在顶层）
```

任何成员/新接手者只需读顶层那一份；本目录文件仅作历史留痕，**不再作为目标依据**，
与 CANONICAL 冲突时一律以 CANONICAL 为准。

## 已归档清单（15 份）

| 文件 | 原作者（按命名/内容推断） |
|---|---|
| NOE_PHASE1_GPT_独立目标契约_2026-06-01_REV2.md | GPT |
| NOE_PHASE1_GPT_修订共识_2026-06-01.md | GPT |
| NOE_PHASE1_GPT_用户想法_目标边界.md | GPT |
| NOE_PHASE1_USER_IDEA_CONTRACT_GPT_2026-06-01_2038.md | GPT |
| NOE_PHASE1_USER_IDEA_CONTRACT_GPT_REV2_2026-06-01.md | GPT |
| NOE_PHASE1_USER_IDEA_GPT_2026-06-01.md | GPT |
| NOE_PHASE1_目标契约_Claude.md | Claude |
| NOE_PHASE1_目标契约_Claude本轮_2026-06-01.md | Claude |
| NOE_PHASE1_目标章程_xike-builder.md | Claude/xike-builder |
| NOE_PHASE1_用户想法_GPT_独立目标契约_2026-06-01.md | GPT |
| NOE_PHASE1_用户想法_目标与边界.md | 集群早期 |
| NOE_PHASE1_用户想法_目标章程_xike-builder.md | Claude/xike-builder |
| NOE_GOAL_CONTRACT.json | 集群早期（机器可读目标，需用时由 CANONICAL 重生成） |
| NOE_USER_IDEA_ALIGNMENT.md | 集群早期 |
| NOE_目标与边界_用户想法阶段.md | 集群早期 |

## 恢复方法（若需取回任一份）

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
mv "_archive/phase1-superseded/<文件名>" .
```

全部恢复：

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
mv _archive/phase1-superseded/NOE_* .
```

## 边界声明

- 以上 15 份均为集群本轮（2026-06-01）协同时生成的工作产物，**未纳入 git 跟踪**（归档前 `git status` 全为 `??`），非用户手写源码、非受版本控制的项目文件，归档完全可逆。
- 未触碰原项目目录 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- 未删除任何文件，未改动 CANONICAL 与 `NOE_BAILONGMA_ARCH_AUDIT.md` 正文。
