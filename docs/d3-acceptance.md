# D3 原会话执行、追问与取消

日期：2026-10-22。开发基线 `3282756ca5d78ebe51c69c3949599ebb7660087d`，分支 `feat/wecom-conversation-execution-d3`。执行依据为 [roadmap](roadmap.md) 和[对话接线计划](wecom-native-conversation-plan.md)。结论：D3 本地隔离组合验证与独立审查通过；不代表上线、真实模型可用或完整宿主恢复。

## 本轮边界

复用 D1 的原岗位空间与授权、D2 的原消息与受理关系、原 GroupQueue、`processGroupMessages`、`runAgent` 和 session。员工在企微发送需求、追问、`查询对话 受理号`、`取消对话 受理号`。执行中的追问先在原队列等待，本阶段不新增渠道插话协议、不新建调度器，也不开发 D5 的答案通知或结果版本快照。

正向执行仅在显式构造的 N 原服务片段里验证：保留原函数与依赖，停止自动启动 `main`，末端 runner 使用确定的合成实现，不调用模型。完整 O 宿主的恢复规则、暂停状态和默认候选均另行保留。不能把片段里的成功执行描述成完整宿主已恢复，或真实员工已经可以使用。

PI coding skill 用于核对 SDK 和执行边界；MiniClaw skill 只采用源码导航及证据方法。原 runner 的 `@earendil-works/pi-coding-agent` 声明和已安装版本均为0.84.2；本轮不更换 SDK，不另建 `AgentSession`，不改技能解析或模型设置。连续追问的 session 复用以原 runner 接口收到的实际 session 引用为证据，不把合成回答当模型生成结果。

## 员工可见状态

| 状态 | 含义 |
| --- | --- |
| 已保存需求 | 原消息及受理关系已持久保存 |
| 排队中 | 等待原会话执行 |
| 执行中 | 已关联到原队列分配的具体执行 |
| 取消处理中 | 已记录取消意图；尚不能确认执行停止 |
| 已取消 | 未执行输入被取消，或原执行确认停止；不回滚已经发生的业务操作 |
| 执行已结束 | 执行终态已确认；答案回企微仍属 D5 |
| 执行失败／结果待核实 | 如实保留失败或未知，不以回复成功替代业务成功 |

活动输入已和其他输入合批时，取消作用于该次共同执行；未执行的其他输入应保留。迟到取消不能作用于下一次执行。旧 D2 端口没有取消能力时明确提示未接通，不回落报数。

## 工程改动与副作用

公开侧只增加可选执行状态和取消端口；原 D2 受理端口仍可使用。Native 候选在原 SQLite 同库增加执行关系表，schema 70 升至 71，沿用原备份前置条件；输入、受理号和排队事实一起提交，后续仍由原队列执行。没有新增账号、业务账本、调度器、模型调用或依赖。

候选改动涉及原消息筛选、历史重建、队列执行编号和 Agent 输出接点，侵入度为中高，且仅在显式 D3 隔离候选启用。完整宿主默认不启用该适配；原工程文件保持只读。

为避免旧失败、取消或失权上下文继续留在 session，当前采用保守的原历史重建：同空间仍存在此类执行记录时，后续轮次可能反复重建 session，增加上下文加载成本。这不是新增记忆系统，本轮不做额外优化；没有测量真实模型延迟或费用。取消不撤销已经产生的业务副作用。

重启验证采用两个独立 OS 进程，第一进程可在取消尚未结束时退出，第二进程只查已存状态。尚未测试真实子进程的强制终止或 SIGKILL；测试 runner 不执行真实工具。

## 验证记录

运行位置为 qiwe-agent 根目录。公开路由先运行失败测试，11项因缺少执行状态与取消路由失败；实现后包含边界补充共13项专项通过。`npm test` 为42文件575项通过，`npm run typecheck`、`npm run build`通过。日志位于本地 `.local/d3-20261022/`。

原执行组合、两进程查回、旧数据升级和默认宿主兼容已在 Windows/Linux 验证，最终代码经过独立复审。没有真实企微消息、模型调用或生产变更。没有 lint 脚本或仓库 CI 工作流，不宣称 lint 或远端 CI 通过。

独立审查发现并修复三项 P2，均有对应失败测试再转通过：既有 D2 受理缺少执行关系；原执行文件准备失败后回执滞留 running；错误轮次的中断事件污染本轮取消状态。旧需求在原备份门禁通过后补入同库排队关系，身份仍须重新核验；原 `runAgent` 外围只结清仍活动的孤立状态，保留实际终态；回调在传给原消费者前检查轮次归属。复审未发现本轮范围内剩余 P1/P2。

| 验证 | 实际命令及结果 |
| --- | --- |
| 公开代码 | 根目录 `npm test`：42 文件 / 575 项通过；`npm run typecheck`、`npm run build` 通过 |
| D3 原执行（Windows/Linux） | `node integrations/native/verify-conversation-execution.mjs <N原src> <O原src> [已验证Windows驱动]`：两平台原候选语义类型检查通过，各 boot 2 项、restart 2 项通过，第二进程通过离线 SDK 查询 10 个原受理状态 |
| D2→D3 原数据升级（Windows/Linux） | 同命令，设置 `QIWE_CONVERSATION_MIGRATION=1`：先用 D2 实际 SDK 受理，再由另一进程升级；两平台各阶段 2 项通过，原输入与受理内容逐字段保留，备份失败不升级，失权需求不进入待执行集合 |
| D2 兼容 | `node integrations/native/verify-conversation.mjs <N原src> <O原src> [Windows驱动]`：Windows/Linux 原语义类型检查及 boot/restart 各 2 项通过 |
| 默认完整宿主兼容 | `node integrations/native/verify-full-host.mjs <N原src> --host-overlay <O原src> [--sqlite-driver <Windows驱动>] --typecheck`：两平台原语义检查及岗位服务 3 项通过；Windows 启动/重启各 8 通过、8 平台跳过，Linux 各 15 通过、1 平台跳过。成功恢复仍拒绝，不表示宿主已解锁 |
| 验证工具与源码准入 | `node --test integrations/native/linux-runtime.test.mjs integrations/native/prepare-native-sqlite.test.mjs integrations/native/verification-options.test.mjs`：15 通过、1 平台跳过；`node node_modules/vitest/vitest.mjs run --config integrations/native/conversation-execution.vitest.config.mts`：1 通过 |

Windows 最终执行 runId `ae99b7fd-9d1d-4e88-8c87-ab712d2a86ab`（PID 34136/9200），升级 runId `637fc5b3-95e3-47d6-bdc5-103a71127462`（PID 9416/37660）。原源码身份由候选构造器逐次核验；208 个组合模块、23 个公开支持模块、执行转换与测试文件哈希和当前文件一致。原源码、驱动、合成数据库和完整日志留在本地，不上传私有基座或数据。

Linux 最终执行 runId `07afd268-9242-4467-96b3-898d45f906f5`（PID 44/81），升级 runId `b32eda38-e73f-451b-b725-41ad3ee4f5d7`（PID 44/77）；使用已有固定镜像、原 Linux SQLite 驱动、受控副本和断网只读容器，最终哈希已核对。详细日志分别为本地 `.local/d3-20261022/linux-execution-final.log`、`linux-migration-final.log`；临时容器清理完毕。

## 后续

D4 验证原岗位技能与工具装配；D5 接通持久答案与结果回复。完整宿主启用仍须满足 T7 的恢复证明，并把本轮执行关系、取消意图及 session 处理纳入既有扫描和恢复规则。
