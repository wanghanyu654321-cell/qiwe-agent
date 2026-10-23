# T7 恢复证据接点与渠道安全准备实施计划

> 当前执行顺序以[产品可用闭环计划](roadmap.md)为准（2026-10-21收紧）。本文保留7b69a13增量的实现、证据和未闭合事实；下列任务完成只代表该增量完成，不代表T7或产品闭环已可用。下一步先形成原门禁所需的逐项处置/围栏契约，再验证完整恢复与同一请求的企微业务回复，避免重复扩展外围检查。

> **For agentic workers:** 使用 subagent-driven-development 分任务实施和独立审查。

**Goal:** 为四类证明补充真实的当前进程证据接点和企微预备连接生命周期，无法核实的全局依据继续阻断，不绕过原恢复门禁。

**Architecture:** 复用实际组合 Native GroupQueue，增加只供恢复检查读取的同步义务计数；保持原 getStatus、调度、扫描器、DB 和 gate 不变。企微增加只在 isolated-synthetic 模式可装配的独占生命周期控制，业务监听先装配而执行保持关闭，真实认证事件和 OPEN 同代才算运输层准备完成；实际原 gate ready 和同代复核后才允许启用业务。

**Tech Stack:** 原 TypeScript/SQLite/GroupQueue/企微 SDK 1.0.7，现有 Vitest 与 Windows/Linux 完整宿主验证工具。

日期2026-10-21；基线05f90289baffa191b39d1456808fdc1643fcd7d4，分支feat/wecom-recovery-evidence-t7，依赖PR10。不动生产、不发真实消息、不新增模型调用、不读取实际DB/env/配置，不新增依赖、不复制私有源码或二进制。

## 已核实的硬边界

四项全局证明不是四个布尔开关。原scanner没有逐行处置分类器，所有业务/文件记录均blocked；beginWrite覆盖、旧进程/Provider围栏及不透明值解释未闭合。不能以本进程全零、SDK认证、管理员确认、接口返回或测试注入safe授予恢复。项目根.env/config扫描与管理员inspect已由PR10完成，本轮不重做。

Native IM七类provider不包含企微；普通connect包含补收、状态写入、卡片和定时工作，不能放进restore prepare。企微SDK的OPEN不代表认证，connect返回不代表就绪；SDK本身没有维护期持久收件箱。准备期间入站必须让准备失败并保持执行关闭，明确未受理/待重试，不能称可靠收件或自动补发。

## Task 1：真实队列义务快照

文件：新增integrations/native/queue-recovery-overlay.mjs、queue-recovery.test.mts；根执行者接入full-host-candidate.mjs及verify-full-host.mjs。

接口：纯源码转换applyQueueRecoveryOverlay(source:string):string，只对已全树核验的完整O组合GroupQueue精确锚定追加getRecoveryObligations()。返回固定数量，不返回JID、任务ID、PID、目录、凭据或原对象引用：groupCount、activeCount、activeContainerCount、activeHostProcessCount、waitingGroupCount、pendingMessageGroups、pendingTasks、activeTasks、retryTimers、retryTasks、messageRetrySnapshots、processHandles、containerHandles、queryInFlight、pendingIpcDeliveries、acknowledgedIpcDeliveries、teardownWaiters、restartingGroups、stopRequestedGroups、runtimeSafetyBlocks、mutationPauseTokens、retainedSafetyKeys、retainedQueuedWork、detachedRetainedQueuedWork。须包含O appointmentQueuedWork中即使groups已消失仍保留的state，按对象引用去重，不能漏算孤立retry/IPC；局部物理回调write ticket没有可枚举源则明确unknown。同步当前进程观察不是旧执行者围栏或ABA版本证明。

- [x] 实际组合GroupQueue先确认缺方法的RED；真实paused enqueue不执行、快照无副作用；合成注入private state只用于隐藏timer/receipt/runner等风险反例，不冒充真实runner已结清。
- [x] 最小追加getter；原getStatus结果和业务状态不变，输出独立值/脱敏；完整候选类型检查及Windows/Linux复验通过。

## Task 2：企微安全预备生命周期

