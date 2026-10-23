# T7-A：完整 O 宿主与 D1–D5 对话接线

## 当前恢复改造（本地正向闭环已验证）

2026-10-23，基线 `f3ff566`，分支 `feat/wecom-host-resume`。本节覆盖本轮；下文原接线结果为历史，不能替代本节的当前版本证据。

- 用户确认：未知旧任务/回复保留待人工核对，不自动续跑/重发；管理员可恢复整个宿主，不能因此读取员工内容。
- fullhost schema 73 在原 `router_state` 保存精确版本的保留记录，原 task/message/execution/result 行不改写。原到期扫描、claim、回收、通知及会话消费者检查保留状态。不同的新请求仍沿原路径。
- 管理接口继续使用原当前管理员、Origin、review ticket、重查、SQLite COMMIT 与 drain；只拆分全局恢复快照与私有内容读取权限。选定内容处置保留原 ACL。内部维护函数复用原 write ticket，不新增公网 API。
- 暂停时阻止原 HTTP/WS 写入及维护定时器；管理员登录仍可通过原登录流程取得恢复身份，并被原写票据跟踪。未知外发结果不推断成功或自动重发。
- 原 inventory 只在实际观察满足时放行支持的记录；未知结构、执行性 IPC、未知旧状态继续阻塞。本地外部写者证明只适用于固定离线 Linux 容器：只读源码、隔离网络/进程空间、实际子进程持有同库与 IPC 写能力后退出、PID1 保持只读已解除链接的证据描述符。它不是生产恢复开关。
- 原72→73备份及旧72拒绝打开新73已做真实 SQLite 验证。回退须使用理解73保留语义的兼容版本，不能降版本号或覆盖新数据。

当前验证命令：原 `verify-full-host.mjs N --host-overlay O --full-host-conversations --typecheck` 做暂停回归；离线 Linux 加 `--restoration-scenario`，先独立进程准备合成旧记录，再两次实际 main 启动并经原恢复 API，核对不同 worker PID、离线 SDK 收发和已存结果。该选项只选择测试，不改变门禁状态。外部 runner/model I/O 使用确定性替身；原宿主、队列、账本、scanner、恢复事务、D1–D5接线保持真实。

证据保存在 `.local/t7a-resume-20261023/`。Linux 正向场景 `restoration-integrated-3.log`，runId `2026-10-23T11-13-03-118Z-32fefa85-f7f7-403e-9098-c03d4917f5f2`：独立 seed 进程 44 准备真实 SQLite 合成历史；原 main 进程 83 恢复后，经过离线官方 SDK、可信身份、D1 岗位选择、D2 受理、同一原队列及 D3/D5 持久结果，runner 执行 1 次、通知 1 次，主动查询可读到相同答案。进程 127 恢复同一数据库后再次查回，runner 0 次、通知 0 次；没有重新 seed。旧 task/run、D2/execution、Q unknown 回复保持原内容。两次均经过原 review/restore/COMMIT/drain，未注入 safe/ready。

同场景验证管理员全局恢复权限、普通员工恢复 403、选定他人内容处置 403、管理员读取员工消息 404、本人读取 200。保留操作验证旧版本拒绝及当前管理员身份，已完成且有合法冻结答案的旧对话仍允许本人通过新查询取回，并明确“待人工核对”；排队/运行状态不会伪装完成或直接取消。

实际运行修复的必要缺口包括：原 SQLite `_rowid_` 返回列名导致会话元数据读取失败；原管理员 Home 固定为 host，须在原 host-inline 执行点先执行已有业务边界检查；原自动生成的、从未 claim 的初始 onboarding 和 memory store 索引按真实消费者合同识别；原 IM 迁移存在性标记与信息性 IPC 快照按精确路径识别。未知状态、已 claim onboarding、任意 host 配置及执行性 IPC 不因此放行。

