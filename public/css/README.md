# public/css/ — 按 view 拆分目标

> ✅ S25（2026-06-10）已落地：style.css 7522 行按节边界保序拆为 @import 壳 + 分段 `style-*.css`
> （拼接与拆分前逐字节一致，级联顺序不变）。
> ✅ S25b（2026-06-10）已落地：9 个 ≥500 行的段再按节边界细拆为 23 个子段（同法逐字节校验），
> 现全部段 <500 行，共 25 段。段顺序以 style.css 壳的 @import 清单为准。
> 模块文件（modal/utility/form/sidebar.css）仍走双轨：在壳之后加载、覆盖同组定义。
> 新增样式直接进对应段文件；某段超 500 行时按同样保序+拼接校验法继续细拆。

## 拆分计划（v0.82+）
- base.css       — token / reset / 全局
- layout.css     — .app grid / sidebar / inspector
- modal.css      — .modal-* + .confirm-modal
- room.css       — .room-* 4 房模式
- sidebar.css    — sidebar + session-list
- inspector.css  — inspector + tabs
- form.css       — input / button / cxbtn
- utility.css    — .muted / .hint-text / hidden

## 已经准备好的 token starter
- lobe-tokens-extension.css（W4 学习产出）→ 完整迁移后可移这里
