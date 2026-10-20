# T7 剩余接缝：受控出站、卡片与定向 Native 执行

后续状态（2026-10-20）：媒体协议、真实门禁及同版本原SQLite驱动的进一步核验见[T7宿主与驱动验收](t7-host-readiness-acceptance.md)。本文保留前一提交的历史实现和当时限制。

日期：2026-10-20，UTC+8。基线 `69090a7cf13a65d3629cb7081527dbaa8c1bd6ee`，分支 `feat/wecom-controlled-t7`。沿用已批准的T7目标，复用原账本、授权、SDK连接和Native执行器。仅本地合成验证；不动生产、不连接企微、不发真实消息、不新增模型调用。

## 实施及验收计划

- [x] SDK：专用客户端出站适配；每个请求号在该客户端生命周期只准入一次，不跨超时/重连复用；主动发送和媒体帧使用独立请求号，回执必须匹配。取消后不准入下一帧，不承诺撤回已经提交的帧。沿用原持久通知状态，未知结果不重发。
- [x] 卡片：兼容官方实现出现的嵌套回调与旧扁平载荷，矛盾字段拒绝。本人确认复用原账本；结果使用原任务号、原回调请求号及明确本人接收列表的专用更新。缺少单聊归属仍拒绝；没有专用端口时明确未发送，不降级为普通stream。
- [x] Native：只读核实原源码后提供来源锚定的最小定向执行补丁；复用原数据库、queue、执行器和门禁，不调用全库pump。不改原脏工作区，仅临时复制并完整隔离配置/runner后验证。适配边界始终保留 `isolated-synthetic`；没有真实进程依赖不启用执行。
- [x] 回归：先记录有效RED，再实现GREEN。真实SDK队列配内存socket；真实Native源码补丁配临时SQLite及合成runner。覆盖取消、超时、迟到ACK、去重、撤权、跨成员/门店、任务精准范围及无关任务不变。
- [x] 集成：全量测试、类型检查、构建、既有演示和适用原调用方兼容；独立规格及质量审查，修复后复验。核对来源清单、敏感内容和最终diff，再提交依赖T7前置分支的GitHub PR，不合并main。

## 当前已核实的边界

固定SDK为 `@wecom/aibot-node-sdk@1.0.7`，不改第三方源码或私有队列。专用出站要求宿主不绕过适配器调用同一个原客户端的发送方法。临时素材上传不等于最终文件消息，取消上传可能遗留平台临时素材。

官方SDK声明与实际发布包的媒体 `chunk_index` 起点不一致；本轮仅对固定发布包实际零起行为做隔离验证，不据此声称平台合同或手机文件实收已通过。SDK更新卡片参考[官方SDK](https://github.com/WecomTeam/aibot-node-sdk)，嵌套事件参考[官方插件解析器](https://github.com/WecomTeam/wecom-openclaw-plugin/blob/main/src/message-parser.ts)。官方文档入口本次读取失败，不将失败解释为平台不支持。

原Native没有公开按run执行入口；现有触发会推进全库，配置模块顶层也会访问会话密钥。隔离验证不得导入原index或真实配置，不得以普通Native集成测试的通过替代本项目组合验证。

## 实际验证记录

- 基线：`E:/npm.cmd test`，37文件475项通过。
- 新行为：SDK适配stub的11项有效RED后实现；卡片2项RED复现嵌套不支持和冲突未拒绝；专用更新端口2项RED复现错误stream降级；白名单及迟到授权回归分别RED后GREEN。原Native无定向入口由同一隔离验收的未打补丁候选复现；环境驱动加载失败不作为行为RED。
- 独立审查发现1项P2：新增task_id改变历史确认fingerprint。旧blocked/unknown通知的真实临时SQLite升级回归2项RED后修复，使用原业务意图投影；旧blocked可换专用更新计划继续发送，unknown仍抑制、不重入账。
- 首次全量暴露既有Web/性能合成端口缺少新专用更新方法及context_mode。补齐这些fixture的明确能力声明，不改变原业务断言；性能故障注入仍只保留预设的1个失败样本。
- `npm ci --ignore-scripts`、`npm test`：锁定安装成功，最终39文件515项通过。`npm run typecheck`、`npm run build`通过。
- `node integrations/native/verify-targeted.mjs ABSOLUTE_NATIVE_SRC --typecheck`：6项通过，候选原Native完整`tsc --noEmit --incremental false`退出0。unified patch实际git apply后逐字核对锚定转换；原db/scheduler和原GroupQueue在临时目录运行，使用Node SQLite驱动及合成runner，未启动原loop/index。不是生产gate、原better-sqlite3二进制或真实Agent验收。
- `node node_modules/vitest/vitest.mjs run --config .local/t5-20261018/legacy-vitest.config.ts`：原调用方17文件148项通过（alias当前manager/training）；不是整个私有产品验收。
- `npm run demo`、`demo:report`、`demo:delivery`、`demo:operations`、`demo:tasks`：全部通过，保留新进程查回、原unknown不重发、同版XLSX、更正及精确任务引用验证。
- 另建临时包目录运行`npm ci --omit=dev --ignore-scripts`并导入构建后的SDK/sender模块：通过，未创建client。SDK仅从dev移到运行依赖，版本/integrity不变；`npm audit --omit=dev`为0已知漏洞。
- 独立规格与质量审查：1项P2已修复并独立复核，无剩余P0/P1/P2。最终diff、75项来源清单和敏感内容检查通过，审查对象以本次提交为准。本轮无lint脚本、无远端CI，不报告其通过；无浏览器或手机实测。

## 交付范围及保留限制

受控SDK装配组合用例实际经过原事件分发、授权、账本、嵌套卡片、专用更新、Excel与撤权。SDK队列专项保留真实发布包的发送/ACK处理，仅最终socket为内存对象。媒体每帧独立ID、串行无重试；SDK本身的5秒等待可能仍在，不能解释为底层缓冲已清除。

Native新增`createNativeBotExecutionPort`，默认关闭；源码补丁只在临时副本应用，沿用原执行器、queue、run lease/幂等与精确取消。原非Home账号/Profile/绑定/当前岗位由每次`authority.withCurrent`重新验证，task与run快照新增isolated限制。原Web、账本、培训、岗位和Agent循环未重做。补丁涉及原db/scheduler两份源码，因为原公开触发只有全库pump；旧入口默认行为保留，新定向入口显式准入。[补丁和装配契约](../integrations/native/README.md)记录兼容与回退边界。

准入仅限请求预算内开始。原queue繁忙尚未开始时，scope关闭会持久取消该run，员工可查回明确未执行；不保证跨请求后台排队。已开始的执行继续遵守原运行终态和精确取消。真实宿主仍需从原进程注入现有deps与已恢复BootGate；没有gate即拒绝，本轮没有修改原index、解除暂停或提供生产开关。

仍待真实受控联调：媒体分片索引官方合同冲突、缺少单聊归属的卡片事件、真实宿主门禁/库路径/运行bundle与成员绑定、平台ACK及手机实收。没有为绕过这些限制开放群聊、猜测single、读取真实数据或发送消息。