| 当前验证 | 命令与结果 |
| --- | --- |
| 公共回归 | `E:/npm.cmd test -- --maxWorkers=1`：43 文件、598 测试通过；`public-after-review.log` |
| 公共检查 | `E:/npm.cmd run typecheck`、`E:/npm.cmd run build` exit 0；无 lint 脚本 |
| Windows 原完整宿主暂停回归 | 原 full-host 验证命令加本地 SQLite adapter：typecheck 0、环境 1、岗位 3；boot/restart 各25 pass、8个 Linux 场景 skip。`windows-regression-4.log`，runId `2026-10-23T11-31-34-674Z-f072c271-6aed-420d-9ed8-acbcfae0c14d`，PID 7436/13392 |
| Linux 原完整宿主暂停回归 | 固定离线容器运行原 full-host 验证命令：typecheck 0、环境 1、岗位 3；boot/restart 各32 pass、1个 Windows 场景 skip。`linux-regression-3.log`，runId `2026-10-23T11-31-32-765Z-e945bfc4-ecd8-438e-b0ce-504a21e94276`，PID 110/252 |
| Linux 原完整宿主正向恢复 | `verify-full-host.mjs N --host-overlay O --full-host-conversations --restoration-scenario --typecheck`，由固定镜像 `--network=none` 容器执行；typecheck、seed、boot、restart 均通过，PID与runId见上文 |
| 判定与监督器专项 | `node --test integrations/native/full-host-restoration-classifier.test.mts`：13 pass；监督器专项5 pass，Windows不支持的PID1正例1 skip，该正例由Linux整链实际执行 |
| 原模式兼容 | 与 `f3ff566` 比较 default / D2 / 旧 D3–D5 全部组合模块内容一致；不把历史平台回归写成本轮重跑 |

原权限403、缺少消费者阻断、通知租约丢失、host-inline实际spawn及保留查询丢答案均有对应失败证据；已修复后重跑相关行为。`restoration-integrated-1.log`（会话列名/迁移标记）与 `restoration-integrated-2.log`（原初始引导/记忆索引）是保留的失败记录，不计成功。`linux-regression-final.log` 的9项失败来自旧测试要求全部条目阻塞及 inspect 固定报告缺证；已改为核对实际报告，并具体断言危险文件/IPC/不安全目录仍阻塞，原全局拒恢复断言保留。`windows-regression-2.log` 因误用相对源码路径被参数解析器拒绝，未执行测试，不计行为失败或成功。

本轮只证明本地合成环境下“恢复→操作→回复→新进程查回”。没有真实连接、手机实收、模型质量或生产验收；静态Web资产未复制，浏览器页面未验收。完整宿主上的连续追问、精确取消和原 Pi 多技能组合仍需沿用现有D3/D4能力补验，不能用本次确定性runner替身替代。生产必须提供与其真实运行环境相符的旧执行者失权与恢复事实；此处固定Linux验证进程的证据不能移用。

最终三个成功运行的组合摘要均为 `ba7b65faad50cbeeeed14bf30c1f9c94f0e1425214b8e6539de849a290ef9b4c`，已逐文件核对实际运行来源。独立规格、权限、保留语义、异常及兼容审查未留下阻塞问题；曾发现的旧已完成对话不能取回保存答案已修复并复审。第二次普通 Linux 运行 `linux-regression-2.log`（31 pass、1 fail、1 skip）发现旧卡片 fixture 仍要求固定非数据库 blocker；最终改为核对实际被动残留，同时显式保留其余三项缺证、六条 card/turn 阻塞及宿主暂停断言，第三次通过。运行代码未因此放宽。审查报告和精确文件清单保存于同证据目录的 `independent-review.md` 与 `final-manifest.json`。

最终暂存检查后只清理三个文件的末尾空行；`format-only-proof.json` 记录测试版本与交付版本的对应哈希，核实转译程序完全一致，重新组合的运行摘要仍为上述值。不将这三个文件的新原始哈希冒称为旧日志中的哈希。

## 先前同宿主接线交付（历史）

2026-10-23；开发基线 `915b4309e90125eecbcaa297bcd0591f850474fd`，分支 `feat/wecom-full-host-conversations`。本轮只做隔离合成候选；保留 [T7-A 必要条件](t7a-necessary-conditions-acceptance.md) 的四类 blocker，不签发恢复许可，不连接真实渠道、不发送真实消息、不调用模型、不读取真实配置/业务数据库、不安装依赖。

