# OpenClaw src/cron 逐文件全读
已对 `src/cron/` 及其子目录下的 31 个实质逻辑文件进行了深度审计。以下是详细分析报告：

### 核心调度与管理 (Root)

#### 1. `src/cron/active-jobs.ts`
*   **职责**：跟踪进程内正在执行的 Cron 任务，防止重复运行。
*   **机制**：
    *   `getCronActiveJobState`: 利用全局 Singleton 跨模块重载保持状态 (Line: 10)。
    *   `markCronJobActive` / `clearCronJobActive`: 标记和清除活跃状态 (Line: 21, 30)。
*   **Noe 优化点**：
    *   **分布式锁支持**：目前是进程内 Set，Noe 可以引导引入 Redis/DB 锁以支持多实例部署。
    *   **自动清理**：若任务崩溃未触发清除，可增加基于 TTL 的自动过期机制。

#### 2. `src/cron/command-runner.ts`
*   **职责**：执行 shell 命令类型的 Cron 负载。
*   **机制**：
    *   `runCronCommandJob`: 入口函数，处理 `payload.kind === "command"` (Line: 83)。
    *   `runCommandWithTimeout`: 包装底层进程执行，支持超时、环境变量和输出限额 (Line: 109)。
*   **Noe 优化点**：
    *   **敏感信息脱敏**：检查 `env` 中是否包含敏感 Key，并在诊断日志中自动遮蔽。
    *   **流式输出解析**：目前是执行完后统一获取输出，Noe 可改为实时解析输出以触发特定报警。

#### 3. `src/cron/delivery-plan.ts`
*   **职责**：解析任务配置，确定主发送渠道和失败通知路由。
*   **机制**：
    *   `resolveCronDeliveryPlan`: 根据 `job.delivery` 计算运行时发送模式 (Line: 51)。
    *   `resolveFailureDestination`: 层叠处理任务级和全局级的失败通知配置 (Line: 122)。
*   **Noe 优化点**：
    *   **路由冲突检测**：自动检测主发送路径与失败通知路径是否重叠，避免重复骚扰。

#### 4. `src/cron/retry-hint.ts`
*   **职责**：根据错误信息分类，决定是否重试。
*   **机制**：
    *   `resolveCronExecutionRetryHint`: 使用正则匹配网络、限流、服务器错误等 (Line: 32)。
    *   `SERVER_ERROR_PATTERN`: 复杂的正则以排除非 HTTP 状态码的数字干扰 (Line: 16)。
*   **Noe 优化点**：
    *   **AI 错误诊断**：当正则无法匹配时，Noe 可介入分析错误堆栈，给出更精准的重试建议。

#### 5. `src/cron/run-diagnostics.ts`
*   **职责**：构建脱敏且有限额的运行诊断日志。
*   **机制**：
    *   `normalizeCronRunDiagnostics`: 对诊断条目进行脱敏和截断 (Line: 104)。
    *   `mergeCronRunDiagnostics`: 合并多源诊断，保留最高优先级摘要 (Line: 148)。
*   **Noe 优化点**：
    *   **智能截断**：目前是简单截断，Noe 可优化为保留关键上下文（如堆栈顶部和尾部错误原因）。

---

### 服务逻辑 (src/cron/service/)

#### 6. `src/cron/service/timer.ts`
*   **职责**：Cron 调度的核心心跳循环。
*   **机制**：
    *   `onTimer`: 主心跳处理，通过 `locked` 锁定任务并执行 (Line: 482)。
    *   `armTimer`: 计算下一次唤醒时间，包含 60s 的漂移修正 (Line: 433)。
    *   `applyJobResult`: 处理运行结果，驱动状态机更新及重试决策 (Line: 309)。
*   **Noe 优化点**：
    *   **自适应心跳**：根据任务密度动态调整 `MAX_TIMER_DELAY_MS`，减少空转。
    *   **并发限流**：Noe 可根据系统负载动态调优 `resolveRunConcurrency`。

