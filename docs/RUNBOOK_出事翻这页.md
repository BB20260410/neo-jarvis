# RUNBOOK · 出事翻这页（2026-06-10）

> 一页纸应急手册。每条都演练/实测过，照抄命令即可。平时不用读。

## 🔥 记忆库坏了 / Noe 失忆
```bash
# 1. 停 panel（手动启动的 Ctrl+C；launchd 守护的先 unload）
./scripts/noe-launchd.sh uninstall   # 没装守护就跳过
# 2. 看有哪些备份（每日自动快照，保留 7 份）
ls -lh ~/.noe-panel/backups/
# 3. 恢复库 + 对话历史（挑最近的日期）
cp ~/.noe-panel/backups/panel-YYYY-MM-DD.db ~/.noe-panel/panel.db
rm -f ~/.noe-panel/panel.db-wal ~/.noe-panel/panel.db-shm
cp ~/.noe-panel/backups/files-YYYY-MM-DD/*.json ~/.noe-panel/
# 4. 启动并验证
npm start    # 然后问 Noe 一个它该记得的事
```
不确定流程是否还好使？随时重演练：`node scripts/noe-backup-restore-drill.mjs`（隔离环境，不碰真数据）

## ⚡ panel 起不来 / 端口被占
```bash
lsof -nP -iTCP:51835 -sTCP:LISTEN     # 看谁占着（确认归属再杀！）
kill <PID>                             # 优雅停（会走落盘+关库）
tail -50 ~/.noe-panel/logs/panel-$(date +%F).log   # 看启动报错
```

## 💥 panel 反复崩
```bash
tail -100 /tmp/noe-panel.launchd.err.log          # 守护模式的崩溃现场
grep uncaughtException ~/.noe-panel/logs/panel-*.log | tail -5
./scripts/noe-launchd.sh uninstall                 # 先停守护防崩溃循环，修好再装回
```

## 🔴 CI 红了
- 看哪步红：lint → `npx eslint .`；测试 → `npm test`；本地全绿但 CI 红 → 看 workflow 日志的环境差异。
- CI 在 push/PR 到 main 或 noe-main 时触发；手动触发：GitHub Actions 页面 workflow_dispatch。

## 🧪 改完代码的例行四连（动核心后必跑）
```bash
npm test                  # 全量单测
npx eslint .              # 0 error 才算过
npm run verify:handoff
git diff --check
```

## 🧬 自进化（self-evolution）运维（P0-5）

### 开关与点火（改 plist 后必 bootout/bootstrap）
> ⚠️ bootout 前先 drain in-flight cycle：若有自改 cycle 正走到 apply 落盘，等它落盘完成或回滚（看 `output/noe-self-evolution/runtime-verify/` 最新报告 ok/failed）再 bootout，避免 reload 撞上半落盘。临界期短（apply 是同步的），实在赶时间可 bootout 后查最近 apply 报告确认完整。

kickstart **不重读** plist 新增项——改了 plist 的 EnvironmentVariables 必须 bootout+bootstrap 才生效：
```bash
launchctl bootout gui/$(id -u)/com.noe.panel 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.noe.panel.plist
launchctl print gui/$(id -u)/com.noe.panel | grep -iE 'state|NOE_SELF'   # 验开关已载入
```
开关（plist EnvironmentVariables，全默认 OFF）：
| env | 作用 |
|---|---|
| `NOE_SELF_EVOLUTION=1` | 装配自进化环（observe+tick），OFF 整条不通电 |
| `NOE_SELF_EVOLUTION_EXECUTORS=1` | 注册四个真改 executor（否则到不了 executor） |
| `NOE_SELF_EVOLUTION_REAL_APPLY=1` | 真改代码闸（OFF=dry-run，ON 才落盘，仍过三道门） |
| `NOE_SELF_EVOLUTION_AUTOSEED=1` | 反刍自语→自动立 self_evolution 目标（高风险，单独控） |
| `NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE=1` | consensus 死锁最小推进 |
| `NOE_SELF_EVOLUTION_MAX_STUCK_TICKS` | 连续 N 拍推不动自动 drop 解锁（默认 60，0=关） |

### 安全门时序（铁律：先停火再装弹）
1. 安全门代码先上线 + 实测 blocker 生效（`npx vitest run tests/unit/noe-self-evolution-e2e-apply.test.js`）；
2. **确认 dry-run 改禁区被 `patch_path_policy_protected` 拦后**，才依赖 `REAL_APPLY=1`。

三道硬门（任一不过即拒，绝不绕）：①pipeline gate（consensus/authorization）②standing grant（scope=`self-evolution:run`）③PolicyFileGuard（禁改 tests/退路 + scripts/ + 自改链自身源码 + policy 文件）+ apply 后 changedFiles 二次核（防 reward hack 改测试骗 verify）。verify 失败必自动 rollback + throw（非 throw 会被标 completed = 假成功）。

### 自进化卡住 / churn
```bash
# 看 open/active 的 self_evolution 目标（卡住的会永久占位 openSelfEvolutionGoals()[0]）
sqlite3 ~/.noe-panel/panel.db "SELECT id,status,substr(title,1,40) FROM noe_goals WHERE source='self_evolution' AND status IN ('open','active');"
# 手动 drop 卡死目标（server 停时改，防 memory cache 覆盖）
sqlite3 ~/.noe-panel/panel.db "UPDATE noe_goals SET status='dropped' WHERE id='<goalId>';"
```
- codex 出不了 patch（`error 61` 连不上 OpenAI）→ 自动降级本地 `lmstudio`（localhost 绕外网，需 LM Studio 在 1234 跑）。
- codex 跑很久不出 → implementer 已 `disableMcp`（曾因 MCP profile 注入跑 12min）。
- 心跳不收口：self_evolution goal 已豁免通用 close/nextStep，生命周期改由 cycle 走到 `complete` 时显式 `setStatus(done)`；空 plan 目标免疫 closeResolvedGoals。

## 📍 关键路径速查
| 什么 | 在哪 |
|---|---|
| 记忆库 | `~/.noe-panel/panel.db`（每日备份在 `backups/`） |
| 对话历史 | `~/.noe-panel/rooms.json` |
| 日志（按天，自动清 90 天前） | `~/.noe-panel/logs/panel-YYYY-MM-DD.log` |
| 守护管理 | `./scripts/noe-launchd.sh install|uninstall|status|restart` |
| MCP server 配置 | `~/.noe-panel/mcp-servers.json` |
| 能力开关 env | `NOE_DREAM` `NOE_MEMORY_GC` `NOE_GEO_WEATHER` `NOE_MEMORY_EMBED` `TELEGRAM_BOT_TOKEN` `NOE_NTFY_TOPIC` `NOE_DB_BACKUP=0`(关备份) |