## 组合契约与最小迁接

`createFullHostCandidate(N,O,{conversationIntake:true,fullHostConversationExecution:true})` 明确保留完整 O 的 `index/main/queue/Web/DB/gate`，复用已有 D3/D5 DB、history、batch/session/cancel、canonical projection witness、frozen results 和完成通知 hook。新选项必须为 boolean，要求 intake，且与旧 `conversationExecution:true` 互斥。旧 D2 与 D3/D5 默认调用方保留原语义；默认完整 O 的全部组合字节不变。

| 接点 | 本轮行为及证据边界 |
| --- | --- |
| D1 / D2 | 既有 Native owner/Profile/workspace 与受理服务仍在同候选；原 `createRoleWorkspaceNativePort`、`createBotConversationNativePort` 绑定实际 main gate。实际暂停时 D1 prepare 返回 unknown，D2 submit/readReceipt/readResults/cancelReceipt 均按原契约拒绝 |
| D3 | `initializeFullHostConversationExecution` 只固定可信授权/完成回调，返回实际 main 的同一 queue/gate；不接收替代 runner，不再次 loadState、不重设 processMessagesFn、不枚举/入队历史 receipt。enqueue/cancel 也必须经过该 gate 的准入与 write ticket |
| 队列身份 | 复用旧 D3 在本 GroupState 的 active/queryInFlight/queryId 读取。O 的 getActiveQueryId 需要 attachProcess 后的 groupFolder，不能用其替代首次 cold-run 身份。真实队列局部测试覆盖首次 enqueue 到 callback；它使用独立 original-mode queue，未恢复完整宿主 |
| D4 | 完整 O 原 cold runner/Host fallback/Pi/skills closure 保留。D3 wrapper 仅在同 query 有 running/cancelling 对话 batch 时观察；无对话 batch 的原 runner 直接透传。本轮未执行模型或同宿主多技能业务 |
| 原 Web warm turn | 真实长驻 runner 后续 turn 的输出仍送交原 onOutput 及其路由/权限规则；D3 只观察标识完整归属于初始 conversation turn 的事件。其他 turn 的 error/interrupted、新 session 和最终 return 不清除初始 witness，也不充当初始 D5 完成证据 |
| D5 | 原 canonical persisted output witness、finish batch 事务、冻结结果与 onCompleted hook 迁到 O 的原执行位置。原 SDK/preparation/assembly 与原 conversation delivery 在实际 main gate 下装配并验证维护拒绝；未发生新完成回调、输出生成或通知投递，恢复后成功链仍待验收 |
| 恢复 | 新三表继续纳入原 metadata inventory、逐条 blocked。完整 O 中授权绑定不把 running/cancelling 改为 unknown；迁移也不把旧 D2 receipt 自动补成 queued。旧片段 D3 默认恢复语义保留 |

绑定发生在真实 main 启动后，不改变 gate 状态。原 `main().catch(...)`、WebDeps、所有旧维护路由、原 shutdown 和 COMMIT/drain 次序保留。新接点没有恢复动作或对外配置入口；这仍是可实际启动的本地隔离候选。

完整 O 新增的 DB imports 放在原 `load-env` 之后。另一个独立 worker 在进程环境完全没有 execution boundary、仅有新建合成 `.env` 的条件下，按实际生成 index 编译后的 runtime import 顺序加载真实依赖，验证 policy 捕获 member-container-only。该依赖切片没有 main，不会在错误的 original 模式下先启动业务；它和完整 main 暂停场景分别记录。

## 实际暂停与持久化验收

`verify-full-host.mjs N --host-overlay O --sqlite-driver PREPARED_DRIVER --full-host-conversations --typecheck` 在临时 cwd/home、真实 SQLite 和 loopback Web 中执行原 main。Linux 使用同一入口，省略 Windows driver，经既有固定镜像和 `--pull=never --network=none`、只读输入/rootfs、临时写入根运行。

