# T7-A：完整 O 宿主与 D1–D5 对话接线

## 当前增量：受控试点启动装配

2026-10-24，基线 `b3f28a4`。本轮目标是把员工验收脚本内的实际接线移入可复用的具体生命周期模块，再由同一个完整宿主场景调用。仍只接受 `isolated-synthetic`；外部模型、真实认证、真实消息及生产均不在本轮授权范围。

原宿主仍负责唯一队列、恢复与执行。新入口负责组装原 preparation、SDK、身份、岗位会话和持久通知，复用可信 Native 工厂；不自行恢复、不自动重放旧工作、不替换 runner。准备、激活、停止分别沿用原状态；失效授权按原实时读取处理，迟到完成不能借关闭后的渠道发送。

装配依据为当前 `wecom-bot-preparation.ts` 的独占客户端及门禁合同、`wecom-bot-assembly.ts` 的可信成员分发、`wecom-bot-delivery.ts` 的持久回执恢复，以及完整宿主的 `initializeFullHostConversationExecution` 单次绑定。Pi SDK 和原执行循环不变，本轮无新 SDK 事件映射。MiniClaw 证据边界仍将本地合成、真实渠道和生产分开。

具体入口为 `src/role-eval/wecom-bot-pilot.ts` 的 `createWecomBotPilot`，已替换员工夹具原手工装配。调用方提供原宿主 initializer、原 Native intake/岗位工厂、可信身份读取器、借用的授权/业务存储及显式合成客户端生命周期。入口内实际组装原服务，不接受另一套通用 assembly 或 runner 替身。

调用顺序为：原宿主完成恢复 → 创建 pilot → `prepare()` → `activate()` → 原消息/完成回调与 `recover()` → `close()`。准备成功不代表可受理，激活仍检查原 ready 门禁与同连接认证。停止立即封住渠道新收发，不停止宿主队列或撤销已经受理的工作；原结果保持持久化。`idle()` 只等待本入口拥有的工作，不能代替整个宿主停机。原 initializer 只绑定一次，关闭后不支持同宿主原地重绑。

独立审查复现并修复了身份读取超时的票据提前释放：每次恢复用 Node 内置 `AsyncLocalStorage` 关联自己的实际读取，原 finalizer 请求释放时，待该次读取结束才委托原 `finishWrite`；不同恢复互不等待。没有新依赖或新门禁。未结清或释放失败仍由原 preparation 返回 `cleanup_unknown`，不得据此关闭借用数据库或宣称安全停止。

### 本轮验收状态

最终修复版本已通过本地隔离验证。证据根 `.local/t7-pilot-20261024/`，`final-manifest.json` 对照当前源码、封存输入以及实际 audit 中的 Native 和递归 public support 哈希；新 pilot 的源哈希为 `4a4552b20ce226162d222dbe4add35be1f644ad5e865ee04bd2eaa6386a8e006`。

| 检查 | 本轮实际结果 |
| --- | --- |
| 必要增量 | pilot 新增10项；连同原 preparation、assembly、conversation-results 三专项，共103/103通过。涵盖准备/激活、原受理与答案查回、拒绝恢复不重跑、关闭/构造失败、回调快照、实时撤权，以及三种身份读取迟到后的原票据保留和独立恢复 |
| 类型和构建 | 本仓库 `npm run typecheck`、`npm run build` exit0；最终日志 `pilot-authority-typecheck.log`、`pilot-authority-build.log`。没有运行全仓回归；仓库无 lint 脚本 |
| 完整宿主与真实容器 | outer `e9e71dee-6ff1-4576-8d98-c78b9922a8e6`，verifier `2026-10-24T14-54-53-327Z-83078154-c1d9-405c-aa07-3a674710fe82`，两阶段passed。首次PID308，runner1；批准资料及三技能实际读取，原SQLite保存草稿；通知两次尝试为明确拒绝后accepted attempt2，重复恢复不重发 |
| 第二进程与关闭 | PID2157恢复同库，查回同一完整答案，runner0、主动通知0；旧未知记录不变。两阶段均断言pilot已closed后才关闭调用方存储；本轮容器已移除，测试卷保留复核 |
| 审查修复 | 身份读取提前释放票据问题经subject/binding/native三项有效RED后修复；独立复审确认每次恢复独立收尾，迟到读取后的延迟finishWrite抛错路径保留cleanup_unknown且无未处理rejection。原D5、队列、门禁、schema和依赖均未改 |

