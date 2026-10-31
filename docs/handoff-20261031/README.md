# Frontagent Claw 完整工程交接（2026-10-31）

本文件是本轮交接入口。目标始终是 **B 店指定员工沿用原内容营销岗位，在企微自然语言提需求、连续追问、精确取消、收到完整答案，并在重启后查回；Web 管理与企微读取同一原持久事实**。不是重新搭建 MiniClaw、报数专用机器人或新管理员。

## 1. 仓库、分支与接手规则

- 当前仓库：https://github.com/wanghanyu654321-cell/qiwe-agent
- 工作分支：`feat/wecom-live-pilot`；现有草稿 PR：https://github.com/wanghanyu654321-cell/qiwe-agent/pull/29
- PR base 为 `feat/wecom-controlled-pilot`，不是 main。交接前已刷新远端。
- 变更前准确 HEAD：`6786f95e8f6579f29eee84f3acc8ba341bb4310c`。本轮提交是可审查 WIP；最终提交号以 PR head 和 Git 为准，不标为真实试点完成，不合并或部署。
- 本轮代码提交：`3d55559`；27 项代码/测试的 Git blob SHA256 见 [code-manifest.json](code-manifest.json)。后续交接文档提交不会改变该代码快照。
- 原产品仓库：https://github.com/wanghanyu654321-cell/claw-agent ，本机 `claw-agent-mem0-p0`，分支 `deploy/free-hr-20261017`，HEAD=`b4dffb6b8ddd853b595430e9607c16bd25035d3d`。两项已有未提交文档 `docs/STATUS.md`、`docs/plans/free-hr-docker-20261018.md` 保留，未纳入本次提交。
- 本仓是渠道/本地集成工程，不含全部原 Native、Linux 依赖、真实数据库、原私有备份或可独立发布的完整产品。

用户已授权少量真实 DeepSeek 调用及仅指定测试员工的真实消息；未授权生产部署、其他成员试点、重建账号或重装岗位。本轮新增开发及验证没有真实模型调用、没有真实业务消息。此前独立模型连通及机器人认证成功是历史专项，不能当成本轮整链验收。

先读 `AGENTS.md`、[最小重接计划](../frontagent-baseline-and-reconnect-plan.md) 第 8 节、[产品 PRD](../frontagent-product-closed-loop-prd.md)、[原 D1–D5 计划](../wecom-native-conversation-plan.md)。部分旧文档仍描述较早的 R1/R2 阻塞；本交接明确更新当前事实，不照旧文档重开 setup。

## 2. 各项任务目标、当前状态、下一步

