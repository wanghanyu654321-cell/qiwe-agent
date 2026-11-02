# Frontagent Claw 基线与最小重接计划

2026-10-31 当前交接与本轮验证见[完整工程交接](handoff-20261031/README.md)。原 R3 离线组合回归通过；G1 真实启动为 WIP，真实环境文件、真实 Pi 多回合残留判定及跨进程查询预算仍待补齐。

2026-10-25 制订，2026-10-30 更新。目标：沿用原 Frontagent Claw、已有管理员和原数据，将 D1–D5 接回产品；员工在企微提出需求、追问、取消、收到答案并查回。本文取代“新空库 setup → 新建管理员 → 导入员工”的步骤。

架构仍是原 Web/业务服务、原 Native main/队列/Pi、原 SQLite，以及现有企微适配；技术栈和依赖不变。R1/R2 已交付原产品、原员工状态、本地单岗位授权和映射。2026-10-30 R3 已通过原门禁恢复、原岗位实际接纳、三技能执行、离线回复及独立进程重启查回的本地隔离验收，详见第 8 节；真实模型、手机实收及 G1 其余条件仍待验。本轮不动生产、不调用模型、不发送真实消息。

## 1. 锁定的输入与不能混用的环境

| 对象 | 锁定来源 | 基线锁定时的证据及边界 |
| --- | --- | --- |
| 原产品当前源码 | 相邻 `claw-agent-mem0-p0`，`deploy/free-hr-20261017`，`b4dffb6b8ddd853b595430e9607c16bd25035d3d` | fetch 后与同名 origin 分支一致；origin/main 为 `54fcf08`，不能用 main 名称代替当前部署代码。原仓两项未提交文档改动保留，未纳入本次修改。 |
| 原功能锚点 | `941e9c623ea9f5db971b24c0d5961bc62c809a74`，tag `anchor/pre-showcase-20261016-941e9c6` | tag 解引用指向该提交，且为当前源码祖先。`src`、原本地构建/统一云服务脚本及 UI overlay 的指定路径与锚点无差异；不是声称整个仓库无差异。 |
| 最新产品 Web/部署制品 | 原仓 `deploy/railway/package` | 213 个制品文件、29 个登记来源文件哈希全部匹配；HTML 标题为 Frontagent Claw。manifest SHA256：`b0e02d8aec7144e3dfcc63123534804de34142a0c82a1ea8963aadd15a727204`。这份包未导入原状态，gateway 固定 HR 合成门店；不能直接当 B 店运行库。 |
| 已有本地管理员与数据 | 原仓 `.local/local-product-20261013-r1` | `runtime/data/db/messages.db` 只读打开，quick_check=ok；1 个启用管理员，保存账号配置经原 bcrypt 校验匹配，不要求改密。1 个 Home、7 个非 Home 岗位空间均关联该管理员的启用 Profile，共 8 个 Profile/8 个空间。 |
| 原本地实际 Web 服务制品 | 同目录 `runtime/server.mjs`、`runtime/web/index.html` | 标题为 Frontagent Claw；server SHA256 `f3ee751bb1a51cd64e40ceaaa50e688ea96d38694c3dad386d8ba3129578a286`，index SHA256 `b93d1f3f4b5447c518b03d8ccc8a6de4531214eabe6b1e0b1ce302709896d624`。与最新部署包分别登记，未宣称两者已组成可启动新版本。 |
| 原私有恢复锚点 | 原仓 `.local/anchors/pre-showcase-20261016-941e9c6` | 本轮重算 source bundle 与 `local-product-private.zip` 哈希，分别匹配原清单 `e587db69…de3a6e`、`e435aa86…bd0c47`；未解压、恢复或上传。带 incomplete 的旧 zip 不可用。 |
| D1–D5/企微适配 | 本仓 `f476ddbcd7f6e5a6d1bde1c549100a237acaee11` | 保留已有实现和验收，不回滚或重做。该 SHA 是本轮文档修改前的代码基线。 |
| Native 固定来源 | `integrations/native/full-host-candidate.mjs` 的原 N/O | N tree `86115193…b0bad`，O tree `054aff69…f5e11e0`；启用 conversationIntake/fullHostConversationExecution 后 216 个文件纯源码组合成功，未启动 main、迁移原库或执行 Agent。 |