增量命令为 `npm test -- tests/role-eval/wecom-bot-pilot.test.ts tests/role-eval/wecom-bot-preparation.test.ts tests/role-eval/wecom-bot-assembly.test.ts tests/role-eval/wecom-bot-conversation-results.test.ts`；最终103项日志为 `pilot-authority-focused.log`。初轮7项RED针对尚未实现的装配行为，修复轮3项RED针对已复现的票据错误，不以导入失败当RED。

实际组合命令为 `node .local/t7-pilot-20261024/run-combination.mjs grounded skip-typecheck`，内层复用前轮原验证器及 `--c4-synthetic-case grounded`，只使用现有本地镜像、只读输入、独立卷和关闭的网络。原候选类型检查已在本轮首组通过，最终仅跳过未变化候选的重复检查；修改后的public模块已另跑最终类型检查和构建。首组outer `7a6b8ac7-83cc-4f0f-bec7-90c028d53812` 虽通过，但属于修复前版本，仅作中间记录。

本轮证明可复用装配接入了实际同宿主链，尚未接真实SDK生命周期和认证。首轮真实试点仍需下方真实配置/成员、实际宿主恢复事实、有限收发授权；真实自然语言效果另需模型与预算。本轮没有改变队列、runner、会话、turn或取消语义，未重复扩大为多轮/精确取消真实容器组合；若真实试点包含这些动作，仍按原计划先补该组合。培训装配也未扩入本轮。

## 前轮增量：T7-C4 合成前置评测

2026-10-24，基线 `78fc5cf`。用户要求先跳过真实企微认证，其余采用合成测试，优先增量回归。本轮复用下节的完整宿主、原真实容器、岗位与 D1–D5，不新增业务能力或改恢复门禁。C4 原计划中的真实模型评测仍待有限模型及预算授权；合成 provider 的正确输出不证明真实模型自主选技能或回答质量。

验收范围：

| 场景 | 观察对象与通过条件 |
| --- | --- |
| 多技能草稿 | 同一美容门店自然语言需求实际读取批准资料和三个已装技能；保存的完整草稿包含来源、两项方法及未发布状态，离线通知和查询对应同一 D5 结果 |
| 资料缺失 | 仅缺少本次隔离空间的批准资料；实际 read 失败后返回 `partial` 和缺项，`draft:null`，不能回填活动人数或声称任务成果已完成 |
| 明确拒绝后的回复恢复 | 原执行及结果已完成；离线平台明确拒绝后，显式恢复原通知，重复恢复不再发送，不重跑 Agent |
| 重启查回 | 每个真实容器场景分别使用新卷并经过原恢复流程；第二个进程只查第一轮结果，不重建样例，不执行或补发 |
| 培训增量 | 原知识、生成、引用与输出校验服务：45 分钟教案、模型禁用/预算/未知错误、无效教案；持久终态可重读，同请求不重复生成 |
| 相关既有行为 | 原培训任务、取消与答案查询专项；原会话输出归属和取消专项。它们是各自层级的回归，不拼成真实容器多轮或培训端到端证据 |

培训仍通过原 `createTrainingGenerationService` 的合成 `generate` 接点验证，没有装到当前完整宿主的员工 assembly。真实容器仍是一条需求、一次 runner、完成后退出；本轮不扩大到重启后 SDK 续聊、任意失败残留放行或高副作用工具。模型生成替身、资料和成员均为合成；企微 SDK 网络为离线替身。

