# 原 Native 单条执行的本地合成接缝

最新验收见[媒体、门禁和原驱动记录](../../docs/t7-host-readiness-acceptance.md)。当前增加同版本真实驱动及真实BootGate模式；原Node SQLite替代模式仍保留并明确区分。

本目录交付最小候选补丁和可重复的隔离验证。**只能用于本地合成候选，不能应用生产或直接修改已有私有工作区。** 不包含 Native 源码副本、真实数据、配置或凭据。公开执行 port 默认 disabled；显式 enabled 仍只支持 `isolated-synthetic`，没有真实发送或模型准入。

`targeted-execution.mjs` 校验原始字节 SHA256 后精确转换两份文件；`targeted-execution.patch` 是同一转换的可审查 unified diff。原入口默认行为保留，新入口 opt-in。补丁复用原 `createTaskRun`、真实 SQLite 幂等/唯一约束、claim lease/CAS、`executeClaimedTaskRun`、原 queue、心跳、Owner/运行时检查、terminal handoff 和 exact-run cancel；新增按 runId 领取，不调用全库 pump/materialize/notification drain。

补丁使用零上下文diff，避免将空上下文行的单空格作为仓库文本尾随空白保存。验收脚本在完整来源SHA校验后以`git apply --unidiff-zero`应用，再与锚定转换逐字比较；不能跳过来源校验把零上下文补丁直接用于其他版本。`.mts`和`.patch`固定LF，保证Windows重新检出后的结果一致。

来源：本机既有 Native `src/db.ts` SHA256 `961b1eb108c7b5433f4c00fc68d2b2522823742399a26c913eb814230e755884`；`src/task-scheduler.ts` SHA256 `7ac6c9475ad236eb87eba442d393a680cb1e68bbb8189232cbc7f590a5c038f8`。来源变化会拒绝转换，不能忽略 hash 继续套用。审计详情在本地任务记录 `.local/t7b-20261020/native-seam.md`，不把该私有绝对路径硬编码进运行实现。

## 原进程装配契约

新导出是 `triggerTaskRunTargeted(taskId, deps, key, admission)` 与 `cancelTaskRunTargeted(runId, deps, admission)`。只能由已有可信服务进程在原 `schedulerDeps` 创建后绑定为窄函数：

```ts
const target = {
  triggerTaskRunTargeted: (taskId, key, admission) =>
    scheduler.triggerTaskRunTargeted(taskId, schedulerDeps, key, admission),
  cancelTaskRunTargeted: (runId, admission) =>
    scheduler.cancelTaskRunTargeted(runId, schedulerDeps, admission),
};
```

这段说明不是对现有 `index.ts` 的修改，也没有声称任何运行实例已经注入该函数。`createNativeBotExecutionPort` 只接收现有原同步 readers 和上述闭包，自己不 import/init Native、不建 queue、不加载模型、不持有凭据。每个请求通过原 `authority.withCurrent(context, syncWork)` 绑定自己的 account/tenant/store/member/grant/alias/profile，禁止全局 currentActor。排队开始时再次在原 grant 事务内重读 Native 最小投影；原 task 与 run snapshot 均须 agent/container/isolated，workspace 非 Home、owner 与现有 Profile/绑定匹配。

还必须把原进程的 **既有** `appointmentBootGate` 放入原 deps。证据来自已核验 overlay `appointment-boot-tasks-overlay.mjs` 284–302，以及 `appointment-boot-gate.ts` 36–47、101–116：`isPaused()`、`beginWrite(): WriteTicket|null`、`finishWrite(ticket: WriteTicket): void`。新入口要求 gate 存在、未暂停、获得 write ticket，并在 finally 完成；不创建或恢复 gate。原始 `SchedulerDependencies` 尚未带该字段，已有 overlay 才注入它；因此裸原始 index 并未接通本接缝。没有 gate 时明确拒绝，不能临时创建 ready/original gate 作为生产许可。测试 gate double 仅用于合成场景，不能证明真实恢复已完成。

请求 abort/deadline 在执行开始前会立即 durable cancel、停止该 run 的 task-scoped queueJid、清理心跳和监听；无需等 queue drain。排队后撤权/暂停/变更在 callback 再验证时终止，不留下可由全局 loop 捡起的 retry_wait。开始后沿用原持久执行语义和精确取消接口。取消先提交原 run token fence，再调用其已有 stopper；不停止整个 workspace。

准入窗口仅限本次请求预算。`native.start` 在返回时会结束其 bounded scope；若原 queue 忙碌、回调尚未开始，该 run 随 scope 关闭而变成 cancelled，查回显示明确未执行。`linked` 只表示保存了原 run 引用，不能称为已开始或保证会在后台排队执行。原 queue 空闲时可在回复前开始；已开始的 runner 不随聊天请求结束而取消，后续仍由准确 run 的取消指令管理。繁忙导致未开始的 run 可按编号查回；员工可发送一条新指令形成新的 key，系统不会自动 replay。这里没有跨请求保留过期 authority，也没有新增后台调度 loop。

## 隔离运行

在 qiwe-agent 根目录执行，参数是**源码目录**，不会访问 data/config：