| 任务 | 已有能力／完成事实 | 当前缺口／下一步 | 代码与原验收入口 |
|---|---|---|---|
| T0–T1 身份与授权 | 原服务端成员绑定、账号/Home 读取、门店岗位授权、撤权校验已有 | 保持原当前身份；云端没有本地私有绑定资料时不得编造员工 | `docs/0-t1-acceptance.md`；`src/role-eval/native-bot-identity.ts`、`workbench-access.ts` |
| T2 报数 | 待核对、本人确认、持久入账、重复投递控制本地通过 | 不重做；没有本轮真实渠道业务验收 | `docs/t2-acceptance.md`、`src/role-eval/wecom-bot-*.ts` |
| T3 回复及恢复 | 业务提交与通知分离，attempting/unknown 不盲重发 | 真实平台 ACK 与手机实收待验 | `docs/t3-acceptance.md`、`wecom-bot-delivery.ts`、`wecom-bot-sender.ts` |
| T4 更正／汇总／Excel | 原更正、汇总版本、实际 XLSX、上传/发送分态已有合成验证 | 不计为本轮内容营销试点或真实文件联调已通过 | `docs/t4-acceptance.md` |
| T5–T6 任务／培训／隔离 | 进度、结果查询、取消、培训及多成员隔离切片已有 | 不扩岗位、群聊或培训实测范围 | `docs/t5-acceptance.md`、`docs/t6-acceptance.md` |
| D1 原岗位会话 | 复用原授权；可接纳原 Profile/空间，禁止新增资源 | 真实收到指定成员事件并选岗待验 | `docs/d1-acceptance.md`；`role-workspace-overlay.mjs` |
| D2 自然语言受理 | 原 SQLite 保存输入及 receipt，去重与查回已有 | 真实 SDK 入站到当前完整宿主待验 | `docs/d2-acceptance.md`；`conversation-overlay.mjs` |
| D3 会话／追问／取消 | 原 main、GroupQueue、session 与精确取消已有隔离组合 | 原账号在真实机器人完成追问与取消待验 | `docs/d3-acceptance.md`；`full-host-conversation-index.fragment` |
| D4 多技能 | 原 Pi 0.84.2、原 shell、三项内容营销技能与挂载已有真实容器离线证据 | 真实模型选技能、工具结果及内容质量待验；其他岗位缺 7 份原技能，禁止补装冒充 | `docs/d4-acceptance.md`；`role-capabilities-runner.mjs` |
| D5 完整答案 | 原 canonical messages → 冻结 D5 → 原通知意图 → 离线 SDK 回复 → 新查询读同一结果通过 | 真实回复/实收/真实会话重启待验 | `docs/d5-acceptance.md`；`wecom-bot-pilot.ts` |
| R1 正确产品基线 | 原 Frontagent Web、已有管理员、岗位及原业务只读接线；没有新账号 | 原锚点保留，不运行旧 setup/build 初始化器 | `local-pilot-host.mjs`；最小计划第 6 节 |
| R2 原员工恢复 | 原测试宿主只读导出；原 ID 恢复于本地副本；B 店营销正式授权与绑定 | 原账号/Profile/空间数量 2/16/16；非服务器自动同步 | `frontagent-existing-employee.ts`；最小计划第 7 节 |
| R3 原状态完整宿主 | 2026-10-30 原快照、原恢复门禁、真实 shell/Pi、三技能、离线回复、第二 OS 进程查回通过 | 不是企微和模型真实业务闭环 | `frontagent-existing-flow.test.mts`；最小计划第 8 节 |
| T7/G1 真实启动装配（本轮 WIP） | 新增显式 v3 本地限时联网恢复范围、原岗位装配、真实容器 transport、模型预算、试点禁重试、关闭未知记录；局部增量通过 | **尚未运行完整受控真实分支，尚未完成最终整体独立审查**；三个阻塞见下文 | `verify-full-host.mjs`、`frontagent-controlled-live-{entry,worker}.mjs` |
| 公网展示／原 CRM | 之前任务要求展示站与业务后台分开，原功能保留 | 本轮未检查公网、未发布、未核实公安备案结果；不能宣称已合规或备案通过 | 原产品仓库/既有展示发布记录；本轮非目标 |

## 3. 当前三个实质阻塞

1. **真实运行生成的环境文件。** 原 `container-runner.ts` 会将模型配置写到隔离副本 `data/env/<folder>/default/main/env`；`full-host-local-residue.mjs` 当前仅认可固定无密钥文本。真实执行后它可能阻塞重启恢复。此快照该文件起初不存在，但还没有实现“真实执行器确认退出后，精确证明是本次新建文件，再安全处置”的流程。不能删除原文件、清空 data 或放宽整个目录。
2. **真实 Pi 会话恢复规则过窄。** `full-host-local-residue.mjs` 的 `settledSession` 要求同 session 恰好一个 D5、一个 user、只含限定 read 工具且至少一次 read。真实直接回答、连续追问、其他合法工具都可能被拦。应先由原 Pi 离线产生实际会话文件，再依据原 completed execution、D5、原输入、query/turn/session 和工具完整结果逐回核对；不按“文件在目录里”判安全，不虚构 schema、不自动重跑未知任务。
3. **最终真实启动与跨进程预算未验。** `verify-full-host.mjs --controlled-real-pilot` 已有接线，但完整分支尚未启动。单 runner 及 8 次模型上限目前只覆盖一个进程；真实重启阶段必须保证只读查询、不能再启动 runner 消耗一套新额度。现有分支只跑一次 live worker，尚无完整的真实重启查回调度。

本轮为这三个问题收集了调用方与源码证据，没有编造已发生的真实运行报错。真实业务试点仍未放行。先完成必要离线组合及整体审查，再按既有授权连接唯一员工。最终收到平台 ACK 后仍须由员工确认手机收到完整答案。

## 4. 本轮改了哪些文件

目录均在 `integrations/native/`，各新增行为有同名 `*.test.mjs`；模型测试另在 `tests/native/controlled-real-model.test.ts`。

