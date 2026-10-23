# T7-A 必要恢复条件：有限补齐与验收

本文前面的 `fea6957` / `915b430` 元数据与同宿主验收保留为历史，使用其各自基线与运行日期；本次 `cf52468e3f7eb33a2ee9c10319b7de4dd38a8fdd` 基线的增量及当前缺口见文末“原选定卡片处置补证”。旧通过结果不自动覆盖本次组合。

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
| 7. D2–D5 和完整 O 在同一运行宿主接线 | Q `full-host-candidate.mjs` 默认保留完整 O main/queue/Web/DB；旧 `conversationExecution` 仍为 N 片段，新 `fullHostConversationExecution` 显式迁接到 O | 新选项保留原 main、同一 gate/queue 与原 runner，先验证暂停不执行、不改写旧运行状态；旧选项不能作为完整宿主恢复证据 | 后续同宿主装配及验证见 [同宿主接线验收](t7a-fullhost-conversation-acceptance.md)；恢复后成功执行、完成通知与员工查回仍待验收 |
| 8. 原恢复事务、drain 和首条业务分别通过 | O `appointment-boot-gate.ts` review → claim → prepare → final；O `appointment-boot-http.ts`、`db-appointment-boot.ts.fragment` 原 IMMEDIATE/审计/COMMIT；O assembly 的 drain | 同一完整 inventory 的全部记录 eligible/stopped/terminal 且四证明成立；COMMIT 后才启动消费者。drain 失败的 restored:true 不代表可受理。反例：新到达/写票使 review 失效、取消任务复活、未知通知重发、重复入账 | 1–7 未齐，正向恢复尚不可运行。Linux 需原路径成功恢复与第二独立进程、同宿主业务；Windows 保留 unsupported residue 拒绝，不默认移植文件扫描 |

四类全局证明仍分别缺：非 DB 残留与 ACK/输出的原协议；旧写者及 Provider 强制失权/结清；全部启用入口和异步物理回调的票据覆盖；opaque 配置/路由/session/任务/通知的消费者解释。原 assembly 的 `prepare` 只检查已准备条件和连接，不会连接渠道、清理遗留或生成这些证明。对外读取器、模型文字、管理员点击、SDK OPEN 或本地合成零计数均不能补齐。

条件 6 也包含迁移来源的 schema 精确性：既有 D2 场景刻意从手写最小 schema 69 建库，原迁移保留的 router_state/workspace_agent_profiles CREATE SQL 与 O 预期 hash 不同。新表登记后仍报告这两个 SCHEMA blocker；这属于原 scanner 的真实拒绝，不能删掉检查或自动改写旧表。本轮 canonical 原初始化测试证明三张新增表可枚举，既有 D2 迁移测试另证 schema 不同仍拒绝，二者不拼接为完整恢复。

条件 7 的后续实现及证据单列于[同宿主接线验收](t7a-fullhost-conversation-acceptance.md)。原恢复许可仍依赖条件 3/4 等真实 fencing/结清生产者；在契约明确前继续保留拒绝。没有充分依据实施“原 paused 定义自动 stopped”或“原 queued 输入自动 rejected”。

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

## 原选定卡片处置补证（2026-10-23）

本次基线 `cf52468e3f7eb33a2ee9c10319b7de4dd38a8fdd`，分支 `feat/wecom-recovery-settlement`。复用完整 O+D1–D5 候选、原 main/queue/Web/SQLite/gate，仅补已存在的内部选定卡片操作的组合和真实持久化证据，不新增 HTTP API、schema、依赖或恢复许可。原 N/O 树只读；所有操作在新临时目录的合成数据上，无真实消息、Provider 请求或模型调用。

### 原契约与实际缺口

