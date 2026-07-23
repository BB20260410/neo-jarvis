# Noe Phase1 GPT 修订共识降级指针

生成时间：2026-06-01

工作区：`/Users/hxx/Desktop/Neo 贾维斯`

当前阶段：工程闭环第 1 阶段「用户想法」

## 1. 文件状态

本文件是 GPT 上一轮修订共识的留痕。按第 3 轮反馈，为避免继续产生目标口径分叉，本文件不再作为 Phase1 主口径或补充口径维护。

阶段 1 唯一事实源为：

`NOE_PHASE1_目标契约_CANONICAL.md`

如本文件与 CANONICAL 有任何不一致，一律以 CANONICAL 为准；后续目标边界只改 CANONICAL。

## 2. 本轮修订结论

- 采纳对方反馈：不再保留本文件作为可扩写的目标契约。
- `NOE_PHASE1_GPT_独立目标契约_2026-06-01_REV2.md` 已同步降级为指针。
- `NOE_BAILONGMA_ARCH_AUDIT.md` 保持阶段 2 待复核草稿定位，不能在 Phase1 当作最终审计事实。
- 后续统一使用 canonical path：`/Users/hxx/Desktop/Neo 贾维斯/BaiLongma-audit`。
- 本轮未写业务代码，未修改原项目目录。

## 3. 后续执行口径

后续工程闭环按 CANONICAL 执行：

1. 用户想法：以 `NOE_PHASE1_目标契约_CANONICAL.md` 锁定目标、边界、不可做事项、成功标准和风险假设。
2. 需求分析与拆解：先复核 `NOE_BAILONGMA_ARCH_AUDIT.md`，再拆 NoeLoop、Memory Core、Brain UI Lite 等需求。
3. 技术方案设计：以 Noe 为主，设计自有 loop、memory、UI、权限、数据桥接与审计日志。
4. 任务分配与排期：审计复核 -> 51835/51735 隔离验证 -> NoeLoop -> Memory Core -> Brain UI Lite -> Voice/Social/工具市场安全评审。
5. 代码开发：审计与方案确认后才做最小闭环，不整仓复制 BaiLongma。
6. 单元测试：覆盖 NoeLoop、Memory、权限边界、状态流转和存储读写。
7. 集成测试：验证 Noe 51835 与原项目 51735 共存，不混用状态、日志、数据目录。
8. 功能验证：验证感知、记忆、循环、展示、暂停、恢复和错误可见性。
9. 文档编写：沉淀审计报告、融合方案、阶段交接和验证证据。
10. 交付验收：按端口隔离、最小闭环可运行、无原项目污染、无未经审计能力接入验收。
11. 复盘优化：回看 BaiLongma 能力的吸收、延后、拒绝分类，并修订下一阶段边界。
