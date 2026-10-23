# T7-A 必要恢复条件：有限补齐与验收

2026-10-23；开发基线 `fea6957b8a6897e69de1c22c433ed049b311c10e`，分支 `feat/wecom-host-recovery-t7a`。本轮目标是在原恢复门禁保持拒绝的前提下，把 D1–D5 已有状态纳入必要条件，修补有明确生产者依据的最小缺口。仅本地隔离、合成数据；原 N/O 源码只读，无真实配置、数据库、消息、模型或新依赖。T7-A1–A4 与完整产品验收均未完成。

任务依据：[路线图](roadmap.md)、[原恢复证据与 D1–D5 增量](t7-recovery-evidence-acceptance.md)、既有 D1–D5 验收。本轮按 Pi coding 的 Core/Runtime 边界和 MiniClaw 的源码证据/状态边界核实，不增加 Agent 循环、SDK 适配或简历内容。

## 已确认的最小缺口与实现

在显式 D2 候选中，实际原 DB 初始化生成 schema 70 的 `wecom_conversation_receipts`；D3/D5 候选生成 schema 72，另含 `wecom_conversation_execution`、`wecom_conversation_results`。原 O scanner 只认识旧 schema。遇到这些表会以 `UNKNOWN_OBJECT` 提前结束该次 DB 表行投影阶段；同连接 sqlite 观察和可执行平台上的残留扫描仍各自进行。这是元数据完整性缺口，不能据此推导任何表已可恢复。

[conversation-recovery-overlay.mjs](../integrations/native/conversation-recovery-overlay.mjs) 只在 builder 的 `conversationIntake:true` 分支中使用；执行关联/结果仅在已有 `conversationExecution:true` 时登记。它从已经组合的公开 DB 生产者提取唯一的 CREATE 声明，计算 SQLite 原有 SQL hash，附加固定列形状和以下投影。没有再写一套 CREATE SQL，不执行原 config/index，不改 schema 版本、迁移、读写业务、预算或恢复 gate。

| 对象 | 主键及投影 | 实际写者/消费者与处置边界 |
| --- | --- | --- |
| `input/wecom_conversation_receipts` | `receipt_id`；message、accepted time、fingerprint/text hash、role、workspace/profile/selection | D2 `submitBotConversationMessage` 同库消息事务；`readBotConversationReceipt` 复核消息一致性；D3 队列关联。每条仍 blocked。来源事件和 `actor_json` 未解释，不能因已受理而重跑或拒绝 |
| `execution/wecom_conversation_execution` | `receipt_id`；workspace/message、state、query/turn、batch size | D3 start/finish/cancel、session 关联及 `bindConversationAuthority`；running/cancelling 重开后保留 unknown。七个当前状态均只观察，cancelled/completed 也不自动归为 terminal |
| `outbox/wecom_conversation_results` | 复合键 `receipt_id,revision`；query/turn、digest | D5 原 canonical persistence witness → `finishConversationBatch` 事务 → 冻结结果读取。此族只表示结果关联，不证明通知已发送。content、source IDs、SDK session 仍未解释，不能代替 Provider 回执 |

原 schema SQL/列核对、稳定主键、256 行分页、总行/字节/协作时间预算、未知表/view/trigger、未知状态、读失败与扫描变化检查全部保留。新增记录同样只含 hash key/version、`metadata_snapshot_only` 和 blocked；四类全局 blocker 与 `complete:false,safe:false` 原样保留。版本只绑定所投影的元数据，未投影正文/JSON 仍是待解释义务；不能把它称为完整业务快照分类器。

默认完整 O 候选没有启用新表，也不应用该 transform；本轮最终默认组合模块 hash 与改动前一致。`inspect` 继续只读诊断、`restorePermission:not_issued`。没有实现 stopped/terminal 分类、旧写者失权、生产证书或手工 safe/ready。

## 有限的下一步前置契约

下面是恢复完整宿主所需的明确依赖。每项缺失都继续阻断；此表没有授予处置权限。原读写入口按当前已核实源码定位列出，未有事实生产者的项目明确保持未知，不再另造通用恢复框架。