### 实际验证记录

2026-10-24，本仓库基线 `78fc5cf` 加本轮增量，两组最终冻结源码均通过。证据目录 `.local/t7c4-synthetic-20261024/`，其中 `final-manifest.json` 核对实际 audit、源码与封存输入 hash。

| 验证 | 本轮实际结果 |
| --- | --- |
| 有资料的三技能草稿 | outer `9e9775fd-5741-4cf1-9e77-f296e248d6df`；verifier `2026-10-24T11-19-15-672Z-f28f9f2f-01c6-4fda-b421-59c2a505dd83`。PID301→2148；首次 runner1，通知两次尝试（明确拒绝→原通知恢复 accepted，attempt2），重复恢复不重发；重启 runner0、通知0，查回同一草稿 |
| 同需求缺批准资料 | outer `891a5b61-c413-408a-8c34-bd0a8331c101`；verifier `2026-10-24T11-18-13-265Z-8fc3b3fe-2eff-4763-87f3-120954777b8f`。PID298→2142；实际 read 返回 ENOENT，业务结果 partial、draft:null；首次 runner1、通知1，重启 runner0、通知0，查回同一缺项答复 |
| 原工具与隔离 | 两组均真实执行六次 read：三个技能读取成功、两条越界路径拒绝，批准资料分别成功/缺失；实际输出的 query/turn/单 sourceOutputId 与原执行一致。原 review/restore 通过，未知旧记录保留，未放松门禁 |
| 公共增量 | 五专项61/61，加培训新增7项（培训文件最终11/11，包含重复的原4项），合计68个不同用例通过；日志 `targeted-public.log`、`training-incremental.log` |
| Native 增量 | C4/参数/启动/残留19/19，原投影/精确取消7/7，合计26/26；日志 `native-incremental.log`、`targeted-native-existing-configured.log` |
| 静态检查 | `node node_modules/typescript/bin/tsc --noEmit` exit0；原候选类型检查在本轮首组通过，后续仅补测试关联断言，最终两组按更新后的源码重跑。语法和 diff 检查通过 |

外层命令分别为 `node .local/t7c4-synthetic-20261024/run-combination.mjs grounded skip-typecheck` 和 `node .local/t7c4-synthetic-20261024/run-combination.mjs missing-evidence`，使用现有本地镜像及专有卷。内层沿原 `verify-full-host.mjs N --host-overlay O --full-host-conversations --restoration-scenario --restoration-real-container --skill-root SKILLS` 追加 `--c4-synthetic-case grounded` 或 `missing-evidence`；两组网络均关闭。每组包含原恢复后的首次执行与新 OS 进程查回；运行后本轮容器均已退出并移除，测试卷保留复核。

Native 增量运行 `node --test`，逐一指定 `integrations/native/` 下的 `real-container-c4.test.mjs`、`verification-options.test.mjs`、`full-host-local-spawn.test.mjs`、`full-host-local-residue.test.mjs`；另设置原 N/O 环境后指定 `full-host-conversation-projection.test.mjs`、`full-host-pi-abort.test.mjs`。公共命令为 `node node_modules/vitest/vitest.mjs run`，指定 `tests/role-eval/` 下的 `training-generation.test.ts`、`training-cancel.test.ts`、`training-output.test.ts`、`wecom-bot-tasks.test.ts`、`wecom-bot-conversation-results.test.ts --no-file-parallelism`；培训新增后单独重跑该文件。初次投影专项因缺 N/O 环境变量未执行到目标测试，补齐后7/7，不将环境错误算作有效行为 RED。

本轮未运行全仓598项及全量构建；未改生产服务或依赖，按用户要求仅运行相关增量和必要组合。仓库没有 lint 脚本。上述草稿与培训生成均为合成响应，真实企微认证、发送、模型和生产均未启用。