文件：新增src/role-eval/wecom-bot-preparation.ts、tests/role-eval/wecom-bot-preparation.test.ts；最小修改wecom-bot-assembly.ts及其测试。不得改账本、授权、发送状态机或Native恢复gate。

接口由实施者在测试前固定并记录：createWecomBotPreparation使用明确isolated-synthetic独占SDK生命周期注入，装配前拒绝已有连接/监听/重复ownership；connect/disconnect必须为显式合成port，本模块不能自行创建真实网络客户端。持有已绑定的原gate phase/noteArrival/beginWrite/finishWrite窄接口和可信同步身份/配置指纹读取器。先注册生命周期及原assembly/SDK adapter监听，再一次connect；prepare bounded等待实际authenticated+OPEN，同代失效、取消、超时、身份变化、入站均拒绝并清本次owned连接。业务admission在prepare后仍关闭，activate必须原gate ready、同代认证、最新指纹一致；reconnect/断开不会自动激活。原assembly增加可选可信executionBoundary，enter在异步工作前登记原write ticket，check在既有await边界复核，finally结清；旧未提供调用方兼容。

- [x] 验证仅OPEN/connect返回不得成功、认证前消息/卡片零业务/零发送；异步任务前后失效、取消/超时、晚到认证、配置别名修改、同client重入和精确cleanup反例。
- [x] 复用安装SDK订阅ACK判断及MessageHandler、原assembly/身份/临时账本、实际原gate的同请求场景；只替换网络和外发I/O，不fake认证判定、业务门禁或持久状态。
- [x] 准备期入站令准备失效，不声称可靠收件；未接Native主进程真实连接，不把此局部结果写成完整恢复通过。悬挂只读Promise的write ticket等实际settle才释放；有界拒绝后清理仍可为cleanup_unknown。Provider已发字节/后台任务继续沿原持久状态处理，不视为物理结清。

## Task 3：四类证明现状、组合验证和交付

根执行者维护integrations/native/recovery-inspection.ts、recovery-inspection-overlay.mjs及相关测试，将真实queue义务快照接到候选管理员inspect。只输出固定安全计数和四项证明所缺依据，原proof status保持unverified、restorePermission保持not_issued；不为凑正向路径新增safe/ready端口或手写证明。

- [x] 实际main/HTTP读取同一queue的新增快照，权限/错误端口/暂停业务保持；记录四类证明各自producer、已有事实、缺失的写者/处置依据。
- [x] 公开全量测试/typecheck/build、相关工具和旧调用方回归；原驱动Windows/Linux双进程完整宿主通过。最终源码清单/敏感内容/diff与审查绑定在提交前核对。
- 交付采用经独立规格与工程审查的分支PR，依赖PR10，不合并main；GitHub状态以该分支PR为准，不把本轮增量列为整个T7完成。

## 四类证明的实际依据与剩余缺口

| 全局证明 | 当前真实来源/新增事实 | 仍缺的放行依据 |
| --- | --- | --- |
| NON_DATABASE_RESIDUE_UNVERIFIED | 原descriptor scanner含项目配置覆盖；本轮原GroupQueue增加24项计数，包含脱离groups仍由appointmentQueuedWork保留的state，按对象引用去重 | 文件/IPC/队列逐项关联原输入、run、ACK及消费者停止语义；旧Runner已失去写入/发送能力。局部physical callback write ticket无可枚举注册表，明确unknown |
| EXTERNAL_WRITERS_UNVERIFIED | 本轮企微独占客户端认证/生命周期和当前请求write ticket；Linux合成容器只读、断网是测试隔离事实 | 生产旧宿主、容器、脚本、旁路SQL/文件写者及远端Provider的真实围栏和结清；本进程全零或disconnect返回均不能替代 |
| WRITER_COVERAGE_INCOMPLETE | 源码按固定N/O身份组合，原gate登记保留；企微新增可选执行边界接真实write ticket及原授权事务内复核 | 全部原HTTP/IM/IPC、任务、通知/卡片、配置/授权与原读者的完整覆盖注册和回归；新队列getter只观察，不签发覆盖证书 |
| OPAQUE_RUNTIME_METADATA_UNVERIFIED | 原scanner全表/schema/版本和配置文件元数据；企微准备捕获可信身份/配置六字段私有指纹，等待后重读 | router_state值、cursor/session、任务定义与通知关联、有效Profile/Provider/Tool及配置来源按原消费者语义逐项解释与处置；未知记录继续blocked |