原本地 Native 数据与 `manager/reports.sqlite`（含存在的 WAL/SHM）检查前后哈希未变。管理员密码只在内存比对，不输出、不复制到新库。完整路径、数据哈希及审计结果保存在被 Git 忽略的 `.local/frontagent-baseline-20261025/baseline-lock.private.json`，不提交私有数据库、账号配置、会话或私有备份。

**R1 采用与原本地数据匹配的 `runtime/web`，已启动原完整 main；最新 HR Web 仅保留来源校验，未搬入运行。** HR 页面要求另一套授权准备，直接搭配原本地账号会卡住，不能以制品较新替代兼容核实。原本地构建脚本有初始化、保存设置及岗位安装行为，未运行；只有隔离副本上的原登录和原 Native 增量初始化获准执行。不要对原数据运行旧 build/launcher。

## 2. 实施前调查的缺口（2026-10-25）

本节保留基线核实时的发现，不再作为当前待办。原员工来源和隔离副本恢复已经补齐；当前进度及剩余接线以第 7、8 节为准。

1. **产品装配错位。** 被停止的空白试点使用旧基座 Web 与空数据。原本地 server 是 Web/数据库/业务组合，并不自动等于已经装入同一个完整 main/queue；最新 HR launcher 还包含 provision 和技能复制。需要重用正确产品 Web/业务入口，并接到已验证的完整宿主，禁止默认初始化。
2. **本地身份来源未齐。** 已锁定的本地 Native 库只有管理员，没有指定 B 店员工。此前远端核实的员工不能据此视为本地已有；本轮未访问生产。统一工作台包内的 seed、开通验收目录的 native-contract.sqlite、HR 合成 volume 均不能充当真实员工账号。下一步先定位原员工的可信现有数据来源；没有来源时明确阻塞该员工真实接入，不新建同名账号、不把管理员当员工。
3. **原岗位存在，企微绑定尚不存在。** 本地 `router_state` 中 `wecom-role-%` 记录为 0，且无 `wecom_%`/`workbench_%` 表。D1 不能仅按岗位名称把旧空间划给 B 店；D2–D5 的持久表还需在隔离副本上经原增量初始化路径核实。授权库是单独的 `access.sqlite`，上述表检查不证明所有其他目录都没有授权。
4. **数据路径不是同一种布局。** 原本地账本、草稿、培训和记忆位于原 job 目录；较新的 opened-workbench 按 tenant/store/account 分目录。不能换一个 directory 后出现空账本，就宣称已沿用原数据。先用已有业务服务指向原目录；需要改变作用域或迁移时单列明确差异，本计划不默认搬迁/合并账本。

本地管理员存在和七岗关联只证明原管理员的资源完整，不能证明指定员工已有授权，也不能证明七岗模型效果或真实企微闭环通过。

## 3. D1–D5 复用表

| 阶段 | 直接保留 | 必须重接/核实 |
| --- | --- | --- |
| D1 岗位和会话选择 | `wecom-bot-conversations.ts` 的选择/持久状态；原 `WorkbenchAccessStore`、开通服务和本人空间检查 | 原真实身份/门店/授权 → 已有 Profile 与空间的精确对应。缺少 D1 claim 时，仅补可信既有资源绑定；不能调用 prepare 去复制七岗。 |
| D2 自然语言受理 | 原消息保存、受理编号、重复消息处理和 receipt 事务 | `conversation-overlay.mjs` 接到同一个原 Native DB/当前 actor；在副本核实原增量 schema，保留旧消息和旧业务表。 |
| D3 执行、追问、取消 | 原 main、GroupQueue、session 与精确执行关联；已验证的 full-host 执行组合 | 产品启动入口装入同一个 main/queue/gate，不能仅启动 Web server 或另起执行循环。需要在原数据副本重新取得其恢复事实。 |
| D4 岗位、多技能和工具 | 原 Profile、已有技能、原 container runner/shell/Pi；现有错误边界修补 | 原空间、技能、文件和配置挂载对应实际 owner；复用真实 runner，合成模型 I/O 仅用于测试，不装成正式 provider。 |
| D5 完整答案、恢复和查回 | 原冻结结果、ManagerStore 回复意图、attempting/unknown、发送和查询逻辑 | 同一宿主完成回调 → 同一结果存储 → 当前身份核验 → 现有发送器。本轮发送器离线；通知失败不能重跑 Agent，重启查询读原答案。 |