### 开始真实企微联调仍需满足的条件

| 条件 | 当前状态与下一步 |
| --- | --- |
| 受控真实渠道启动入口 | 本页当前增量已将手工接线集中为可复用 pilot 装配；assembly、preparation、SDK 和 Native 适配仍限定 `isolated-synthetic`。真实客户端生命周期和可信配置仍须单独接入、授权及验证，不能删除模式检查或把合成认证当真实认证 |
| 真实成员与授权 | 本轮按要求跳过。联调时指定一个测试成员、一个门店和原已授权岗位，核实成员绑定、真实应用认证、撤权和收件人；不能仅凭拿到 token 认定完成 |
| 实际运行宿主 | 选定试点宿主与原 runner 制品，核实其旧进程/容器写者、持久数据及原恢复证据。当前受控本地 daemon 的 v2 证据不能迁作其他环境的恢复许可 |
| 有限发送与停止方式 | 明确测试数据、允许动作和有限发送范围，保留原未知结果不盲重试规则；出现身份不符、重复执行或越权立即停止新受理与发送，保留持久结果供核对。生产部署另验配置和回退 |
| 自然语言真实生成 | 若首轮只测固定业务或合成回答，可继续关闭外部模型；要验收员工真实自然语言多技能工作，仍须配置获准模型、调用上限/预算、可信资料和人工判定样例，完成有限质量验收 |
| 培训入口 | 若首轮包含培训，还需把原培训服务和对应模型适配装到试点员工入口并验收；当前独立服务测试不能替代这一步 |

满足前四项才进入有限真实企微收发联调；真实自然语言辅助工作还需第五项，培训还需第六项。这里没有宣称只补认证即可上线，也不将这些未执行条件记为通过。

首轮试点应限于已验证的单需求与查回。连续追问和精确取消已有原 Pi 合成传输组合及相关专项证据，但尚未在本轮完整宿主的真实容器组合重验；试点要包含这些动作时，需沿原链补相应组合验证。C1 的更正、汇总、Excel 等历史能力也不因本轮 C4 通过自动变成真实渠道已开放。

## 前轮增量：完整宿主与真实 runner 的同请求闭环

2026-10-24，基线 `20aad7ab4088168ff23fbe896cf44eaae9cba538`。本轮复用 D1–D5、原 main/queue/SQLite、review/restore、Pi SDK 0.84.2 及发送能力，集中补共同运行环境。独立审查修复后的最终版本已通过同轮两进程验证，结果如下。未改生产、发真实消息或调用外部模型。

需求为“请根据已有批准资料，为美容门店写一段项目体验介绍，读取内容营销技能，说明每场限额并给出行动建议。”离线官方企微 SDK 接受合成可信成员消息，原授权和岗位选择进入原空间；原 runContainerAgent 用真实 stdin/stdout 启动 Docker，保留原 entrypoint、Chromium、降权、Pi main 和 SDK。真实 read 读取批准资料和技能，原宿主 Memory IPC 实际响应；仅 ModelRuntime 的响应事件为确定性替身，不证明真实模型语义或自主选技能效果。

必要改动仅作用于显式本地模式：