四项独立且还有逐条业务记录的eligible/stopped/terminal分类未实现。不能仅删四blocker：原scanner仍全部blocked、complete/safe=false；同一原HTTP审计/COMMIT和门禁继续拒绝。root未给完整宿主注入safe清单；组合正向只用原original模式本就ready的gate，**不是appointment恢复成功**。

## 当前状态

队列义务接点、候选inspect接线及企微合成准备控制已实现并本地验证。四项全局证明尚未闭合，原恢复仍拒绝。后续T7-A1核实了原放行次序、处置分组及缺失生产者，见下节；并交付[产品使用说明与工程对应](product-usage-and-engineering.md)。未实现新的分类器/围栏，不标记A2–A4或T7完成。下一步先确定缺失证据的原协议接点，不能在外围传safe布尔值代替。

## T7-A1：恢复规则与证据来源核实（2026-10-21）

### 范围与结论

基线7b69a13。N为原Native源码，O为原appointment候选overlay；全树身份见[候选构建器](../integrations/native/full-host-candidate.mjs)，本轮完整宿主运行再次校验了两个身份。以下原源码定位是调查依据，不在本仓复制私有实现，也不表示生产版本已核实。

- 已核实原放行顺序、四类全局缺证、元数据扫描记录分组，以及企微固定任务与通用多技能对话之间的差距。
- 每张表/每个写入口的完整消费者证明矩阵、可执行分类器、旧执行者强制失权及真实渠道装配仍未完成。因此roadmap的A1保留未完成状态，分组清单不是覆盖证书。
- 没有一个有依据的小补丁可以让完整恢复安全通过。按用户“没有把握先交使用说明”的要求，本轮交付产品映射及规则核实，暂不扩写运行代码。已有测试用于确认基线和拒绝行为，不冒充修复后恢复成功。

### 原恢复的真实次序

1. 原会话、管理员、Origin及全部注册资源ACL通过；单店报数权限不等于整机恢复权限。
2. appointment模式paused、无活动write ticket时取得本boot的review stamp，同连接扫描完整清单。每条记录必须有稳定key/version及可信证据，处置为eligible/stopped/terminal，零blocker且complete/safe成立，才发布冻结ticket。
3. restore重新验权并复核同一快照，独占claim；prepare只检查已经完成的准备条件，不临时连接渠道或执行清理。
4. prepare结束复核并进入final，在原IMMEDIATE事务中再次核对授权/快照、记审计并同步COMMIT，成功后gate才ready。新到达和登记写入都会使旧review失效。
5. COMMIT后才drain原消费者。drain失败可返回 `restored:true, executionStart:failed`，所以**门禁ready仍不等于产品能受理任务**；须另验消费者和首条业务。

原依据：O `appointment-boot-gate.ts:118–243`、`appointment-boot-http.ts:123–160,233–329`、`db-appointment-boot.ts.fragment:8–55`、`appointment-boot-assembly-overlay.mjs:71–108`。original模式初始化ready不经过上述恢复，不能作为正向证据。

### 有限处置分组：不是放行结论