`workbench-access.ts`、`install.ts`、`file-journal.ts` 原仓与本仓字节一致；这是可复用证据，不代表应该重新运行安装。原 `deploy/railway/gateway.mts` 确有 `createOpenedWorkbench` 的真实调用方，授权能力不是只有测试；其中 HR tenant/store 和写入型 `native.skills` 包装不适用于原 B 店资料核实。

## 4. 最小修正顺序

以下按依赖实施，每步只跑受影响测试；不追加通用迁移器、诊断平台、权限框架或新 Agent。

| 步骤 | 具体接点与最小工作 | 完成条件 | 预计投入 |
| --- | --- | --- | --- |
| R1 原产品启动装配 | 本仓 `integrations/native/local-pilot-host.mjs`、`full-host-candidate.mjs`；复用原产品 Web overlay/业务挂载。只用原状态的一致性隔离副本，显式传入其路径和原完整服务目录；隔离外网，先暂停启动，不运行 setup/provision/岗位安装。 | 旧管理员通过原登录流程；原七岗、工作间及已有账本/草稿可读；原始文件不变，副本没有新增账号/岗位；缺失状态时明确失败，不能退回新空库。 | 0.5–1 人日 |
| R2 原身份与既有岗位重接 | 先核清指定员工现有状态来源；复用 `workbench-opening.ts`、`native-workbench-port.ts` 和真实身份 reader。`role-workspace-overlay.mjs` 如需增量，只接受已核验 owner/store/grant 与精确 Profile/workspace 的绑定，沿用现有事务和版本约束。 | 选择现有岗位不创建用户/Profile/空间；跨店、撤权、错误 owner 拒绝；重复绑定不产生第二份资源。员工状态来源未齐时，该项保持未完成，不以管理员/合成账号顶替。 | 0.5–1 人日，等待可信来源时间另计 |
| R3 同宿主闭环验收 | 复用 `createControlledRealWecomBotPilot`、原 full-host 执行绑定和 D5；先做原 schema 在副本上的增量兼容验证，再经原 T7 review/restore 恢复。沿用现有真实容器测试 harness，模型/企微网络使用合成 I/O。 | 同一自然语言请求执行、保存、离线回复、重启查回；新增账号/岗位为零。仅在启动装配影响 session/取消时补追问和精确取消组合；旧任务和未知回复仍保留待核对。 | 1–2 人日，取决于原记录实际恢复阻塞 |

预估合计 2–4 人日是这次装配修正，不是重新开发 D1–D5，也不是承诺真实上线日期。R1 如发现必须修改业务语义或数据布局，先列具体差异再重估，不把重构混入启动修正。R2 缺可信员工状态、R3 缺原恢复事实时直接列出所缺材料；不靠追加局部证明拖延产品验收。

侵入度：R1 修改本仓本地启动器，新增副本制作和原业务只读接线；不修改原仓业务实现、队列、权限模型或 Pi 循环。R2 涉及身份与绑定，R3 涉及原库增量表及恢复，后两项风险中等。所有写入先限制在一致性副本，回退为停止该候选并重新使用未修改的原制品/原数据，保留候选证据，不在原数据上做破坏性回滚。真实渠道/模型联调须在上述组合通过后按原指定成员授权执行；生产部署不在本计划内。

## 5. 基线核实记录（2026-10-25，实施前）

环境：本地 Windows，Node v24.18.0；原仓源码 `b4dffb6`，本仓代码 `f476ddb`。没有运行产品服务或容器，没有 schema 写入/新建账号。