| 文件组 | 职责与限制 |
|---|---|
| `full-host-local-docker.{mjs,d.mts}`、`full-host-restoration-boundary.ts`、`full-host-restoration-supervisor.mjs` | 显式 receipt v3；原 PID1/source hash/只读 unlink FD/namespace/inode/旧 writer 退出/卷独占等门禁保留。v1/v2 继续拒绝联网。专属桥无发布端口；**不是操作系统域名白名单**。 |
| `real-container-boundary.mjs`、`controlled-real-container-transport.mjs` | 复用原 Docker 参数和挂载、原 shell/Pi 版本；只准本轮一容器；停止未知继续拒绝，不暴露原始 spawn。 |
| `controlled-real-model.ts`、`controlled-real-preload.mjs` | 固定已配置 DeepSeek endpoint/model、最多 8 次、每次最多 1024 输出 token，最长 30 分钟；不输出密钥。 |
| `controlled-real-pi-retry.mjs` | 仅试点候选的 SettingsManager 实例禁止 Pi 自动重试/provider 重试，不持久改原 settings；真实 Pi 离线重试决策已验证，不等于完整 HTTP 会话实测。 |
| `controlled-real-web.mjs` | 试点候选原 Web 限定 `127.0.0.1`，保留 handler/端口；源锚点改变拒绝。 |
| `frontagent-controlled-pilot.mjs` | 现有账号、Home、岗位/Profile、授权、binding 与批准表，接纳原空间；禁止重建/重装。 |
| `frontagent-pilot-restoration.mjs` | 原管理员认证 → review → 不确定旧任务/消息按原接口保留待核对 → review/ticket/restore；原业务行摘要不变。 |
| `frontagent-controlled-live-worker.mjs` | 先预载候选只读 Docker 观察模块，再安装执行路由，加载同一原 main；恢复后装配真实 SDK；逐项关闭、未知结果记录。 |
| `frontagent-controlled-live-entry.mjs`、`verify-full-host.mjs` | 显式受控入口、私有配置读取、真正试点分支与原候选编译；不删旧离线入口。未知关闭 marker 即使子进程 exit 0 也判失败。 |

真实分支会在 prepare 时连接真实机器人；不可把它当安全的无外发 dry-run。没有凭据或门禁条件时应失败，不能回退假 SDK 或假模型。

## 5. 已执行验证与证据边界

- 本轮最终本地增量：Node test **58/58**；模型限制 Vitest **34/34**；全仓 typecheck 和 build 通过。没有 lint 脚本；没有跑全量 Vitest；没有声称 GitHub CI 通过。完整 stdout/stderr 见 `logs/verification-*.txt`。
- 2026-10-31 原 R3 离线真实容器回归通过：外层 `bfcbc73d-588a-4385-b411-3a86a57aefd5`，内层 `2026-10-31T04-23-39-164Z-8f1d4f28-a6f8-4ce0-b0a1-97b829765157`。外层 exit 0，测试容器清理成功、隔离卷保留。它运行的是当时已封存 stage 的**离线分支**，不是最终 live worker 的完整运行证明；最终 worker 后续修改另有上述局部测试。
- 本机真实 Docker 专属临时桥验证：宿主 loopback HTTP 成功，同桥 peer 连接拒绝；测试资源已按标签清理。Docker 29.8.0 实际默认 Options 含 IPv4=true/IPv6=false，已按实测做定值兼容。
- 原实际 runner 镜像离线验证 Pi `_prepareRetry`：对照组合成 503 进入重试，试点改造后不进入重试。未验证完整 HTTP/provider 失败链。
- 多轮独立审查发现并修复 Web 同桥暴露、Docker 默认选项不匹配、清理短路/未知被隐藏、exit 0 掩盖失败、受限进程函数被恢复检查错误捕获等局部问题；相应局部复审通过。最后一轮**整体启动装配审查因代理额度中断，未完成**；不能写成整体 PASS。
- `run-live-preflight.mts` 仅准备了文件，**未执行**。未连接真实企微、未启动真实模型、未部署生产。

## 6. 报错原文、完整日志、Docker 文件

[日志清单](log-inventory.json) 枚举本地 41 份日志的路径、大小、SHA256；其中 17 份主要构建/宿主运行日志发布逐行脱敏全文，另有本轮验证日志。发布文本统一 LF 并去除行尾空白；密钥、真实账号/空间和私密 payload 行显式标记 REDACTED；**未脱敏原始完整日志只留本机**，不要求用户把它们直接传到公开云端。