| 分组/原事实来源 | 必要核实与反例 | 当前缺口 |
| --- | --- | --- |
| 输入：messages/channel_inbox；N db消息follow-up与index消费者，O selected rejection事务 | queued/promoting不证明未执行；关联run、outbox、IPC、ACK和旧执行者 | 原拒绝事务需要可信 `verifyInputUnexecuted`，当前主进程未提供 |
| 执行：turn_runs、cursors、router_state、sessions、workspace_runtime_sessions、agents、onboarding | 按原消费者解释值及Owner/Profile；租约过期不等于旧进程停写 | scanner只有元数据和状态词表，未解释router_state等不透明信息 |
| 输出：channel_outbox、streaming_cards、workspace_memory_outbox | 发送中、上传完成、未知不可盲重发；关联具体执行、收件方、Provider效果 | 各消费者的结清与迟到回调证据不完整，企微delivery不能覆盖其他outbox |
| 任务：scheduled_tasks、task_runs、task_run_logs | 暂停定义不等于run和通知结束；cancelled也可能存在原专用通知 | 原CAS/取消token可复用，但需旧执行者围栏及定义/run/通知分别分类 |
| 授权路由：chats、workspaces、registered_groups、Profile及版本/草稿、账号、bindings/mounts、用户会话与授权审计等 | 持久资源应保留；核实Owner、权限、配置与恢复后读者一致，connected不证明无在途 | 不能把全部resource判eligible，完整有效配置及读写覆盖未完成 |
| 记忆：stores/items/versions/platform_items/provenance/tombstones/mutation_requests/audit_events | 版本、来源、撤销及待写outbox一致；合成资料不得成为真实证据 | 原记忆读写协议和全关联分类未验证 |
| 用量额度：billing_plans、subscriptions、balances、quotas、usage/summary、transactions、redeem及audit | 无模型报数不免除同一宿主的全局扫描；金额/用量按原规则核实 | 原业务消费者未审完，不能以免费、余额零或无流量推定安全 |
| 文件/队列：IPC、streaming-buffer、sessions/env/config、项目配置；descriptor scanner和GroupQueue | 文件存在或缺失不是ACK；孤立retained state、物理callback、旧runner不得漏算 | 当前进程计数不能证明旧写者失权；文件与输入/run/回执关联仍缺 |
| sqlite_snapshot观察项 | 同连接变更检测仅说明观察边界 | 不是跨进程围栏或业务完成证明；原scanner已存在，不是本轮新增 |

分组依据O `appointment-boot-inventory.ts:15–240,332–470,809–850`，具体源接点和反例在本地 `.local/t7a-20261021/recovery-audit.md`。此处只界定调查范围，不证明每族消费者覆盖完整。schema变化、未知状态、读失败、预算超限和扫描期间变化仍各自阻断。

### 下一步的实际依赖

1. 先界定原宿主、runner/容器、IPC、HTTP/IM、调度通知、配置授权、旁路SQL/文件及远端Provider如何失去继续写入/发送的能力。当前ticket和零计数不足；真实旧执行者与外部结果只能后续受控核实。
2. 再选一条原规则明确的分类：原暂停/软删scheduled_tasks可作候选，但须同时核实next_run为空、原revision/CAS、无活跃run、旧scheduler/runner失权、通知关联结清。先用到期任务、活跃run及迟到写入做拒绝反例。该分类不能顺带放行task_runs、通知或四项全局证明。
3. selected input reject缺可信未执行验证器，不能看到queued就拒绝处置；memory、billing和配置族不能凭名称推断。缺原协议时保持blocked，停止依赖它的代码。
4. 全范围同次扫描满足条件后，验证review/restore/COMMIT/drain和恢复后业务。渠道准备必须在review前完成并结清状态写入，restore中的prepare继续只检查，再验证同一宿主的报数、回复和重启查回。

**平台修正：** O `appointment-boot-inventory.ts:332–347` 的安全文件扫描只支持Linux目录描述符，Windows明确产生 `RESIDUE:UNSUPPORTED_ROOT`。因此Linux承担正向恢复验收，Windows承担启动、原驱动、兼容及拒绝路径验证；跨平台扫描移植不是默认范围，不能删除检查凑通过。当前Linux仍缺四项证明，也未成功恢复。

### 本轮本地核验

qiwe-agent根目录，7b69a13运行代码加本轮文档修改：`npm test`为41文件542项通过；`npm run typecheck`、`npm run build`通过。未改运行代码或增加行为测试，未运行lint（仓库无脚本）。