第一进程只在启动前准备合成历史 fixture：D1 当前选择、D2 receipt、D3 queued/running/cancelling/completed、D5 历史冻结结果、prepared/attempting/unknown 回复 intent，以及原 promoting 输入、任务和失败通知。历史记录是维护保留反例，不能计为该暂停宿主已受理、已执行或已生成的成果；fixture 的历史 member 账号在当前 boot 已为 admin，不作为当前可执行授权。

实际 main 启动后，同一 queue/gate 绑定被核对到原 WebDeps；原 SDK 的岗位选择、新文本、查询、取消四种事件经原 preparation/assembly 装配，保持 prepared 且不能 activate，按原维护规则关闭输入，不读业务身份、不产生回复；独立调用原 D5 delivery 的 recover 也因同 gate 维护而拒绝。直接 D2 port 的读取/受理/取消拒绝，以及直接 execution enqueue/cancel 拒绝均另有断言。

两轮都验证原 HTTP status/inspect/review、ACL/Origin/票据拒绝、原暂停 queue 不执行、原 SIGTERM shutdown、SQLite 重开；第二轮是外层重新创建的不同 OS worker PID，不重新 seed。对 Native receipt/execution/results 与独立 BotTaskStore/ManagerStore 的完整业务快照核对，证明选择、旧结果和旧通知不变。维护观察通过 DB 读取历史数据；员工查询入口仍被原维护 gate 拒绝，不能将观察查回写成员工成功查询。

## 失败证据与结果

本地证据在忽略目录 `.local/t7a-fullhost-20261023/`，成功日志均绑定唯一 runId、组合 hash、实际 index/test/verifier/fragment hash 与两个 worker PID。

- 初始 RED：`red.log`，runId `2026-10-23T08-27-15-051Z-c4493f49-6a4d-4396-b908-b4d0890f9939`，已有 intake 候选 schema 70 无完整执行接线，目标期望 schema 72 失败。
- 绑定 RED：`red-binding.log`，真实 main 启动后绑定沿用旧 D3 恢复动作，running/cancelling 被改 unknown，完整快照断言失败；完整 O 模式已移除该启动写入。
- cold-query RED：`red-query-valid.log`，runId `2026-10-23T08-40-27-148Z-d2341725-ccee-467c-b670-24a7c60ac2ae`，原队列已到达 callback，alias 返回 null 而非实际分配的 queryId。先前 queue fixture 未打开 SQLite 导致的超时/`QUEUE_CALLBACK_NOT_REACHED` 属于环境准备错误，不计目标行为 RED。
- 默认 O 组合摘要保持 `783f3f0d9698e8c1987cfedccad119fa47cb461df08027b9bacd1dcc9507c8d7`。
- 独立审查 P1 RED：`red-env.log`，runId `2026-10-23T08-53-08-446Z-42ecf928-7452-4054-90ef-5dd0f86ed22f`；真实候选依赖切片在 `.env` 已加载后仍捕获 original。修复仅作用 fullHost imports 顺序，旧 isolated 生成字节不变。
- 独立审查 P2 RED：`red-warm-wrapper.log`，runId `2026-10-23T08-53-54-736Z-ad45f316-9eb1-4336-85f8-781f11f56c24`；从实际候选提取并执行的 wrapper 在合法后续 warm turn 抛 `D3_RUNNER_TURN_MISMATCH`。修复后初始+warm success/error/interrupted、mixed identity 与 foreign terminal return 均有行为断言，覆盖原输出透传、初始 session/result 不污染和不误 invalidate witness。这是生成 wrapper 的合成依赖行为验证，不是原模型或完整恢复后的执行证明。