| 原错误／失败尝试 | 命令或触发 | 证据／状态 |
|---|---|---|
| `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; ... The system cannot find the file specified.` | `docker --context desktop-linux ps` | 本轮 Docker Desktop 未运行；启动本机 Docker 后 Server=29.8.0，已解决，无构建失败。 |
| `exit code: 100` | 原 Dockerfile 的 apt 安装；仅加 apt retries 的尝试仍失败 | `logs/15-*`、`16-*`、`17-*` 保存完整构建输出；不要靠一遍遍重跑同样的网络安装。 |
| `src/runtime/pi/pi-runtime.ts(161,7): error TS2322: Type ... Model<any> ... is not assignable ...` | 构建中无锁安装漂移 top-level/nested Pi AI 版本 | `logs/13-*`；锁定原依赖、去除重复无锁安装后已重建，不升级 SDK。 |
| `error TS7006: Parameter 'method' ... 'pathname' ... implicitly has an 'any' type.` | 早期 R3 候选编译 | `logs/03-*`；已修，不能通过禁类型检查解决。 |
| `Error: REAL_CONTAINER_UNSAFE_OWNED_MANIFEST` | 早期准入失败后的清理路径 | 同 `logs/03-*`；保留历史失败，不视为当前仍失败。 |
| `Error: EXISTING_ORIGINAL_RESTORE_REVIEW_BLOCKED` | 早期旧状态恢复，配置/岗位/记忆/会话文件未判定 | `logs/02-*`、`05-*`、`06-*`、`08-*`、`10-*`、`11-*`；R3 最终离线解决，真实产物仍有第 3 节阻塞。 |
| `AssertionError: retained original workspace_agent_profiles row ...` | 原 main 启动刷新两个 Home 的 updated_at | `logs/09-*`；核对是原行为后仅接受启动窗口合法时间戳，其余字段继续冻结。 |
| `CONTROLLED_REAL_EXPLICIT_EXISTING_LINUX_HOST_REQUIRED` | Windows 直接运行 verify 的 live flag，条件不全 | 本轮实际拒绝，符合要求；不准绕过 Linux/PID1/原状态要求。 |
| `REAL_CONTAINER_CONTROL_COMMAND` | 本轮独立审查及 Node ESM 测试复现：恢复 helper 捕获受限进程函数 | 先预载原 helper 的最小修复及实际 Node 模块测试通过；不是生产事故日志。 |

Docker 位置（本地绝对路径见下一节）：原固定配方在 `claw-agent-phase-one/.local/full-instance/stage/app/container/Dockerfile`；候选锁定配方 `.local/t7-runner-shell-20261024/Dockerfile.locked-retry`；build context 同目录 `build-context`。当前验证用直接 Docker CLI，**本仓没有本轮使用的 docker-compose.yml**，不要另造 compose 并称原启动方式。

已重建 runner：`qiwe-runner-shell-local:20261030`，本机 image ID=`sha256:092853e7a053fc50f84b8a6b6f7cabf4f1d52673718be4c3df10672a2f4fc187`；宿主 image ID=`sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`。本机 image ID 不是公共 registry 可拉取地址。原 shell/源文件准入核验，Pi/顶层与嵌套 Pi AI 均 0.84.2；原 SQLite 12.11.1、Linux x64 ABI127。

实际成功构建命令（只作为复现记录，需要原 context）：

```powershell
docker --context desktop-linux build --pull=false --progress=plain --build-arg AGENT_BROWSER_VERSION=0.33.1 --build-arg TOOL_REFRESH=qiwe-local-shell-20261024 --build-arg HEADROOM_VERSION=0.41.0 --build-arg FEISHU_CLI_VERSION=v1.43.0 --build-arg OH_MY_ZSH_REF=2100c630ba4bd67bb48802c3e7da893a4fdaa1a0 -f ".local/t7-runner-shell-20261024/Dockerfile.locked-retry" -t qiwe-runner-shell-local:20261030 ".local/t7-runner-shell-20261024/build-context"
```

## 7. 本地文件夹与私有资产