- `--restoration-real-container` 使用受控 Desktop daemon 和全新专有卷，严格翻译原挂载前缀；宿主 UID/GID1000、capabilities0、附加组0仅连接控制 socket。短命初始化容器仅用 CHOWN 设置新卷属主，退出后再起宿主。原启动器实际探测 direct1000，runner 不挂 socket。
- 原 PID1 supervisor 保留旧进程写者观察，增加真实旧容器对同库同值 UPDATE/readback，实际停止并移除；独立只读 probe 比较目录、DB、canary 的 dev/ino/内容。原扫描前后实时核对 daemon、宿主、CLI/socket、卷和所有容器挂载；暴露同卷或父目录的其他容器仍拒绝。
- 保留实际 9 个文件和 3 个技能链接。仅在有效 v2、原 completed execution/session/input/D5 完整关联下，识别固定空配置、关闭外部扩展的设置、官方端点 env、onboarding 设置、已完成的单链只读 Pi 历史和原精确链接。内容未知、凭证/MCP/hooks、未完成工具、错结果及越界链接仍阻塞，不使用任意 hash 或路径白名单。
- 复用原时间/条目/字节预算；固定 descriptor、O_NOFOLLOW、属主/权限及前后 stat，原有界遍历拒绝重复 session 文件。默认 v1 的私有 tmpfs、无控制 socket及原拒绝规则保留。未新增 Agent 循环、业务库、公开 API、依赖或通用恢复框架。

本地 v2 信任本次 daemon 管理权受控，不声称抵御其他管理员在检查间隙挂卷，也不是生产恢复证明。有限会话协议不代表任意生产会话均已支持。

| 验收 | 实际结果 |
| --- | --- |
| 原恢复 | 非空旧库保留 task、排队/运行/完成对话及未知回复；经原管理员 review、保留待核对、restore/COMMIT/drain；员工无全局恢复权，管理员无员工内容读取权 |
| 同一需求 | 原队列启动 1 个真实 runner，实际读取、canonical message、D3 完成、D5 冻结答案和离线员工通知对应同一受理号；新查询返回同一完整答案 |
| 第二进程 | 原进程退出后，另一 PID 恢复同库并查回；runner0、主动补发0，不重新 seed，不改旧未知记录；不称重启后 SDK 续聊 |
| 最终版本 | outer `091e1686-8b50-4061-b4b8-a7cc60341637`，verifier `2026-10-24T10-42-38-488Z-de3cc9d3-3a59-4736-9fc7-05bba1eb4aa7`，总状态passed；boot PID315，restart PID2157，两阶段status0/receipt v2；runner ID `1113db350d8c68b63892f0126bf9971bacb48ef2ef7468060003ea18259b6cb2` |
| 回归 | 公共598、类型/构建通过；接点专项20 pass/1 Linux专用skip，封存专项12 pass/1 Linux驱动环境skip，原分类器17/17；原v1同库两进程恢复回归passed（PID83/127），run `2026-10-24T10-46-50-101Z-bf3563b4-9be3-4dee-864b-d7b0dd46420f`，旧模式未挂Docker控制socket；无lint脚本 |
| 审查修复 | 原目录根挂载遗漏与新增目录扫描预算问题均经有效反例修复；最终规格/质量结论绑定独立审查记录的确切暂存树，不能用旧版本意见替代 |

命令为 `verify-full-host.mjs N --host-overlay O --full-host-conversations --restoration-scenario --restoration-real-container --skill-root SKILLS --typecheck`。由 Linux PID1 执行，`QIWE_LOCAL_DOCKER_{RUN_ID,VOLUME,HOST,IMAGE,DRIVER_IMAGE}` 必须对应本轮真实对象。CLI和socket固定 `/qiwe-control/docker`、`unix:///qiwe-control/docker.sock`，构建记录只读挂 `/qiwe-control/build-input.json`，`/input`只读，`/tmp`专有卷，网络关闭、只读rootfs、cap-drop ALL、no-new-privileges。单设变量不能签发许可，receipt来自真实观察。

证据根 `.local/t7a-fullhost-container-20261024/`：实际命令、封存源码、两进程audit及supervisorReceipt、容器/挂载/输出和来源hash。`final-manifest.json`将21个Native变更文件与本轮封存输入逐一比较，provider、fixture、挂载准入和collector哈希均与实际audit相符。原shell实际编译入口哈希为 `cbb7aa99e42bc8a20e553d3c4d3d9caf65e5f0bf839313a02d00145652db7b43`；所有本轮标记容器确认不存在，测试卷保留复核。前三轮失败分别是测试keepalive重置、UID0/cap0与node1000权限不匹配、真实会话残留被原门禁阻断。第四轮通过但含随后修复的目录预算问题，只作中间证据，最终采用上述第五轮。模型与企微网络均为离线合成。日志中SQLite experimental及缺少静态Web构建提示属于既有测试环境限制，本轮未验收Web页面。