```powershell
node integrations/native/verify-targeted.mjs 'D:/path/to/Native/src'
node integrations/native/verify-targeted.mjs 'D:/path/to/Native/src' --typecheck
```

脚本先核对两个 hash，再仅复制 src 到新的 OS 临时目录，实际 `git apply --check`/`git apply` 本目录 unified patch，再核对其输出与 hash 锚定转换逐字相同；从 temp cwd 运行真实原 db/scheduler 测试。它不启动原 index/loop。config 是全量 mock（无 importOriginal，避免 config 顶层 session-secret 读写），runner/runtime/file-manager/logger 是明确 fake，host/script 调用直接报错；继承环境中的凭据/模型/代理变量移除。临时目录经绝对路径约束后清理，原私有工作区保持只读。`patchNative(copyRoot)` 本身要求可信调用者传入一次性副本；不要对原目录调用它。

本机原 `better-sqlite3` 二进制无法被 Windows/Node24 加载，测试只替换原 `sqlite-compat` 驱动边界为 Node 原生 `node:sqlite`。实际执行原 `db.ts` SQL、索引、CAS 和事务，不是内存 Map；不声称验证了 better-sqlite3 驱动兼容性。依赖从现有 Native node_modules 只读解析，不联网安装。

上述是**不带`--sqlite-driver`的兼容验证模式**。原目录的12.11.1包实际带Linux ELF，Windows无法直接执行；不应修改或替换该原目录。新增模式使用相同12.11.1、相同JS和原sqlite-compat，只有临时包中的二进制选取官方Windows x64 / Node ABI137发布物。准备脚本显式下载、校验npm SRI和GitHub发布asset digest并安全解包，不执行安装/编译/lifecycle脚本；本轮未新增项目依赖。其他平台/ABI须重新核实匹配发行物，本脚本失败关闭。

```powershell
$driver = node integrations/native/prepare-native-sqlite.mjs 'D:/path/to/Native/src' --download | ConvertFrom-Json
node integrations/native/verify-targeted.mjs 'D:/path/to/Native/src' --sqlite-driver $driver.packagePath --host-overlay 'D:/path/to/existing-overlay/src' --typecheck
node --test integrations/native/prepare-native-sqlite.test.mjs integrations/native/verification-options.test.mjs
```

验证入口再次离线检查包/全部lib JS/二进制身份及依赖解析，不能用可修改的manifest作准入依据。临时node_modules仅覆盖better-sqlite3的解析，其余依赖指向原只读依赖；原sqlite-compat不mock。独立驱动用例实际验证事务、唯一约束、全量/嵌套回滚和关闭后重开。准备包保留在本机临时目录供复验，不提交二进制或依赖副本。

`--host-overlay`从既有O源码读取真实BootGate及纯源码转换器，完整核验来源hash，用不可变快照组合定向候选，不导入config/index。旧转换器的输入身份保护只增加精确T7定向输出的身份，保留原身份及全部锚点。真实gate须按原review/claimRestore/enterFinal/commitRestore恢复；测试证据是合成对象，不能用于真实恢复。暂停调度、恢复写票和stop等待真实结算的场景使用原实现及合成runner/provider。

N/O路径还须保持已核实原转换器的相对目录布局；来源或布局不匹配会明确拒绝，不尝试猜测其他宿主或放宽hash。

完整原index的生成文本只核对同一gate传给queue、Web、scheduler，ready后才启动消费者及原停机顺序。**运行候选不是完整O宿主栈**：使用真实gate和scheduler/IPC/recovery层，保留N原GroupQueue与T7定向db，未验收整个O warm/cold队列、DB boot promotion或Web。定向任务的同一真实gate守住准入和队列callback；组合用例同时使用原授权事务、原queue、真实原驱动和候选scheduler。不能将这些局部证据描述成真实宿主已启动或已恢复。

参数必须明确：未知、重复、缺值/相对路径和`--unpatched`与`--host-overlay`组合均拒绝，不静默降级为mock。组合结果为3文件17项及候选完整类型检查；默认替代模式另6项回归保留。原账号、账本、授权、页面及Agent循环不变。

测试覆盖 A 单条真实 scheduler/fake runner成功、同 key 幂等、B已到期定义/C已排队run/D到期通知/E过期started lease原始行不变、排队后撤权/暂停/abort、未drain即abort结算、准确 run cancel 与 late success fence。还有公开 `createNativeBotExecutionPort` + `createNativeBotTasks` 直接调用实际补丁函数，配原 `createWecomBotContext`/`WorkbenchAccessStore` 的真实临时 grant 库与**原 GroupQueue 实现**：空闲 queue 可在回复前开始并完成；用无模型的合成阻塞任务占满容量后，新run在回复收尾时cancelled，不会等容量释放后自行执行。原queue源码接点为 `enqueueTask` 1391、1437–1474忙碌/容量排队、1477–1486立即runTask，以及2588调用task.fn。单项故障测试另外使用可手动drain的fake queue。所有模型、发送和账户均为合成对象；没有真实渠道/模型/生产联调。

可观察基线缺口：加 `--unpatched` 会在原源码上运行同一验收，因没有 targeted 入口而失败。生成 diff 用 `node integrations/native/emit-patch.mjs ABSOLUTE_NATIVE_SRC`，仍只读源目录并写本目录 patch。