| 检查 | 实际命令/方法 | 结果 |
| --- | --- | --- |
| 原源码和制品 | fetch/版本/祖先核对；manifest 登记文件 SHA256；private zip/bundle SHA256 | 213/213 制品、29/29 来源一致；备份哈希与原清单一致。这不是恢复演练。 |
| 原管理员/数据 | 忽略目录 `audit.mts`：Node DatabaseSync(readOnly)、query_only、原 bcrypt；DB/WAL/SHM/账本前后哈希 | 密码配置匹配、quick_check=ok、原数据未变；未输出密码或聊天正文。 |
| 固定 Native 兼容 | 同一审计脚本调用 createFullHostCandidate，仅组合源码 | 216 文件组合通过；没有执行主循环。 |
| 原授权相关 | 原仓运行 `E:/node.exe node_modules/vitest/vitest.mjs run tests/role-eval/workbench-access.test.ts tests/role-eval/native-workbench-port.test.ts tests/role-eval/workbench-opening.test.ts` | 3 文件、13 用例通过。测试隔离数据不等于原产品实测。 |
| 企微选择/结果/绑定 | 本仓运行 `E:/node.exe node_modules/vitest/vitest.mjs run tests/role-eval/wecom-bot-conversations.test.ts tests/role-eval/wecom-bot-conversation-results.test.ts tests/role-eval/wecom-bot-real-bind.test.ts` | 3 文件、26 用例通过。 |

审计脚本初次因把原 Web index 路径误写为 web/dist/index.html 而失败；按实际文件改为 web/index.html 后重跑通过，没有将失败算作业务失败或通过。文档 diff/链接检查及独立审查随本轮交付记录保存。无运行代码改动，因此不重复全量测试、typecheck、lint 或构建；没有声称真实员工可用或 GitHub CI 通过。

## 6. R1 实施与交付边界（2026-10-29）

`integrations/native/local-pilot-host.mjs` 现在要求显式提供受控 Native 源码副本、原产品源码和原 job 状态目录。首次启动制作独立副本，之后只重开该副本；缺原库、缺启用管理员或路径指回原目录时拒绝，不能退回空库。副本包含原持久目录和 6 个 SQLite 库；已知两处依赖 junction 不复制，不代表 runner 依赖已经恢复。原账号、岗位和空间均沿用原 ID。

容器使用 `network=none`，不发布端口，不挂原状态目录或 Docker socket，也不注入渠道和模型密钥。执行门禁保持 `paused`，只补原管理员登录、原岗位/空间及四项产品 GET 读取；业务写入与 Agent 执行继续拒绝。浏览器验收使用本次临时、仅监听 `127.0.0.1` 的 Docker exec 转发，不作为产品网络入口发布。

实际原管理员登录已通过；七岗、5 份已有草稿、4 条原报数、11 份培训资料可以读取。四个原页面均显示对应原数据，无 setup 或重新开通要求。账号/Profile/工作间维持 1/8/8，原 Native DB/WAL/SHM 文件哈希未变。原库本身含合成业务资料，以上不代表真实 B 店经营记录或指定员工恢复。

范围限制：预约开放状态、经营知识/历史样例等尚未在本候选装配，页面明确显示无法核实；培训只读取原资料，不开放检索写路由或生成。相关原功能与文件保留，不能把四页可读写成全部 Web 功能或 D1–D5 员工闭环已恢复。

本轮增量命令（仓库根目录，Node 24）：

```powershell
node --test integrations/native/local-pilot-host.test.mjs integrations/native/frontagent-product-state.test.mts integrations/native/frontagent-product-web.test.mts
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --allowImportingTsExtensions integrations/native/frontagent-product-state.ts integrations/native/frontagent-product-web.ts integrations/native/frontagent-product-state.test.mts integrations/native/frontagent-product-web.test.mts
```

结果：39/39 通过；新增 TypeScript 源码和测试严格检查通过。实际容器启动还验证了原业务模块的最小依赖编译与挂载；未重复全量回归、全仓构建或声称 CI 通过。上轮 Windows esbuild 平台不匹配、合法 `memory-extension` 相对依赖未包含等启动失败已定位修正，中间副本保留，未计作通过。

R1 重启查回通过：同一 runId 与运行代码哈希，两个实际主进程 PID 分别为 62666、3784，启动时间不同；草稿、报数、培训资料与七岗配置的持久内容摘要完全一致，第二进程未重写业务 fixture。重启后原管理员登录与上述读取、拒绝场景重新通过，数量仍为 1/8/8。独立审查对六个代码/测试文件给出规格与质量 PASS、39/39 通过；不以该结果代表业务恢复门禁已放行。