Windows命令为 `node integrations/native/verify-full-host.mjs N源码绝对路径 --host-overlay O源码绝对路径 --sqlite-driver 本机已验证驱动绝对路径 --typecheck`，实际路径见本轮执行记录。runId为 `2026-10-21T10-41-37-942Z-ab471cf9-635b-4bf5-9258-351cade935ba`，boot/restart进程16192/15892，每轮8通过、8项平台跳过，候选类型检查通过。原review仍拒绝，历史promoting及通知保持原状；没有成功恢复或恢复后业务证据。

日志在本地 `.local/t7a-20261021/{public-tests,typecheck,build,native-baseline}.log`。本轮未重跑Linux，不把上一轮结果计入本轮；未动生产、真实消息、模型或实际业务数据。独立审查和GitHub状态以本轮交付记录为准。

## D1 对 T7-A1 的范围增量（2026-10-21）

基线 `19bfc67`，D1只补岗位空间准备与企微会话选择，执行进度见[对话接线计划](wecom-native-conversation-plan.md)。以下是本次已核实的覆盖要求；不是四类证明已通过，也不是完整A1清单完成。

| D1读写入口 | 持久/运行事实与原来源 | 必须保持的恢复规则 |
| --- | --- | --- |
| 本人岗位Profile准备 | 原 `routes/agent-profiles.ts`、`createAgentProfile`、Profile prompt versions；原 `installProfiles`/创建journal | owner和模板必须来自可信上下文；原policy引用校验与能力锁保留。`listAgentProfilesForUser`可能创建默认Profile，不能作为不受门禁管理的纯读 |
| 非Home空间创建/绑定 | 原 `routes/groups.ts`、`assignWorkspaceAgentProfile`、`setRegisteredGroup`，涉及 workspace/Profile映射、registered_groups及workspaces投影、内存注册表与原prewarm | 原额度、system/profile锁、模式、发布/回滚保留；未知创建不能盲重试；空间门店归属不能仅由名字猜测。Profile已有不证明工作空间已绑定 |
| 企微会话选择与准备来源 | 原BotTaskStore同一数据库内新增`bot_conversation_events`、`bot_conversation_current`；原Native `router_state`增加`wecom-role-workspace:v1:`资源claim/绑定与`wecom-role-owner-claim:v1:`本人准备互斥记录 | 需可枚举并保留绑定/授权版本、原门店及事件归属。旧事件重投不得覆盖后续选择，未知准备保留查回状态；不能在维护期承诺业务已受理 |
| 准备中的异步操作 | 原账号/绑定读取、Profile和workspace准备、迟到完成及请求取消 | 授权/门禁重读与真实write ticket覆盖实际settle；4秒请求结束不证明底层准备已经结束，不提前释放票据或宣布无外部写者 |
| 选岗反馈与普通文本分流 | 原回复意图/发送端口；D1不启用D2的原消息提交 | 选岗成功只证明绑定与模式保存，不能回复Agent任务已开始；未接通执行时明确提示，不能偷偷回退报数。发送未知仍独立保留，不重建已完成准备 |

原O scanner已识别上述原资源表，但行仍按原规则blocked；新增渠道状态/journal还需跨库/文件证据覆盖，不能因不在原SQLite就排除。若引入原DB新表，固定schema/projection必须同步，否则原unknown-object拒绝保留。门禁关闭时仅可执行获准只读核查，不能通过换original模式、注入safe/ready或空库来证明appointment恢复。

D1当前采用原`router_state`命名空间保存最小来源事实，没有新增Native数据库或改动原schema；这减少迁移，但不减少解释这些值的恢复义务。`pending`不因进程重启、请求超时或门店变更自动回收；`ready`必须能核对原owner、Profile、非Home空间和门店绑定。资源发布与选择反馈不同步时保留未知，不重建资源。原创建路由没有完整的企微来源审计事件，不能将`created_by`误称为完整审计；新准备事实补上来源关联，完整恢复分类仍待后续原门禁验证。

四类证明分别新增关注：非数据库残留包括准备journal/内存发布与prewarm义务；外部写者包括并发旧准备者及迟到完成；写者覆盖包括原Profile列表隐含创建、资源服务和选择状态写入；不透明元数据包括空间归属、授权版本、准备未知与选择代次。D1局部验证不能替代这些证据生产者，也不完成A2–A4。