下一步复用该组合补T7-B未覆盖业务/异常与C1回归，再准备C3有限真实企微和C4有限模型验收；生产恢复、手机实收和部署仍需对应事实、授权及验收。

## 前轮增量：恢复后的连续追问、取消与原 Pi 技能

2026-10-24，基线 `a119e93`。恢复后的同一完整宿主已通过本地隔离组合验证：原 Pi 连续追问、排队及活动执行的精确取消、多技能与工具调用、完整答案回复，以及新进程恢复后查回。复用 D1–D5 和原 main/queue/SQLite/review/restore；模型 I/O 使用确定性合成数据，容器传输接点使用替身。真实企微和模型效果尚未验收；本节恢复场景未使用真实容器传输。

本轮没有重做身份、岗位、账本、会话、发送服务或 Agent 循环，没有新增依赖、数据库表、公开 API 或生产开关。原 Pi SDK 0.84.2、原 runTurn、技能解析与本地工具实际执行；官方企微 SDK 通过离线回调接入。模型事件是合成数据，不能据此认定真实生成质量或手机实收。

### 可观察的闭环

- 员工在已授权岗位提出需求，执行中继续追问；原队列先完成首答，再处理追问。两次答案分别关联自己的受理号、query、turn 和原持久消息。追问能看到前次答案，未知旧任务文字不混入上下文。此合成旧记录触发原历史策略重建 SDK session，未绕过原规则强行复用 session。
- 原岗位继承三个已安装技能：beauty-local-content、vendor-content-strategy、vendor-copywriting；原工具实际完成四次 read 及一次 mcp__miniclaw__get_channel_context。保存草稿含两项技能方法引用、批准资料来源以及未发布状态。合成 provider 决定工具调用序列，本项证明装配和执行链，不证明模型自主选技能质量。
- 排队取消不执行；活动取消先显示取消处理中，实际 SDK abort 完成后才成为已取消。重复取消旧任务和迟到旧输出都不影响后继需求，不产生取消任务的答案或完成通知。
- 第一进程实际启动四轮 runner（首答、追问、取消中的执行、后继），保存三份答案并产生三条离线完成通知。主动查询返回对应完整内容；重放同一查询保留原回复，新查询读取最新状态。
- 第二个 OS 进程恢复同一数据库，五条受理的状态及结果逐项一致；runner 0 次、主动补发 0 次，取消记录可查回，旧保留记录未被重写。两轮均经过原 review/restore/COMMIT/drain，没有注入 safe/ready。

### 五处必要接线修复

1. 原队列 _drain 表示答完后退出；Pi 活动 shouldClose 只处理 _close，_drain 留给原空闲循环，避免首答提前结束。
2. 原 queryIdle 会先清理或切换队列编号；D3 固定受理批次开始时的 query，再沿原输入/turn/持久消息关系投影。
3. 仅在原 session.abort 成功后发布中断事件，由原 writeOutput 绑定当前输入；不预填旧 container turn，pending/失败不伪报取消成功。
4. runner 已结束就拒绝其迟到 callback，围栏先于等待 D5 通知；运行中的合法 warm 输出继续走原路由。
5. 恢复扫描只认可关系完整的 cancelled 记录。排队记录须无执行关系及矛盾输出；活动记录须完整匹配原 batch，残留 D5/未知/缺失关系继续阻塞。此判定只允许不重放恢复，不代表取消前未发生工具副作用。