| 用途 | Windows 绝对路径 |
|---|---|
| 当前仓库／本交接 | `D:\Desktop\agent付费资料\qiwe-agent`；`docs\handoff-20261031\README.md` |
| 原 Frontagent 产品源码 | `D:\Desktop\agent付费资料\claw-agent-mem0-p0` |
| 原本地产品／已有管理员数据库 | `D:\Desktop\agent付费资料\claw-agent-mem0-p0\.local\local-product-20261013-r1`，Native 库 `runtime\data\db\messages.db`，原账本 `manager\reports.sqlite` |
| 原展示切换前私有锚点 | `D:\Desktop\agent付费资料\claw-agent-mem0-p0\.local\anchors\pre-showcase-20261016-941e9c6` |
| R1/R2 已核实回退副本 | `D:\Desktop\agent付费资料\qiwe-agent\.local\frontagent-product-host-r1-final`；`code`、`state`、`host.json`，不可当空库重建 |
| 原 Native N 源码 | `D:\Desktop\agent付费资料\claw-agent-phase-one\.local\full-instance\stage\app\src`；tree=`8611519397c78b1f5d9591ae18ea2c5d1c399aab3d63b9ea5311ebd8c18b0bad` |
| 原 O 增量源码 | `D:\Desktop\agent付费资料\claw-agent-phase-one\.local\core-fix\appointment-identity-candidate\src`；tree=`054aff69be686477c6df8acf8f84810d43aba538a3643fcca2a2f32d1f5e11e0` |
| 本地 R3 工具／sealed stage | `D:\Desktop\agent付费资料\qiwe-agent\.local\frontagent-r3-20261029`；`input` 是 Linux 依赖与源码副本，不能在正在运行验证时改写 |
| 原状态引导材料（私密） | 上述目录的 `bootstrap-input.private.json`（含原管理员会话）、`build-input-linux.json`；不得公开上传 |
| 最新离线原始完整日志 | `D:\Desktop\agent付费资料\qiwe-agent\.local\frontagent-r3-20261029\runs\bfcbc73d-588a-4385-b411-3a86a57aefd5`：`run.log`、`bootstrap.log`、`outer-audit.json`、`qiwe-full-host-evidence` |
| 上轮已验收 R3 证据 | 同 `runs\73903555-eb5e-4c4d-b0c1-23536ad55b20`；`business-evidence.safe.json` |
| 原 runner 配方／失败日志 | `D:\Desktop\agent付费资料\qiwe-agent\.local\t7-runner-shell-20261024`；`Dockerfile.locked-retry`、`build-context`、`build-*.log` |
| 最新重建收据／构建日志 | `D:\Desktop\agent付费资料\qiwe-agent\.local\frontagent-r3-20261029\rebuilt-runner`：`build-receipt.json`、`build.log` |
| 企微凭据 | `D:\Desktop\agent付费资料\qiwe-agent\.local\live-channel\.env` |
| 模型凭据 | `D:\Desktop\agent付费资料\qiwe-agent\.local\live-model\.env` |
| 本轮交接采集脚本（私有） | `D:\Desktop\agent付费资料\qiwe-agent\.local\handoff-20261031\collect.mjs`；读取私有值只用于脱敏，不输出原值 |
| 之前指定的 Docker 备份 | `D:\DockerRecovery-backup-20261004`；本轮未挂载／恢复，不当作已恢复镜像证据 |
| PI coding skill | `D:\Desktop\agent付费资料\skills\pi-coding-agent-skill2\pi-coding-agent\SKILL.md` |
| MiniClaw skill | `D:\Desktop\agent付费资料\miniclaw和craftagent\MiniClaw项目及其skill\skill\SKILL.md`；沿用源码证据与实际完成范围方法，不切换为简历任务 |

最新离线隔离卷 `qiwe-frontagent-existing-bfcbc73d-588a-4385-b411-3a86a57aefd5` 保留在 Docker Desktop Linux VM；不是 Windows 普通目录。不执行 volume prune。Docker Desktop 本轮由代理启动，未停止其他项目的 Supabase 容器。

## 8. 怎样运行、测试以及云端还缺什么

### 8.1 云端能直接跑的代码验证

Node 24 + npm；本机 Node=`E:\node.exe`、npm=`E:\npm.cmd`，PowerShell。在全新云端 checkout：

```sh
git clone --branch feat/wecom-live-pilot https://github.com/wanghanyu654321-cell/qiwe-agent.git
cd qiwe-agent
npm ci
node docs/handoff-20261031/verify.mjs
```

