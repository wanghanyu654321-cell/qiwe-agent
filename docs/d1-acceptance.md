# D1 岗位空间与企微会话选择

日期：2026-10-21。设计及实现基线 `19bfc67318a54afb1223a2cfdf7c8a1fcd736ee9`；分支 `feat/wecom-role-conversations-d1`。本文只记录 D1 与 T7-A1 范围增量，不代表真实企微开放或原 Agent 已恢复。

## 交付边界

员工沿用管理员已有授权，在企微发 `岗位 内容营销` 等命令选择获准岗位；`岗位查询` 只读取已保存选择，重新发送选岗命令才向 Native 核实同一资源；`退出岗位对话` 恢复原普通文本报数规则。身份、门店和岗位仍来自原可信绑定及实时授权。员工不安装技能，不配置模型，也不登录 Web 完成首次准备。

Q 的适配通过明确的 Native 准备端口查找同一资源；候选 Native 服务继续使用原 Profile 安装对账、本人空间额度、能力锁、Profile 锁及非 Home/container 规则。岗位模板、原技能可用性与可信身份读取器由服务端装配；本轮只用合成模板和临时数据验证，没有配置真实员工。

**选择成功不等于自然语言执行成功。** 选岗后的普通文本明确回复“对话执行尚未接通”，不受理 Agent 任务，也不偷偷写入报数。明确的报数、经营、培训和固定任务命令继续走原服务及各自授权。自然语言需求、连续追问、真实执行与结果关联属于 D2–D5。

## 改动与持久化

| 边界 | 最小改动 | 保留规则 |
| --- | --- | --- |
| 企微身份与路由 | `wecom-bot-context/assembly/handler` 接入岗位选择；先保留消息指纹，再执行会话副作用 | 非经营员工可选已获准岗位，不能因此报数；冲突消息不写选择/准备资源 |
| 岗位会话 | 新增 `wecom-bot-conversations.ts`；原 BotTaskStore 内增加 `bot_conversation_events/current` | 保存原账号、门店、授权/绑定版本及空间引用，不复制原记忆、技能或 SDK session |
| Profile 准备 | `workbench-opening.ts` 提取 `prepareOwnProfiles` 供 Web 与渠道共用 | 原安装对账与日志继续使用；原 Web 调用方回归 |
| 原 Native 候选 | `role-workspace-overlay.mjs` 提取原路由的 owner 服务，原 HTTP 门面继续调用同一业务体 | 不伪造管理员 Cookie；原源码只读，补丁在候选转换边界 |
| Native 资源归属 | 在原 `router_state` 保存 `wecom-role-workspace:v1:`、`wecom-role-owner-claim:v1:` | 稳定资源键、token/CAS 和 owner 创建占用；未核实结果不盲重建，不新增数据库服务 |
| 回企微 | 复用原发送端口和 reserve/prepare/claim/finish 回复意图 | 业务状态、请求超时和投递结果分别处理；未知投递不盲重发 |

已有选择遇到调店、撤权或绑定版本变化会失效。旧选岗/退出消息重投不会覆盖更新的选择。岗位资源键不含消息编号或授权版本，合法重新选择可查回原资源；不能按空间名称猜测归属或把旧历史改绑给新门店。

创建工作在逻辑超时后可能仍物理运行，渠道原 gate 必须等实际 Promise 结束才释放票据。迟到返回不能保存 ready 选择或外发回复。原空间发布和确切资源结果在同一 Native SQLite 事务写入，使“资源已提交、当前请求未收到回执”能由新请求查回；没有确切发布证据的 pending 仍保持未知，不靠超时自动清锁。

## 与 T7-A1 的对应

新增范围已列入 [恢复验收清单](t7-recovery-evidence-acceptance.md)：Profile 列表可能隐式创建默认 Profile；空间准备有原持久化、内存登记及预热；Q 选择记录与 Native router_state 属于不同存储；逻辑截止与物理结束必须区分。原预热调用只是请求入队，本地原服务组合使用替身禁止启动容器，不能据准备 Promise 结束声称真实预热结束；其实际队列义务仍由 T7 验收。

原扫描器看到 router_state 记录不等于理解其中的资源 claim。四类全局证明和逐记录处置仍未完成，T7-A1/A2/A3/A4 不因 D1 通过而勾选。Native 端口保持 `isolated-synthetic`，完整宿主仍按原门禁拒绝恢复。真实主进程、真实模板/技能、渠道生命周期及 Linux 正向恢复未验收。

## 本地验证记录

环境：Windows / Node 24.18；公共测试使用临时文件及合成身份，Native 采用原源码候选和经验证的原 SQLite 驱动。所有日志在忽略目录 `.local/d1-20261021/`，不提交业务数据或运行环境。