`commitAppointmentSelectedRejection` 对原 messages 精确行进行 IMMEDIATE、当前会话/管理员/群组 ACL、完整版本与状态 CAS；`verifyInputUnexecuted` 缺失返回 409，异步、抛错和非布尔证据返回 503。queued/promoting 标签、空 outbox 和当前进程无活动均不足以生成该证据。当前实际 main 的 `appointmentBootRecovery` 只提供 inventory/prepare/drain，未供应该 verifier，因此本次没有打开选定输入拒绝。

O 的 `appointment-boot-overlay.mjs` 独立导出 `applySelectedCardRecovery`，但 `applyBootInventoryCandidate → applyBootConsumerCandidate → applyBootTaskCandidate` 原组合链没有调用它。此前只在独立转换与 mock store 测试中存在 `reconcileSelectedStreamingCard`，不能称为完整候选已接入。本次真实候选执行首先发现该导出不存在，随后仅在 `fullHostConversationExecution:true` 分支，经已有全树 hash 校验和 snapshot 机制复用此原转换。默认完整 O、D2 和旧 isolated D3/D5 的组合不改变；没有向 Web 注册选定卡片操作。

原选定操作要求 card id/revision/provider/account/sourceJid/turnRunId 精确匹配，活动 running/finalizing turn 的有效 lease 阻止处置。没有持久 Provider identity 时，原规则是 claim card revision → failed/manual_reconciliation → interrupt 对应 turn。该状态表示需要人工核实；不能证明远端未创建卡片、已关闭卡片或不存在迟到外发。

真实 SQLite 故障验证发现：第二个 interrupt 写入失败后 card 已 failed、turn 仍 running；重新读取当前 card revision 并重试，原函数返回 skipped，不能补完第二步。这是本次处置直接相关的实际缺陷。`selected-card-settlement-overlay.mjs` 仅补此已部分提交的本地动作：业务专用 helper 在原 store 同一 SQLite 默认事务内重读完整 selection、原 failed/missing identity/原 error/精确 recovery marker、同 provider/account/source/chat/root/thread 的 turn 和当前 lease；符合原可中断状态才调用原 `interruptChannelTurnRunById`。第二步继续失败则原事务抛错回滚，card 保持原 failed 状态以供再次核实重试；实际 interrupt 和无变化分别返回，已终态重复调用仍 skipped。不增加通用事务接口，不修改原 SqliteDatabase 类型；跨进程 SQLite 写冲突依照原事务失败关闭，不声称已证明旧写者失权。

### 本次行为与证据

`full-host-settlement.fixture.mts` 只在完整 O+D1–D5 验证模式的第一进程启动前准备三组精确合成 card/turn，随后复用实际 main 的 SQLite 和实际 WebDeps/gate。测试核对当前原管理员 principal；直接调用原内部 selected API 验证本地处置语义。管理员核验和持有相同 gate 对象不等于生产侧已存在可信管理调用方：本次没有新增该调用方的 ACL/Origin/门禁票据装配，因此不能称为 Web 管理已开放该操作或完整 A2 已完成。

覆盖错误 revision/account/source/turn/provider 拒绝、原 live lease 拒绝、本地 failed + 精确 interrupted 的真实持久状态、旧 card revision/旧 turn lease 写入失效、不重新领取 interrupted turn，以及第二写故障与重试。故障只由匹配目标 turn 的 SQLite trigger 注入，不破坏共享目录或其他消费者。失败持续时重试仍抛错且完整快照不变；错误 marker/error、不同 turn route、后来出现有效 lease 均不补写。第二进程只读取第一进程已提交快照，不重新 seed 或重做处置；原 D1–D5 维护拒绝和历史状态保留继续执行。扫描必须实际枚举六条 card/turn 记录且全部仍 blocked，不能用空集合的 every 断言冒充验证。