`N`：只读原 `claw-agent-phase-one/.local/full-instance/stage/app/src`；`O`：只读 `claw-agent-phase-one/.local/core-fix/appointment-identity-candidate/src`；`Q`：本仓。N/O 固定全树身份由原 builder 检查，详见 [完整宿主工具](../integrations/native/README-full-host.md)。

| 条件 | 原入口与必须取得的事实 | 处置与行为反例 | 外部证据/当前状态 |
| --- | --- | --- | --- |
| 1. 已知新增记录可枚举 | Q `conversation-overlay.mjs`、`conversation-execution-overlay.mjs` 的实际 DDL → O `appointment-boot-inventory.ts` 同连接扫描 | 所有三表逐行、稳定键、完整分页；新增未知对象或列变化必须继续阻断。不得把空表当恢复证明 | 本轮已补 metadata，逐记录仍 blocked；不完成 A1 全范围 |
| 2. D1 准备占用及当前选择有一致来源 | Q `role-workspace-overlay.mjs:claimOwnedRoleWorkspace/resolveOwnedRoleWorkspace` 的 router_state 两个命名空间；Q `workbench-opening.ts` journal；`wecom-bot-task-store.ts` 的 events/current 与授权/门店/岗位 | pending/attempting 不因超时回收；ready 必须核对 owner、Profile、非 Home workspace 与绑定版本。反例：资源已发布而反馈/选择未知时再创建重复空间 | 跨 Native DB、journal、BotTaskStore 的同代快照/旧写者结清生产者尚无；实际部署路径/身份需受控核实 |
| 3. 输入和执行已经按原义结清 | O `db-appointment-boot.ts.fragment:commitAppointmentSelectedRejection` 的同步 `verifyUnexecuted`；Q D3 原队列、start/finish/cancel 与 messages/run/query/session 关系 | 原 CAS/事务可复用，但装配未提供完整 `verifyUnexecuted` 生产者。无活跃行、lease 过期或取消信号不等于旧 runner 已停。不能把 queued/promoting 改 rejected、把 running/unknown 重跑 | 原 queue/IPC/ACK/Provider 的全部关联与旧 runner 强制 fencing 尚缺；真实旧执行者证据必须受控采集 |
| 4. 原定义、run、通知分别结清 | N `db.ts:softDeleteTaskWithRevision`、`claimNextTaskRun`、`markTaskRunExecutionStarted`、`cancelTaskRun`、通知领取；N `task-scheduler.ts` 原消费者 | paused/deleted 定义且 next_run=NULL 只停止定义；active run/旧 runner 或专用 cancelled 通知仍能工作。反例：取消 run 后 workspace 通知仍可被领取。不实现只有状态标签的 stopped 分类 | 原 CAS/取消 token 已有，旧 scheduler/runner 围栏及通知结果生产者未闭合；不是本轮新增功能 |
| 5. D5 输出与投递各自可核实 | Q `conversation-execution-db.fragment:noteConversationProjection/finishConversationBatch/readConversationResults`；Q `manager-store.ts` 的 `bot_reply_intents` 与 attempt CAS；`wecom-bot-assembly.ts` 发送路径 | receipt/revision/query/turn/digest/source 必须和原持久输出对应；通知失败不能重跑 Agent。attempting/unknown 不自动重试；rejected 重试须原受理人和固定结果版本 | 真实 Provider 回执、旧发送者/迟到回调失权待受控核实。Native metadata 不覆盖独立 manager DB 的 body/通知状态 |
| 6. 原全范围证明和逐记录规则成立 | O inventory/gate/HTTP/DB COMMIT；原 messages/inbox、execution/session/router、outbox/cards/memory、任务、资源/授权、billing、IPC/config 消费者；已有 [逐族清单](t7-recovery-evidence-acceptance.md) | 原四 blocker 独立存在。当前进程 24 项零计数不证明旧进程/容器/脚本/SQL 写者或远端 Provider 失权；快照/完成标记不证明输出归账。未知 opaque 值继续 blocked | 原消费者语义分类器与外部强制围栏仍缺；原 schema scanner 未枚举 sqlite_master indexes，本轮未新增 index 覆盖或宣称全 schema 证明 |
| 7. D2–D5 和完整 O 在同一运行宿主接线 | Q `full-host-candidate.mjs` 默认保留完整 O main/queue/Web/DB；现有 `applyConversationExecution` 明确换回 N index/queue/Web 与合成末端 runner | 仅把执行选项塞进 fullhost verifier 会换掉 O 栈，不能作为恢复。下一实现须在完整 O 中保留同一 gate/queue、原迁移/消费者与权限，按现有 D1–D5 接点移接，先验证暂停不执行 | 当前没有完整 O+D5 的运行装配；该依赖先于声称同宿主产品闭环，不重做已完成的局部技能/回复实现 |
| 8. 原恢复事务、drain 和首条业务分别通过 | O `appointment-boot-gate.ts` review → claim → prepare → final；O `appointment-boot-http.ts`、`db-appointment-boot.ts.fragment` 原 IMMEDIATE/审计/COMMIT；O assembly 的 drain | 同一完整 inventory 的全部记录 eligible/stopped/terminal 且四证明成立；COMMIT 后才启动消费者。drain 失败的 restored:true 不代表可受理。反例：新到达/写票使 review 失效、取消任务复活、未知通知重发、重复入账 | 1–7 未齐，正向恢复尚不可运行。Linux 需原路径成功恢复与第二独立进程、同宿主业务；Windows 保留 unsupported residue 拒绝，不默认移植文件扫描 |