- 公共完整回归：`npm test`，42 个文件、556 项通过，最终文案修正后的日志 `public-final.log`。
- 静态类型与构建：`npm run typecheck`、`npm run build`，通过。项目没有独立 lint 脚本，不另造 lint 通过结论。
- 首次完整回归出现一次未修改培训测试的 Windows `renameSync` EPERM；单独复跑 `training-cancel.test.ts` 20 项通过，随后完整 556 项通过。没有为此弱化测试或改动培训逻辑，原因未确认。
- 专项覆盖岗位授权、跨店/撤权、重复与冲突消息、旧选择重投、明确命令兼容、真实准备迟到返回、持久选择重开与未知结果查回。测试数量不能替代真实渠道验收。
- Native 验证工具回归：`node --test integrations/native/prepare-native-sqlite.test.mjs integrations/native/verification-options.test.mjs integrations/native/linux-runtime.test.mjs`，15 项通过、1 项 Linux 专属跳过，日志 `native-tools.log`。

Native 独立测试：设置明确的本机 `QIWE_NATIVE_ROOT`、`QIWE_OVERLAY_ROOT`、`QIWE_SQLITE_DRIVER` 后执行 `node node_modules/vitest/vitest.mjs run --config .local/d1-20261021/vitest.config.mts`（仅包含 `integrations/native/role-workspace-native.test.mts`），6 项通过，日志 `role-workspace-native.log`。覆盖原驱动两连接/重开、token/CAS、owner 占用、同库发布回滚与暂停拒绝边界。

Windows 最终命令：`node integrations/native/verify-full-host.mjs ABSOLUTE_N_SRC --host-overlay ABSOLUTE_O_SRC --sqlite-driver ABSOLUTE_PREPARED_DRIVER --typecheck`。日志 `windows-verified.log`，runId `2026-10-21T12-34-28-109Z-aa9d8846-a7f9-422b-8ad6-e4f865b5fbfa`；候选类型检查通过，原服务组合 3 项通过，完整宿主 boot/restart 各 8 项通过、8 项 Linux 专属跳过，PID 18668/35852。重启验证使用第二个独立 OS 进程，仍保留原暂停数据，未正常恢复。

原服务组合在隔离 fixture gate 下验证：实际原 Profile/group 服务 → 原 SQLite 发布与精确 claim → 丢失回执后新请求查回；以及同一离线 SDK 消息 → Q 可信授权/装配 → 原准备服务 → 持久选择 → SDK 回复载荷。另有真实 appointment paused 零写反例、第二获准岗位、无归属旧空间拒绝，以及 17 个网络/进程实际拒绝用例。fixture gate 不是原宿主恢复许可，预热替身不启动容器。

Linux 最终命令：`node .local/t7f-20261021/run-linux.mjs --typecheck`，复用既有受控复制器和本机固定镜像，禁止网络、不拉镜像、源码及根文件系统只读。日志 `linux-verified.log`，runId `2026-10-21T12-34-45-777Z-b8023a9d-b5f8-4733-b9da-7f2da041a871`；原 Linux SQLite 驱动及 Node 22.23.2，类型检查通过，原服务组合 3 项通过，boot/restart 各 15 项通过、1 项 Windows 专属跳过，PID 77/137。两平台审计分别核对当前 208 个组合模块、24 个公开依赖模块及测试/转换器哈希通过。Linux 临时审计随容器销毁，日志保留同 runId 的完整哈希及进程证据。

一次 Linux 初跑因测试在耗时模块初始化之前创建并复用请求 scope，导致 scope 先于实际调用过期。修复仅在各次实际调用时创建新请求，查回也用新 scope；没有扩大业务 4 秒预算或弱化断言。最终两平台都运行修正后的同一测试，候选测试 SHA-256 为 `64ad98206d8e6915c73f7838e425593d2a4724b20236c59f81048128b2eaf383`。

独立审查针对 14 个公共/Native 实现和测试文件，记录在 `independent-review.md`；哈希清单 `independent-review-hashes.json` 的 SHA-256 为 `56107ef9fcb2fff0c160c7ca57404e82470ba4eb25b51cf993f80b14e4b34494`。已修复命令被选择状态吞掉、全局消息冲突前产生副作用、缓存文件撤权检查、资源提交后失回执查回、旧空间归属歧义及隔离守卫验证缺口。审查认为当前实现没有剩余阻塞项；最终双平台证据已与同一文件清单核对，不沿用旧测试文件的成功结果。

## 兼容与停止条件

没有删除账号、账本、记忆、旧 Web/XML、任务或培训功能；未新增运行依赖、模型调用、真实消息和生产修改。选岗只是额外入口，复杂 Web 管理仍保留。

不能验证 owner/门店/岗位归属、模板、当前授权、原额度或门禁时返回未知/拒绝，不自动改绑或回落为经营操作。已有无可信门店归属的非 Home 空间需要管理员核实，D1不按同名猜测收编，也不自动多建一个。Native 准备占用没有确切完成证据时保持待核实，可能阻止该账号继续创建其他岗位空间；后续处置必须有原资源证据，不能删除记录充当恢复。员工不需要重新装配，但此类历史归属/未知占用仍可能需要管理员处理，不能承诺所有账号首次选择都自动成功。

当前回退是停用候选岗位会话装配并保留持久记录，不删除原资源或回退数据库内容；原服务和旧调用方保留。生产回退与升级迁移尚未执行，不以本地停用方案代替发布验收。