脚本运行本轮 12 个 Node test 文件、模型单文件 Vitest、typecheck、build，并保存各命令完整输出。它不调用外部模型/企微，不启动产品，也不替代 Native 集成。`npm test` 是仓库全量 Vitest，按用户约定不默认重复。

### 8.2 本机已跑通的原状态离线组合

```powershell
Set-Location 'D:\Desktop\agent付费资料\qiwe-agent'
docker --context desktop-linux version
# 仅在无本轮验证正在运行时更新和重新封存测试 stage
E:/node.exe .local/frontagent-r3-20261029/prepare-stage.mts
$env:QIWE_REBUILT_RUNNER_IMAGE='sha256:092853e7a053fc50f84b8a6b6f7cabf4f1d52673718be4c3df10672a2f4fc187'
E:/node.exe .local/frontagent-r3-20261029/run-existing-rebuilt.mts
```

它核实原锚点停止、复制一致性、建立本轮隔离 volume、原 Docker 入口/PID1/只读挂载、原管理员 review/restore、两个 OS worker，并只清理自己标签对应容器。volume 和日志保留。耗时主要在 Windows bind 文件读取和 13,000 个快照校验；不要并发更新 stage。

### 8.3 受控真实分支（未验收，不是可直接使用的启动命令）

Linux PID1 为本仓 `verify-full-host.mjs`，需专属受控桥/volume、既有 sealed 原源码和 Linux 依赖、原管理员会话、原账号/岗位授权、镜像与原 shell 收据。其参数在原离线命令基础上显式增加 `--controlled-real-pilot`，同时必须有 `--full-host-conversations --restoration-scenario --restoration-real-container --frontagent-existing-state <绝对目录> --skill-root <原技能绝对目录> --typecheck` 及原 source/overlay 参数。不能从普通 Windows 进程直接启动。

私有配置目前固定读取容器 `/tmp/qiwe-live-pilot.private.json`（UID1000、0600、普通单链接文件），结构：`bot={botId,corpId,secret}`、`model={apiKey,baseUrl,model}`。它**尚未通过正式外层引导写入并完成组合验证**。`.local/.../run-live-preflight.mts` 是未执行的预检查草稿，故意没有注入该配置，会在读取处拒绝，不是正式启动器。

所需环境变量名称（不含密钥值）：