四类全局证明仍分别缺：非 DB 残留与 ACK/输出的原协议；旧写者及 Provider 强制失权/结清；全部启用入口和异步物理回调的票据覆盖；opaque 配置/路由/session/任务/通知的消费者解释。原 assembly 的 `prepare` 只检查已准备条件和连接，不会连接渠道、清理遗留或生成这些证明。对外读取器、模型文字、管理员点击、SDK OPEN 或本地合成零计数均不能补齐。

条件 6 也包含迁移来源的 schema 精确性：既有 D2 场景刻意从手写最小 schema 69 建库，原迁移保留的 router_state/workspace_agent_profiles CREATE SQL 与 O 预期 hash 不同。新表登记后仍报告这两个 SCHEMA blocker；这属于原 scanner 的真实拒绝，不能删掉检查或自动改写旧表。本轮 canonical 原初始化测试证明三张新增表可枚举，既有 D2 迁移测试另证 schema 不同仍拒绝，二者不拼接为完整恢复。

下一项可开始的实现应是条件 7 的完整 O 接点核实与最小迁接，或先为条件 3/4 确认真实原 fencing/结清生产者；在契约明确前继续保留拒绝。没有充分依据实施“原 paused 定义自动 stopped”或“原 queued 输入自动 rejected”。

## 实际验证与证据

新增 [隔离验证入口](../integrations/native/verify-recovery-conversation-inventory.mjs) 对 schema 69/70/72 分别构建原候选，在独立临时 cwd、合成配置和 SQLite 中只执行 DB 初始化与 scanner。三种候选逐个做原 TypeScript 检查；不导入 main/队列/调度器，不将 N 片段声称为完整宿主。源码、实际测试及每个组合模块 hash 记录于每次唯一 runId；源在运行中改变则拒绝。Linux 的 stdout 保留相同 runId 和 hash 摘要，容器 tmpfs 内部报告不冒充可长期访问文件。

RED：原实现的 schema 69 路径通过；schema 70 在 `UNKNOWN_OBJECT` 提前结束，已知表枚举、主键/列形状及预算断言出现目标失败。日志 `.local/t7a-20261023-inventory-red.log`，runId `5c003bb1-cd7f-4b6f-a23a-a59de79bcf0b`。首次 fixture 的 WAL 序列化读错在取得此 RED 前已修正，不计产品缺陷；执行版本初次绿色尝试的 revision=1.5 实际按原扫描器判 INVALID_KEY，测试随原主键语义修正，未改变实现。

最终验证于 2026-10-23 在本仓执行，所有命令 exit 0。Windows 使用 `E:/node.exe` 和已校验的 prepared better-sqlite3 12.11.1；Linux 复用固定镜像/原 ELF 的既有 `linux-runtime.mjs`，`--pull=never --network=none`、只读输入/rootfs、临时写入根。没有下载依赖。日志在 `.local/t7a-20261023/`。