运行变更只作用于显式 fullhost 候选，Pi 修补要求 restoration-pi-scenario。旧 default、D2、D3–D5 各 208 个组合模块与基线逐个内容一致；原 D4 仍使用原准备路径。回退可停用候选选项；原 schema 73 的既有保留语义不能用不兼容旧版回退。

### 最终验证（2026-10-24）

证据根目录：.local/t7a-conversation-20261023/。N/O 路径及来源哈希沿用下文；原源码和技能只读。命令在本仓库运行；Linux 通过固定本地镜像、--network=none、只读输入/rootfs 和独立临时写入目录执行。

| 检查 | 实际结果 |
| --- | --- |
| 公共回归 | npm test -- --maxWorkers=1：43 文件、598 测试通过；npm run typecheck、npm run build exit 0；10/23 执行后公共源码未变，无 lint 脚本 |
| 输出/取消专项 | node --test integrations/native/full-host-conversation-projection.test.mjs integrations/native/full-host-pi-abort.test.mjs：7/7；执行实际生成接点片段，非数据库集成 |
| 恢复判定专项 | node --experimental-strip-types --test integrations/native/full-host-restoration-classifier.test.mts：17/17 |
| Windows 完整宿主门禁 | verify-full-host.mjs N --host-overlay O --sqlite-driver PREPARED_DRIVER --full-host-conversations --typecheck：原类型、环境 1、岗位 3 通过，boot/restart 各 25 pass、8 平台 skip；PID 29664/16740 |
| Linux 完整宿主门禁 | 同一 full-host 命令（省略 Windows driver）：原类型、环境 1、岗位 3 通过，boot/restart 各 32 pass、1 平台 skip；PID 110/248 |
| Linux 原 Pi 正向闭环 | full-host 命令加 --restoration-scenario --restoration-pi-scenario --skill-root SKILLS：原宿主和 Pi runner 类型、seed、boot、restart 全通过；PID 90/134，行为见上文 |
| 既有 D4 回归 | verify-role-capabilities.mjs N O --skill-root SKILLS：原宿主/runner 类型检查与 5 项测试通过 |

Pi runId：2026-10-24T07-28-29-499Z-6ebfc279-36ff-47fb-bf2d-b715741dc6f1；Windows：2026-10-24T07-18-40-616Z-18e2ecee-20bc-4652-b499-b5c7aa4ba2fb；Linux 门禁：2026-10-24T07-20-27-664Z-076feb98-9f6d-4c47-b0a2-49ffa0dab683。三个运行组合摘要均为 dc2be902b4b2a060cb2066275b5a518afaea3fd7b568fff0fa2e976e963ac8e4。final-manifest.json 将运行来源、冻结代码及日志哈希对应，避免用旧测试覆盖新版本。

有效失败记录包括提前 drain、query 投影丢失、abort 后 unknown、迟到输出写入、取消记录阻塞重启。独立审查发现 warm 中断归因和排队取消矛盾输出两项问题，均先补反例再修复；7/7 与17/17覆盖这些反例。第一次 fixture 的 IPC/tasks ENOTDIR、旧查询复用消息 ID 的断言错误不是产品失败。pi-final-9 在并行验证时因120秒超时失败，保留原日志；冻结代码和原超时不变，串行 pi-final-10 通过，不将超时轮计成功，也未据此承诺性能。独立审查报告位于 independent-review.md 与 final-independent-review.md。

### 尚未证明的边界和下一步

本节历史场景的容器传输为替身；原启动器、shell、Chromium和身份链后来独立通过。同宿主共享环境由本页当前v2增量另验；前轮追问/取消多轮尚未在该真实Docker同宿主场景重验。静态Web、真实企微、模型效果和生产部署仍未验收，不把本地证明作为生产恢复许可。

## 前轮恢复改造（本地正向闭环已验证）

2026-10-23，基线 `f3ff566`，分支 `feat/wecom-host-resume`。本节保留前轮证据；当前增量以上节为准。

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