- 现有机器人文件：`WECOM_BOT_ID`、`WECOM_BOT_SECRET`、`WECOM_CORP_ID`。
- 模型文件：`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、`MINICLAW_AGENT_RUNTIME`、`AGENT_RUNTIME`。已选 DeepSeek Anthropic 兼容 endpoint/model；worker 禁止覆盖已有 provider 配置。
- 外层监督：`QIWE_REBUILT_RUNNER_IMAGE`、`QIWE_CONTROLLED_REAL_PILOT`、`QIWE_LOCAL_DOCKER_RUN_ID`、`QIWE_LOCAL_DOCKER_VOLUME`、`QIWE_LOCAL_DOCKER_HOST`、`QIWE_LOCAL_DOCKER_IMAGE`、`QIWE_LOCAL_DOCKER_DRIVER_IMAGE`、`QIWE_LOCAL_DOCKER_NETWORK`、`QIWE_PILOT_EXPIRES_AT`、`QIWE_EVIDENCE_ROOT`。
- 内层由监督生成，不是用户自行填写的许可：`QIWE_CONTROLLED_REAL_SCOPE`、`QIWE_RESTORATION_RECEIPT`、`QIWE_REAL_CONTAINER_ORIGINAL_SHELL`、`QIWE_REAL_CONTAINER_OWNED_MANIFEST`、`QIWE_FRONTAGENT_EXISTING_INPUT`、`QIWE_FRONTAGENT_EXISTING_FOLDER`、`QIWE_FULL_HOST_CONVERSATIONS`、`QIWE_RESTORATION_REAL_CONTAINER`、`MINICLAW_CONTAINER_IMAGE`、`WEB_PORT`、`MINICLAW_WEB_URL`、`MINICLAW_EXECUTION_BOUNDARY`。
- preload 的非密钥预算：`QIWE_PILOT_RUN_ID`、`QIWE_PILOT_MODEL_EXPIRES_AT`、`QIWE_PILOT_MODEL_REQUESTS`、`QIWE_PILOT_MODEL_OUTPUT_TOKENS`。

云端 clone **不包含**被忽略的原 Native N/O、Linux 原 SQLite 驱动/依赖、Docker build context/本机镜像、sealed stage、原管理员/员工数据库及绑定。只读代码和局部测试可以立即开始；完整宿主必须通过安全渠道取得有权限的源码/依赖与脱敏副本，真实场景所需真实状态另外安全提供。不能仅凭本仓或复制 Windows node_modules 宣称可独立运行；不要上传私有数据库、密码哈希、session、Secret 或付费课程资料到公开 PR。

## 9. 企微接口与测试参数

- 当前员工试点用 **企业微信智能机器人 API 模式 WebSocket 长连接**，锁定 `@wecom/aibot-node-sdk@1.0.7`。官方参考：[WecomTeam SDK 文档](https://github.com/WecomTeam/aibot-node-sdk)，本机同版文档 `node_modules/@wecom/aibot-node-sdk/README.md`。
- 连接地址：`wss://openws.work.weixin.qq.com`。机器人以 Bot ID/Secret 认证；本通道**没有需配置的公网 HTTP 回调 URL**，不通过网页 OAuth 登录完成员工消息身份，也不是原 XML 自建应用回调。
- 关注协议：`aibot_subscribe`（认证）、`aibot_msg_callback`（消息）、事件/卡片回调、`aibot_respond_msg`（回复）、`aibot_send_msg`（主动结果）、媒体上传。业务可信主体从当前 SDK 帧与服务端绑定解析，不从员工文本指定。
- 测试机器人是本轮已获准创建的员工测试机器人；精确 Bot ID/CorpID 在本地私有 `.env`，员工 userid、B 店、原 Profile/空间及批准记录在原副本的 `frontagent-wecom-bindings.json`、`frontagent-approved-roles.json`、`frontagent-workbench-access.sqlite`。CorpID 会在给用户的交接消息单独列出，避免把组织配置散入公开日志。
- **AgentID：当前智能机器人接口不使用自建应用 AgentID。** 原“预约接待”是另一路旧应用，保留不改；其当前 AgentID、HTTP/XML 回调地址本轮未重新核实，标为未知，不能拿 Bot ID 替代 AgentID。若改接原应用，应另行读取该应用当前配置和官方回调文档，不能沿用本表猜值。
- 仅指定 B 店员工一人被授权；不得把当前企业全部成员或群聊自动加入。机器人历史认证通过后已断开；当前真实入口尚未启动，没有用户发消息待处理。
- Secret、Token、API key、管理员密码与 session 只能从安全输入或本地受保护配置提供，聊天和 GitHub 不收集。

## 10. 踩坑、回退与接手验收顺序

已试过且不能重走：旧 MiniClaw setup/空库启动；把最新 HR 制品当原 B 店运行库；混用自建应用 Secret 与机器人 Secret；将 SDK 单独认证与模型 smoke 拼成真实闭环；合成 fixture 改联网或写 ready；无锁重复 npm 安装漂移；Windows Linux esbuild/SQLite 混用；把 Node test 与 Vitest 的配置混跑；只关闭公网端口却允许 runner 访问后台；关闭后恢复无限制 Docker 调用；把原 SIGTERM exit 0 当清理成功。

已有业务决策继续有效：不明确的旧任务/回复保留待人工核对，不续跑、不盲重发；管理员可恢复整个宿主，但不获得员工私有会话读取权；结果以原 D5/账本/回执为依据，不能用模型文字作已执行证明。

下一位只推进：**读本交接与三个阻塞 → 本轮代码局部测试 → 最终整体独立审查 → 原 Pi 离线生成真实形态多回合文件并修最小恢复判定 → 同宿主受控分支离线/无凭据预检 → 安全注入已授权单员工凭据 → 需求/完整答案/手机确认 → 追问与精确取消 → 停止并确认唯一执行器退出 → 同状态新 OS 进程只查回**。完成后再讨论发布，不能顺手动生产或开放 CRM。

本地回退：关闭/停止**本轮标签**的试点容器，保留隔离卷和证据，回到未修改的原产品锚点；不 reset/clean 原仓，不删除数据库、不用新库替换。若 stop/发送/清理结果未知，明确记录未知并核实物理状态，不自动发起第二次执行。
