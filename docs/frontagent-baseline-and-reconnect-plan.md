# Frontagent Claw 基线与最小重接计划

2026-10-25。目标：沿用原 Frontagent Claw、已有管理员和原数据，将 D1–D5 接回产品；员工在企微提出需求、追问、取消、收到答案并查回。本文取代“新空库 setup → 新建管理员 → 导入员工”的步骤。

架构仍是原 Web/业务服务、原 Native main/队列/Pi、原 SQLite，以及现有企微适配；技术栈和依赖不变。本轮只核实和编制计划，未实施下述重接、数据迁移或服务启动，不动生产、不调用模型、不发送真实消息。

## 1. 锁定的输入与不能混用的环境

| 对象 | 锁定来源 | 本轮证据及边界 |
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

**锁定的是正确源码、制品和原数据来源；“最新版 Web + 原数据 + D1–D5 + 完整宿主”这一组合尚未启动验收。** 原本地构建脚本有初始化、保存设置及岗位安装行为，启动脚本会登录并写会话；本轮均未运行。不要通过执行旧 build/launcher 来做只读核实。

## 2. 实际缺口

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

以下是后续实施计划，本轮不执行。每步只跑受影响测试；不追加通用迁移器、诊断平台、权限框架或新 Agent。

| 步骤 | 具体接点与最小工作 | 完成条件 | 预计投入 |
| --- | --- | --- | --- |
| R1 原产品启动装配 | 本仓 `integrations/native/local-pilot-host.mjs`、`full-host-candidate.mjs`；复用原产品 Web overlay/业务挂载。只用原状态的一致性隔离副本，显式传入其路径和原完整服务目录；隔离外网，先暂停启动，不运行 setup/provision/岗位安装。 | 旧管理员通过原登录流程；原七岗、工作间及已有账本/草稿可读；原始文件不变，副本没有新增账号/岗位；缺失状态时明确失败，不能退回新空库。 | 0.5–1 人日 |
| R2 原身份与既有岗位重接 | 先核清指定员工现有状态来源；复用 `workbench-opening.ts`、`native-workbench-port.ts` 和真实身份 reader。`role-workspace-overlay.mjs` 如需增量，只接受已核验 owner/store/grant 与精确 Profile/workspace 的绑定，沿用现有事务和版本约束。 | 选择现有岗位不创建用户/Profile/空间；跨店、撤权、错误 owner 拒绝；重复绑定不产生第二份资源。员工状态来源未齐时，该项保持未完成，不以管理员/合成账号顶替。 | 0.5–1 人日，等待可信来源时间另计 |
| R3 同宿主闭环验收 | 复用 `createControlledRealWecomBotPilot`、原 full-host 执行绑定和 D5；先做原 schema 在副本上的增量兼容验证，再经原 T7 review/restore 恢复。沿用现有真实容器测试 harness，模型/企微网络使用合成 I/O。 | 同一自然语言请求执行、保存、离线回复、重启查回；新增账号/岗位为零。仅在启动装配影响 session/取消时补追问和精确取消组合；旧任务和未知回复仍保留待核对。 | 1–2 人日，取决于原记录实际恢复阻塞 |

预估合计 2–4 人日是这次装配修正，不是重新开发 D1–D5，也不是承诺真实上线日期。R1 如发现必须修改业务语义或数据布局，先列具体差异再重估，不把重构混入启动修正。R2 缺可信员工状态、R3 缺原恢复事实时直接列出所缺材料；不靠追加局部证明拖延产品验收。

侵入度：本轮仅文档和只读审计；后续 R1 主要影响启动/路径，R2 涉及身份与绑定，R3 涉及原库增量表及恢复，后两项风险中等。所有写入先限制在一致性副本，回退为停止该候选并重新使用未修改的原制品/原数据，保留候选证据，不在原数据上做破坏性回滚。真实渠道/模型联调须在上述组合通过后按原指定成员授权执行；生产部署不在本计划内。

## 5. 本轮验证

环境：本地 Windows，Node v24.18.0；原仓源码 `b4dffb6`，本仓代码 `f476ddb`。没有运行产品服务或容器，没有 schema 写入/新建账号。

| 检查 | 实际命令/方法 | 结果 |
| --- | --- | --- |
| 原源码和制品 | fetch/版本/祖先核对；manifest 登记文件 SHA256；private zip/bundle SHA256 | 213/213 制品、29/29 来源一致；备份哈希与原清单一致。这不是恢复演练。 |
| 原管理员/数据 | 忽略目录 `audit.mts`：Node DatabaseSync(readOnly)、query_only、原 bcrypt；DB/WAL/SHM/账本前后哈希 | 密码配置匹配、quick_check=ok、原数据未变；未输出密码或聊天正文。 |
| 固定 Native 兼容 | 同一审计脚本调用 createFullHostCandidate，仅组合源码 | 216 文件组合通过；没有执行主循环。 |
| 原授权相关 | 原仓运行 `E:/node.exe node_modules/vitest/vitest.mjs run tests/role-eval/workbench-access.test.ts tests/role-eval/native-workbench-port.test.ts tests/role-eval/workbench-opening.test.ts` | 3 文件、13 用例通过。测试隔离数据不等于原产品实测。 |
| 企微选择/结果/绑定 | 本仓运行 `E:/node.exe node_modules/vitest/vitest.mjs run tests/role-eval/wecom-bot-conversations.test.ts tests/role-eval/wecom-bot-conversation-results.test.ts tests/role-eval/wecom-bot-real-bind.test.ts` | 3 文件、26 用例通过。 |

审计脚本初次因把原 Web index 路径误写为 web/dist/index.html 而失败；按实际文件改为 web/index.html 后重跑通过，没有将失败算作业务失败或通过。文档 diff/链接检查及独立审查随本轮交付记录保存。无运行代码改动，因此不重复全量测试、typecheck、lint 或构建；没有声称真实员工可用或 GitHub CI 通过。