## D2 对 T7-A1 的必要增量（2026-10-22）

D2以D1提交`5ee3ee0`为基线，只在原服务隔离夹具中验证消息受理，不向原main注册企微自然语言入口。默认完整宿主候选不启用新表；D2专用候选显式启用后，新增事实是原Native同库的受理关系（`wecom_conversation_receipts`）及其指向的原`messages`输入。Q继续复用既有会话选择和回复意图，不另存一套业务消息。

- 同库事务需要把原输入和固定来源、账号、门店、岗位、绑定/授权版本、选择代次一起提交；提交成功而回复丢失时查原记录，不重新执行业务。
- 该表在 D2 交付时是原固定 schema 扫描的新对象。2026-10-23 的 [T7-A 必要条件补齐](t7a-necessary-conditions-acceptance.md) 为显式候选补入实际生产者 schema hash、固定列形状和 blocked 元数据投影；仅这些已知表不再触发 UNKNOWN_OBJECT，未知对象、schema 差异和逐记录处置缺证继续阻断，不以空表或局部测试签发恢复许可。
- 写者包括原消息保存事务、后续原队列/历史消费者及Q回复意图。D2没有新增常驻消费进程；D3才接实际执行关联，届时必须把启动、合批、追问、取消及恢复读写纳入原规则。
- 本地服务夹具没有轮询器/runner；完整宿主仍保持暂停。原轮询及会话历史会消费原消息，因此不能把D2端口先接到活动宿主再等待D3，也不能借原`queued`状态暂存后宣称不会执行。

以上只是有限的范围登记，不完成四类全局证明或A1全部清单。D2的隔离验收不能替代恢复后同宿主执行、真实平台回复或员工验收。

## D3 对 T7 的必要增量（2026-10-22）

D3 从 `3282756` 继续，仅验证原服务片段，不给完整宿主签发恢复许可。新增同库执行关系 `wecom_conversation_execution`，记录受理号、实际输入集合、query/turn/session、执行状态及取消意图；其升级必须沿用原 schema 版本和备份门禁。

- A1登记原队列启动、运行终态、取消中断、session处理及执行关系写者，不增加新的全局证明类别。
- A2/A3需处理已排队、正在执行、取消处理中、失败和未知分别能否恢复。中断信号不等于执行停止，进程退出不能把未知状态改成完成或自动重跑。
- 新增表及输入/输出、旧 session 的关联须纳入原扫描规则。2026-10-23 已补已知执行表的 blocked 元数据投影；未知对象、四类证明及未解释的关联继续阻断。本地片段不证明旧 runner、工具或外部写者已经失权。
- 默认完整 O 候选继续按原规则启动和拒绝恢复。N 原服务片段使用合成末端 runner 的正向证据只覆盖 D3 接线，不能替代原恢复后同宿主执行及 D4/D5 验收。

## D5 对 T7 的必要增量（2026-10-23）

D5 延用 D3/D4 的显式隔离候选，增加同库 `wecom_conversation_results` 终态快照，并把结果版本、页码和原收件人关联到 Q 已有的 `bot_reply_intents`。开发与验证状态见 [D5 验收记录](d5-acceptance.md)。没有新建结果数据库、通知调度器或恢复许可。

- A1 的写者清单补入原持久输出见证、终态与快照事务、完成通知回调、按受理号补建回复意图和显式重试。异步读取实际结束前仍保留原 write ticket；发送回执未知继续保留独立状态。
- Native 候选 schema 升至 72，继续使用原升级备份及较新版本拒绝降级规则。不能从会被覆盖的历史消息补造旧结果快照，旧记录缺少终态证据时如实保留待核实。
- 2026-10-23 已为显式 schema 72 候选补入三张已知表的完整分页元数据投影，所有记录仍 blocked。跨库回复关联与逐记录处置、未知 schema/对象、四类证明和旧写者问题继续阻断完整恢复。局部测试不能签发恢复许可，详见 [必要恢复条件与验收](t7a-necessary-conditions-acceptance.md)。
- 回退先停止新对话及结果通知的受理，保留快照与通知记录以供查回；不能删表、重跑 Agent 或把 attempting/unknown 改成可重试来恢复发送。

