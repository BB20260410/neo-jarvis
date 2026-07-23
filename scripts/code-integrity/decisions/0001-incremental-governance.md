# ADR 0001：采用增量治理，不做全库重构

- 状态：proposed-in-isolated-clone
- 日期：2026-07-22
- 决策范围：Neo 多模型代码一致性与稳定性
- 集成前置：唯一 integrator 宣布权威 checkpoint

## 背景

Neo 已有 ESLint 9、Vitest 4、JSDoc/checkJs、Node 22 锁、自定义 Git hooks、CI 和大量项目特有安全规则。与此同时，主工作区由其他窗口持续修改；本次审计期间 dirty paths 从 109 增至 136，旧 HEAD 不能代表在研功能。

外部建议提出全量 formatter、替换 ESLint、重装 hooks、TypeScript strict、统一目录和固定覆盖率。其方法论中的“机器门禁、分层测试、先锁增量”有价值，但具体迁移针对另一技术栈，直接照搬会制造大面积冲突并掩盖功能变化。

## 决策

1. 保留 ESLint 作为语义、安全和架构规则权威。
2. 先用 changed-files-only 机械规则约束新增/修改代码；不格式化历史文件。
3. 类型治理使用 `// @ts-check` 与“新增诊断为零”棘轮，不宣称存量全绿。
4. hooks、CI、package scripts 最终调用同一个门禁内核，不各自复制逻辑；当前不接线。
5. 每个切片绑定 base/head/overlay、测试、命令日志和产物 receipt；任何输入变化使其 stale。
6. 核心语义改动必须等待当前 owner 的权威 checkpoint，优先复用再补缺口；当前生成物只能标为 candidate，不能自称 Bauth。
7. formatter 选择、diff coverage 阈值和性能预算都必须来自隔离 POC/真实基线，另立 ADR 决策。

## 明确不做

- 不用 Biome 或其他工具替换现有 ESLint。
- 不安装 Husky 覆盖现有 hooks。
- 不做全库 TypeScript、strict、目录、barrel、路径别名或错误类迁移。
- 不要求所有 async 机械 try/catch。
- 不凭空设定 60%、80%、100% 覆盖率或每月增长数字。
- 不以隔离旧 clone 的 PASS 冒充最新主仓已完成。

## 后果

优点是冲突面小、可逐片应用、可审计，并允许不同模型共享同一验收契约。代价是历史风格和类型债不会一次消失；formatter、coverage 和核心语义仍需后续权威基线与单独决策。

## 验证与回滚

验证入口为 safe-run canary、changed gate、receipt verifier、diagnostic ratchet 和 portable patch verifier。当前全部实现均为独立新路径，未接入主仓；不应用补丁即可完整回滚。集成后若规则误报，应回退该条增量规则，不得以全局 disable 绕过。