#### 7. `src/cron/service/ops.ts`
*   **职责**：Cron 服务的 CRUD、状态查询及手动触发逻辑。
*   **机制**：
    *   `start`: 恢复中断的任务并执行启动 catch-up (Line: 120)。
    *   `enqueueRun`: 将手动运行排入 `CommandLane.Cron` 队列 (Line: 683)。
*   **Noe 优化点**：
    *   **优雅停机**：增强 `stop()` 逻辑，确保正在执行的 Command 任务能安全接收信号。

#### 8. `src/cron/service/jobs.ts`
*   **职责**：底层的任务计算、补丁应用及 Stagger (交错) 逻辑。
*   **机制**：
    *   `resolveStableCronOffsetMs`: 基于 Job ID 哈希的确定性交错偏移 (Line: 75)。
    *   `computeJobNextRunAtMs`: 核心下次运行时间计算逻辑 (Line: 309)。
*   **Noe 优化点**：
    *   **哈希算法替换**：将 `sha256` 替换为更快的非加密哈希（如 MurmurHash）以提升调度吞吐。

---

### 隔离运行 (src/cron/isolated-agent/)

#### 9. `src/cron/isolated-agent/run.ts`
*   **职责**：编排隔离环境下的 Agent 运行全生命周期。
*   **机制**：
    *   `runCronIsolatedAgentTurn`: 负责准备上下文、执行模型、发送结果及清理资源 (Line: 788)。
    *   `disposeCronRunContext`: 内存清理机制，防止因 Skill 提示词导致的堆积 (Line: 757)。
*   **Noe 优化点**：
    *   **预热机制**：对高频调用的 Model/Provider 进行预热，减少 Cold Start 延迟。
    *   **安全审计**：在 `prepareCronRunContext` 中加入更严格的 Hook 内容扫描。

---

### 存储与日志 (src/cron/store/ & src/cron/run-log/)

#### 10. `src/cron/run-log.ts`
*   **职责**：基于 SQLite 的运行日志持久化 API。
*   **机制**：
    *   `appendCronRunLog`: 按 Job ID 序列化写入，防止数据库竞争 (Line: 117)。
    *   `readCronRunLogEntriesPage`: 支持复杂过滤（状态、发送状态、文本查询）的分页读取 (Line: 253)。
*   **Noe 优化点**：
    *   **查询下推**：将目前的 JS 侧过滤 (Line: 306) 更多地推向 SQL 索引，提升万级日志下的 UI 响应速度。

#### 11. `src/cron/session-reaper.ts`
*   **职责**：清理过期的隔离会话及 transcript 文件。
*   **机制**：
    *   `sweepCronRunSessions`: 定时触发，根据 `updatedAt` 清理 session store (Line: 56)。
*   **Noe 优化点**：
    *   **分片清理**：对超大型 session 库，改为分批次/分片清理，避免阻塞文件锁。

---

### 已读文件清单 (31个)
- `src/cron/active-jobs.ts`
- `src/cron/command-runner.ts`
- `src/cron/delivery-context.ts`
- `src/cron/delivery-field-schemas.ts`
- `src/cron/delivery-plan.ts`
- `src/cron/delivery-preview.ts`
- `src/cron/delivery-target-validation.ts`
- `src/cron/delivery.ts`
- `src/cron/heartbeat-policy.ts`
- `src/cron/isolated-agent.ts` (Facade)
- `src/cron/normalize-job-identity.ts`
- `src/cron/normalize.ts`
- `src/cron/parse.ts`
- `src/cron/persisted-shape.ts`
- `src/cron/retry-hint.ts`
- `src/cron/run-diagnostics.ts`
- `src/cron/run-log-jsonl.ts`
- `src/cron/run-log.ts`
- `src/cron/schedule-identity.ts`
- `src/cron/schedule.ts`
- `src/cron/service-contract.ts`
- `src/cron/service.ts`
- `src/cron/session-reaper.ts`
- `src/cron/session-target.ts`
- `src/cron/stagger.ts`
- `src/cron/store.ts`
- `src/cron/service/ops.ts`
- `src/cron/service/timer.ts`
- `src/cron/service/jobs.ts`
- `src/cron/service/failure-alerts.ts`
- `src/cron/isolated-agent/run.ts`
