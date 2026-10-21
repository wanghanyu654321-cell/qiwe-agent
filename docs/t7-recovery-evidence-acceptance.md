# T7 恢复证据接点与渠道安全准备实施计划

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

队列义务接点、候选inspect接线及企微合成准备控制已实现并本地验证。四项全局证明尚未闭合，原恢复仍拒绝。审计在本机.local/t7f-20261021/{proof-contract,channel-safe}-audit.md。下一实质步骤必须进入原可信scanner/消费者边界做逐族处置和写者围栏，不能在外围传一个safe布尔值代替。

## 本地执行证据

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