| 本轮验证 | 实际结果 / runId / PID |
| --- | --- |
| Windows 最终完整 O+D1–D5 | 上述 full-host 命令：实际候选 typecheck exit 0；`.env` 依赖行为 1 pass；角色服务 3 pass；boot/restart 各 11 pass、8 个 Linux 专属场景 skip。runId `2026-10-23T08-58-07-263Z-f331bd99-9255-4ae4-970b-bc608cdfc8b5`，env worker 11820，main worker 16316/16684；`windows-fullhost-final.log` |
| Windows 默认完整 O | 本轮 P1/P2 修复前已跑相同 default 生成字节：角色 3 pass；boot/restart 各 8 pass/8 skip，typecheck 0。runId `2026-10-23T08-42-12-285Z-bb5af5d6-251d-434c-8252-442f9cedb79f`，PID 38796/32232；`windows-default.log` |
| Windows 既有 D2 | `verify-conversation.mjs N O PREPARED_DRIVER`：typecheck 0，两独立进程各 2 pass。runId `a8d23792-b11a-4603-9880-66732e890d71`，PID 39480/12340；`windows-d2.log` |
| Windows 既有 D3/D5 片段 | `verify-conversation-execution.mjs N O PREPARED_DRIVER`：typecheck 0，两独立进程各 2 pass。runId `394f5bde-6a8f-4d62-a2ab-4a672f701895`，PID 11784/39572；`windows-d5.log` |
| Linux 最终完整 O+D1–D5 | `.local/t7a-fullhost-20261023/run-linux.mjs fullhost` 运行同 full-host 命令和固定镜像：typecheck 0；`.env` 依赖行为 1 pass；角色 3 pass；boot/restart 各 18 pass、1 个 Windows 专属 unsupported-root 场景 skip。runId `2026-10-23T08-59-06-614Z-d0562e20-4737-4d8d-ae7b-7dcfb3934645`，env worker 44，main worker 110/185；`linux-fullhost-final.log` |
| Native 选项准入 | `node node_modules/vitest/vitest.mjs run --config integrations/native/conversation-execution.vitest.config.mts`：2 pass；包含新 flag 的类型、前置与互斥拒绝 |
| Linux 修复前未完成运行 | runId `2026-10-23T08-44-42-736Z-c6995c2d-5af4-4449-a96e-78ab87f66622`：typecheck、角色 3 pass、boot 16 pass/1 skip 后，在 restart 运行中超过原 Docker 外层 240s，`ETIMEDOUT`；没有双进程 passed，不计验收成功。仅本地 helper 的外层隔离验证等待预算调为 600s，容器参数、网络、只读、产品预算与断言均不变 |

Windows/Linux 最终完整组合摘要均为 `95680efc2ee4f74ba25fc1b676fb3982226e4bf8f8e433058484dba32cedf0ec`，追加观测 exports 后实际执行 index 的 hash 均为 `2e6e0fb563f8f02a61061ffec432f9516d7431fcb7b60417bac177a01b12d229`。最终日志同时绑定 environment/wrapper 测试与从本次 index 生成的 imports/wrapper 切片 hash。

默认 O、D2、旧 isolated D3/D5 未受 P1/P2 的 fullHost 分支修复影响。默认 O 与旧 D3/D5 的所有组合模块 hash 与本轮 Windows、上一轮 Linux audit 核对；D2 实际 DB hash 与旧 audit 核对，所有组合模块另与基线 `915b4309` 的 D2 builder 比较（相关 D2 transform 本轮未改）。Linux 默认/D2/D5 本轮没有重跑；上一轮运行仍仅保留自身 runId/版本范围，不写成本轮新通过。公共 `src/`、`tests/` 本轮没有改动；主执行者在本仓运行 `E:/npm.cmd test -- --maxWorkers=1`（43 文件 588 pass）、`E:/npm.cmd run typecheck`、`E:/npm.cmd run build`，全部 exit 0，本仓无 lint 脚本。

## 尚未完成

四类恢复证据与逐记录处置仍缺；实际 scan 保持 `complete:false,safe:false`，review 不发许可。Windows 保留原 residue unsupported 失败关闭；Linux 也没有借本次测试制造 ready。完整宿主恢复后正向受理、原 runner/Pi 自主多技能、连续追问、真实取消与迟到输出、真实 Provider 回执、手机实收及生产部署均未验收。

既有 D3/D5 原片段正向证据与默认恢复语义作为独立回归保留，不能与本轮完整 O 的暂停拒绝拼成一次同宿主成功执行。静态前端资产仍未复制，仅 API/WebSocket server 启动通过，浏览器 UI 未验收。