## 本地执行证据（此前T7增量）

2026-10-21，qiwe-agent根目录，上述基线加本轮变更。日志在本机.local/t7f-20261021/，不把合成明细或私有源码导入Git。

| 检查 | 实际命令/结果 |
| --- | --- |
| 公开回归 | `npm test`：41文件542项通过（public-after-review.log）；`npm run typecheck`、`npm run build`通过 |
| 工具 | `node --test integrations/native/prepare-native-sqlite.test.mjs integrations/native/verification-options.test.mjs integrations/native/linux-runtime.test.mjs`：15通过、1项Linux专属跳过；包括精确公开fixture允许范围RED/GREEN |
| 旧调用方 | `node node_modules/vitest/vitest.mjs run --config .local/t5-20261018/legacy-vitest.config.ts`：17文件148项通过；alias当前manager/training，不是全私有产品验收 |
| Windows原驱动 | `node integrations/native/verify-full-host.mjs ABSOLUTE_N_SRC --host-overlay ABSOLUTE_O_SRC --sqlite-driver ABSOLUTE_PREPARED_DRIVER --typecheck`：候选类型通过，boot/restart各8通过、8项Linux专属跳过（windows-audited-final.log） |
| Linux原驱动 | `node .local/t7f-20261021/run-linux.mjs --typecheck`：候选类型通过，boot/restart各15通过、1项Windows专属跳过（linux-audited-final.log）；本机现有Debian12/Node22.23.2镜像，network none、rootfs及受控源码只读，无镜像拉取 |

Windows最终runId `2026-10-21T10-09-01-151Z-7c86512a-b4ba-4061-bac5-808faa8d2a75`，PID34904/34592；Linux最终runId `2026-10-21T10-09-09-147Z-1dab44f6-bcb5-4768-90c1-31452fa327b8`，PID44/104。每次均两个不同OS进程复用同一原合成SQLite快照。原N/O全树校验、208个组合模块、测试及18个public support closure source/compiled hash绑定实际运行。Linux原始audit随tmpfs销毁，现将同runId的FULL_HOST_AUDIT_HASHES保留在stdout日志，含组合hash规范摘要及全部instrumentation；两系统均通过本地validate-audit.mjs比对当前源与日志。public helper编译只读本仓公开源码，不求值原件config/index。

新增联合场景经真实SDK handleFrame订阅ACK0及非0、MessageHandler、准备控制、实际O gate、原assembly/授权/adapter和临时SQLite；original模式正向保存1条报告/1条回复，维护或读取中配置变化均为0/0和零发送。main/HTTP场景仍paused，原promoting输入、到期任务和失败通知保持原样，未执行正常restore或恢复后drain。

基线首次公开回归有旧manager-artifacts跨进程制品发布用例artifact_unavailable（521通过1失败），专项复现通过，后续两次全量均通过；未修改该业务模块或弱化测试。初版Native组合在controller已捕获方法后才安装spy，造成计数0的夹具问题，改为捕获前安装后复验；不算产品缺陷RED。实际需求RED为原queue缺方法、DTO遗漏queue证据、源精确允许项缺失，以及已修复的悬挂读取提前释放票据。

另在一次性公开源码副本只替换基线旧assembly，再执行同一Native联合测试：两项目标失败（没有登记write ticket、读取中配置变化仍handled），见boundary-functional-red.log；实际工作区未回退。审查还发现原Linux日志缺持久audit hash，先验证旧日志MISSING_PERSISTENT_RUNTIME_AUDIT_HASHES，再补上述输出并重跑双系统通过；不沿用旧tmpfs审计冒充可追溯证据。

已知限制：没有真实企微连接/手机实收、生产配置核对、Provider结果确认或成功appointment恢复；没有维护期持久收件箱，入站input_not_accepted不能保证自动重投；旧同SDK客户端不可重新认领，清理后保留一条inert error监听。无lint脚本/CI配置，不宣称lint或CI通过。