脱敏汇总与执行脚本存于 Git 忽略的 `.local/frontagent-baseline-20261025`、`.local/frontagent-product-host-r1-final`；不提交数据库、会话、管理员配置或业务正文。

## 7. R2 原员工恢复与单岗位准备（2026-10-29）

经用户明确授权，从已登录的原测试宿主只读导出指定员工必要状态。原库只做文件读取，SQLite 只打开临时内存文件系统副本；前后核对原 DB/WAL/SHM 与岗位清单哈希一致，B 店 ACL 两次只读结果一致。导出限定 1 个原用户、其 8 个 Profile、8 个工作空间、8 条关联及 8 个提示版本；不导出其他用户、聊天、会话、预约或财务历史。原认证哈希及岗位内容经加密传输，仅保存于本地忽略目录，不写终端明文、报告或 GitHub。

`frontagent-existing-employee.ts` 只在已停止且核实隔离边界的副本上工作：保留原 ID、原字段和版本，在五张原表的同一事务中插入缺失原行；相同原行重复恢复为 no-op，冲突整批拒绝，不调用创建账号、Profile、空间或安装接口。实际恢复后数量为 2 个账号、16 个 Profile、16 个空间；第二次恢复新增 0，原管理员及其他原行内容摘要保持一致。原营销三项技能的文件与原员工现有文件哈希一致，复用已有字节恢复，没有调用安装器。

通过当前已登录的企微后台核对成员精确账号、当前企业与机器人归属；测试机器人与本地配置一致，仍仅个人使用。原管理员通过原 Native 登录后，复用 `createLocalPilotWorkbenchOpening` 正式开通本地 B 店内容营销单岗；重复请求不增版本。新机器人映射是本轮管理员明确建立的本地记录，未冒充旧 PG 自建应用绑定，未自动转换账号大小写。读取器每次读取本地当前绑定、原 Native 身份和现有授权；配置解析验证通过，外店、未开岗位、伪造会话及错误大小写主体拒绝。这不代表实际 SDK 入站认证或远端撤权同步已通过。

`createExistingRoleWorkspaceAdopter` 只接管理员批准的精确 Profile/空间清单，复用当前授权、原门禁票据、同 Native 事务及既有 claim/CAS；重复接纳保留原记录，冲突或旧 pending 不回收。R2 当时原门禁仍暂停，实际 claim 写入为 0；没有为方便选岗替换假 ready。“选原岗位且零创建”的实际组合已由第 8 节 R3 合法恢复后补验，其他六岗仍保留且未新授予使用权限。

增量验证：原行恢复 41/41；既有岗位接纳 40/40；原岗位 Native Linux 回归 6/6，沿用原驱动。相关严格类型检查、编译及独立规格/质量审查通过，未跑全量回归。恢复测试使用 Node test；接纳测试使用 Vitest 的显式单文件配置，不套用仓库默认 `tests/**/*.test.ts`。曾将两种 runner 混用导致命令失败，已分别运行，不把命令错误算作业务 RED 或通过。

## 8. R3 当前必要接点

现有 T7 监督、原 review/ticket/restore、旧任务保留待核对、D1–D5 和真实 runner 继续复用。现有 verifier 默认建立合成种子，没有承接既有原数据的分支；R1 的 Windows bind 启动也不符合现有 T7 的 tmpfs/受控 Docker volume 恢复边界，不能直接复用旧证明或写 ready。

最小路线是停止并保留 R1 副本作为回退锚点，将其已核实状态一次性复制到现有 T7 支持的本地受控 volume，再由单一原完整宿主运行；不放宽监督边界、不新造业务库或并行循环、不建合成账号。只补已有状态/no-seed 启动分支及实际身份的场景接线，原管理员执行真实 review→restore 后才接纳原岗位并验证执行、保存、离线回复与第二进程查回。物理存储搬运必须记录一致性及唯一活动副本，不能宣称仍是原 bind 的同一 inode。