| 运行 | 实际结果与版本范围 |
| --- | --- |
| 装配失败 | `.local/t7a-settlement-20261023/red.log`；runId `2026-10-23T09-27-10-328Z-aeb9c182-97cd-414c-b24d-ccefd8494db4`，actual main 下 selected 导出缺失；不计第二写缺陷 RED |
| 第二写 RED | `red-second-write.log`；runId `2026-10-23T09-29-04-230Z-6ac6900e-26c7-4205-bb68-3aad551ef62c`，明确输出 card=failed/turn=running，重选后 skipped，目标行为断言失败 |
| Windows 最终候选 | `windows-fullhost-final.log`；runId `2026-10-23T09-33-21-721Z-233c53be-c278-4987-9d61-6af31e209997`。实际候选 typecheck exit 0，环境顺序 1 pass、原角色 3 pass、boot/restart 各 11 pass/8 个 Linux 专属 skip；worker PID 40836 / 17832 |
| Linux 最终候选 | `linux-fullhost-final.log`；runId `2026-10-23T09-38-08-258Z-9c079400-0df5-4c30-acd9-85b01d153c15`。同 verifier 与已封存 61863 文件的输入，固定镜像 `--pull=never --network=none`、只读 rootfs/input 与 tmpfs；复用既有外层 600s 预算。实际候选 typecheck exit 0、环境顺序 1 pass、原角色 3 pass、boot/restart 各 18 pass/1 个 Windows 专属 skip；worker PID 110 / 185 |

Windows/Linux 最终候选组合摘要均为 `cc5b49abe358a0b74ef08104af876a7094afb79c206d21ef70a0f1feb0094e18`。日志/audit 绑定本次组合各模块、实际 index、测试、fixture、verifier 与 builder，汇总在 `.local/t7a-settlement-20261023/implementation-report.json`；Linux tmpfs 内的审计文件随容器销毁，以保留在宿主的 stdout/log 为证，不宣称临时路径可长期访问。第一轮 GREEN 的 `windows-fullhost.log` 只证明补充 chat/root/thread 反例之前的版本，不计最终交付证据。初次 CLI 误用相对路径被参数检查拒绝，未执行测试，不计有效 RED。

本次故障是第一进程中的定点 SQLite abort；第二进程证明随后已结清状态的持久保留，未模拟恰好在原两次写入之间的进程崩溃。基线兼容逐字节比较见 `compatibility-stage.json`：默认 O、D2、旧 isolated D3/D5 各 208 个生成模块与 `cf52468` 完全相同，不重复将旧运行写成本次新通过。

主执行者本次在仓库运行 `E:/npm.cmd test -- --maxWorkers=1`（43 文件、588 pass）、`E:/npm.cmd run typecheck`、`E:/npm.cmd run build`，均 exit 0；日志为 `public.log`、`typecheck.log`、`build.log`。另运行 `E:/node.exe node_modules/vitest/vitest.mjs run --config integrations/native/conversation-execution.vitest.config.mts`，2 pass（`native-port.log`）。无 lint 脚本。独立审查记录位于 `.local/t7a-settlement-20261023/independent-review.md`，最终结论由主执行者核对冻结文档、Linux 与 Git 版本后记录。

### 对 T7 的作用与剩余义务

本次补原一个明确记录族的本地处置接缝和失败收敛证据，部分推进 A1/A2；未解决其 Provider/输出归账、未知 outbox、后台写者失权、跨进程物理回调或完整关联图结清，也未证明其他逐族记录可 eligible/stopped/terminal。

四个全局 blocker 不只是等待外部材料的开关：当前原 scanner 始终加入 `NON_DATABASE_RESIDUE_UNVERIFIED`、`EXTERNAL_WRITERS_UNVERIFIED`、`WRITER_COVERAGE_INCOMPLETE`、`OPAQUE_RUNTIME_METADATA_UNVERIFIED`，所有业务 metadata 记录仍 blocked，`complete:false/safe:false`；它尚无消费真实证据并按原消费者语义分类的接缝。本次没有删除这些 blocker、注入 safe/ready 或以 manual_reconciliation 代替证明。原 review/restore 仍拒绝，A1 全范围、A2 全范围、A3/A4 正向恢复、T7-B/C 与真实员工验收均未完成。Windows 继续保留原 residue unsupported 的失败关闭行为。