| 验证 | 实际入口与结果 | runId/证据 |
| --- | --- | --- |
| Windows 三种 schema | `verify-recovery-conversation-inventory.mjs N O PREPARED_DRIVER`；schema 69：5 pass/7 不适用 skip，70：11 pass/1 不适用 skip，72：12 pass；每种完整候选 typecheck 0 | `4fa4a03c-f376-4262-8fc4-f30b9f04165a`；`windows-inventory.log` |
| Linux 三种 schema | `.local/t7a-20261023/run-linux-additional.mjs inventory` → 同一 verifier；上述 5/11/12 pass 与三次 typecheck 0，输入 hash 与 Windows 相同 | `6dff0cde-8336-4d77-ab83-87ab1f3e43bd`；`linux-inventory.log` |
| Windows 原完整 O | `verify-full-host.mjs N --host-overlay O --sqlite-driver PREPARED_DRIVER --typecheck`；原角色空间 2 pass，boot/restart 各 8 pass/8 Linux 专属 skip | `2026-10-23T07-59-08-317Z-aca4d5d0-742a-466d-bbad-10bc5d49810c`；PID 33312/34444；`windows-fullhost.log` |
| Linux 原完整 O | `.local/d5-20261022/run-linux.mjs host` → 原 fullhost verifier；角色空间 2 pass，boot/restart 各 15 pass/1 Windows 专属 skip | `2026-10-23T08-05-22-234Z-f0266b5a-e112-44ff-9d04-2313278712d3`；`linux-fullhost.log` |
| 既有 D2 | Windows `verify-conversation.mjs N O PREPARED_DRIVER`；Linux additional helper 的 `d2`；两系统各两个不同 OS 进程、每轮 2 pass，typecheck 0。保留手写迁移 schema 的原 SCHEMA 拒绝 | Windows `b7b25f00-a77b-461f-b206-0b501a8df7d0`；Linux `cb0bdff9-e905-432a-9b9b-3d710d4a8ff0`；对应 `*-d2.log` |
| 既有 D5 原片段 | Windows `verify-conversation-execution.mjs N O PREPARED_DRIVER`；Linux 既有 helper 的 `execution`；两系统各两个不同 OS 进程、每轮 2 pass，typecheck 0 | Windows `b38acd18-cc76-48c2-81c2-977824241af9`；Linux `ffe24327-2b71-4c8b-bb22-451520f0c04c`；对应 `*-d5.log` |
| Native 端口回归 | `node node_modules/vitest/vitest.mjs run --config integrations/native/conversation.vitest.config.mts`：3 pass；同入口 execution config：1 pass | `windows-d2-port.log`、`windows-d3-port.log` |
| 当前 hash 与证据对照 | `node .local/t7a-20261023/check-evidence.mjs` 核对当前源、实际测试、三种组合、双进程与 RED 默认基线；通过 | `evidence-summary.json`；保留 Linux stdout，不依赖已销毁 tmpfs 内文件 |

默认 O 组合 hash 摘要 `783f3f0d9698e8c1987cfedccad119fa47cb461df08027b9bacd1dcc9507c8d7` 在 RED、最终 Windows 与 Linux 完全相同。新增 transform hash `f664442f17b8d8f6be66b45705e270bb0e4912efca204ad1636aa358dfab88ae`；新 scanner 测试 hash `98e7ff8c8b5b8fe226f89a6aa968f2a2a127fe50153d402673688c72ffc95ef0`。所有三种 schema 的实际组合和源 hash 在上述 summary/日志可查。

主执行者的公共回归：43 文件 588/588 pass，`npm run typecheck`、`npm run build` exit 0；公开源码 `src/` 与 `tests/` 本轮未改。暂存/未暂存 `git diff --check` 通过。独立审查与 GitHub 交付由主执行者进行。本轮没有 lint 脚本、生产部署、真实企微/模型、成功 appointment 恢复或真实员工验收结果。fullhost 静态站点目录提示仍属于既有 harness 限制；这里只验证 API/启动/暂停保持，不声称浏览器 UI 已验收。