2026-10-30 当前状态：**R3 的指定员工内容营销本地隔离闭环通过**。岗位和记忆的必要恢复适配已接入原扫描器及原 review/ticket/restore；没有写 ready 或替换门禁。原管理员恢复后，指定员工接纳原岗位，使用原完整宿主、队列、原 shell 和 Pi 三技能完成同一需求的执行、保存、离线回复与第二进程查回。真实企微认证、手机实收、真实模型效果和生产部署仍未验收；其他岗位缺少的 7 份原技能定义未补装。

最小适配限定在既有状态的隔离装配和恢复检查：副本关闭插件自动扫描，两份配置收紧为 `0600`，原文件和密钥字节保留。配置继续做描述符、加载值、预算和票据复扫检查；岗位只兼容原规范化配置及明确禁用的 host/MCP，额外上下文需核实不存在，权限和技能可用性仍由原服务检查。原记忆项与版本、存储、审计及事件关系一致时保留；确定原固定源码无自动消费者的 untouched pending 事件保持原样，不标记已发送、不重放。

复用原会话遗留协议，把固定合成空间名改为本次已核实原空间的精确绑定；仍验证 D5、原输入、完整会话链、工具结果、文件内容和权限。只补原 writer 生成的 `official + disabled MCP` 精确环境文本，未知字段或可执行扩展继续拒绝。原启动程序本来会刷新两个 Home 绑定的 `updated_at`：测试核对其余字段完全相同、时间合法且处于启动窗口，再冻结全部字段检查后续业务；未修改原初始化逻辑。

最终组合运行：`2026-10-30T14-28-47-848Z-1bdd8620-4119-47e6-880b-b847293234fa`；外层 `73903555-eb5e-4c4d-b0c1-23536ad55b20`。无 synthetic seed，13,000 个原快照文件核对通过。boot PID `265`：runner 1 次、离线主动回复 1 次；restart PID `2047`：runner 0、主动补发 0，查询返回第一进程原 D5 答案。两轮均为 2 个账号、16 个 Profile、16 个空间，原记忆四表、业务原行和四条原报告保留检查通过；管理员恢复不获得员工私有会话读取权。原四个产品 HTTP 读取及其原资料数量也重新验证。测试容器已清理，隔离卷和原锚点保留。

当前 Docker 引擎缺失旧 runner，使用已核实本地原配方及原锁文件重建；固定上次记录的 Headroom、飞书 CLI 和 shell 工具版本，Pi 保持 `0.84.2`。新镜像为 `sha256:092853e7a053fc50f84b8a6b6f7cabf4f1d52673718be4c3df10672a2f4fc187`，Node/uv/Chromium 的补丁版本变化已记录，不冒充旧镜像。原启动脚本、runner 源码和 SDK 版本再次通过原镜像准入。找到的 Docker 备份及回收站文件没有挂载或恢复。

本轮只跑必要增量：分类器与会话遗留 31/31；原固定 Linux 宿主的配置/岗位上下文 18/18、副本权限 2/2；Windows 状态/边界/Web 57 pass、4 项平台或 opt-in skip，其中权限及实际 Docker 清理另行通过 2/2 和 2/2；离线指定身份 1/1。项目类型检查、构建以及最终完整候选和原 runner 类型检查通过，无 lint 脚本，未跑全量回归。较早的 v1 合成配置票据变更场景也通过；中间岗位、Home 时间戳、会话目录及环境文件失败均保留，不算最终成功。

独立规格与质量审查通过；最终 26 个代码/测试文件指纹与运行证据一致。脱敏证据在本地忽略目录 `.local/frontagent-r3-20261029/runs/73903555-eb5e-4c4d-b0c1-23536ad55b20/business-evidence.safe.json`，对应 flow SHA256 为 `eb369f0a0840563790bfa0c68e871b8995e0d57bc805f69b19397c493847d774`。私有数据、凭据、完整日志和容器卷不提交。

下一步仅将已验证的单员工营销链路装入受控真实连接，验证少量真实模型输出与指定成员手机实收，再按 G1 要求补验原账号的追问/取消。当前答案持久于原会话及 D5，不把合成草稿宣称为真实活动、自动发布或已写入所有原业务台账；不重开通账号、不重装岗位，不扩通用治理或其他岗位范围。生产仍保持不变。
