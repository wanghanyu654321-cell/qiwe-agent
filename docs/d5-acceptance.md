# D5 完整答案、发送恢复与重启查回

2026-10-23，开发基线：D4 `901b19ab09521b48cac50fa04017ea420efaed24`，分支 `feat/wecom-conversation-replies-d5`。本阶段按 [执行说明书](roadmap.md) 和 [原会话计划 §3.3](wecom-native-conversation-plan.md#33-持久输出转企微回复)推进。D5 本地隔离适配、公开全量、Linux 组合及独立问题复审通过，具体证据见下文；完整宿主恢复和真实渠道验收未完成。

## 验收目标

员工在企微获得自己原岗位 Agent 的完整持久答案；发送失败只影响通知，不能触发第二次 Agent 执行。重启后，新查询仍能读到原答案和版本。保持原账号、授权、会话、技能、账本和发送能力。

| 场景 | 要证明的行为 | 当前证据 |
| --- | --- | --- |
| 原答案完成 | 原输出确已保存，再将结果版本与受理号、实际 query/turn 关联；checkpoint 不作为完整答案 | Native 原保存后见证、终态快照事务通过；后续 held 输出使旧见证失效 |
| 长答案与连续追问 | 全文完整可分页查回，旧结果不被同一源消息 ID 的续写覆盖 | UTF-8 分页、同源 ID 覆盖、重复完成及追加修订通过 |
| 通知失败恢复 | 固定原收件人与正文；明确失败可恢复，未知状态不盲重发 | 明确拒绝的显式重试、迟到 ACK、并发恢复、撤权和超时票据通过 |
| 跨库退出 | Native 已完成而 Q 尚无回复意图，按原持久结果补建意图，不重跑 Agent | 第二进程按原冻结结果补建意图并用原 notify；执行次数不增加 |
| 第二进程 | 第二个 OS 进程读取第一轮数据，新企微查询得到同一完整结果；不重新生成样例 | Windows 与最终 Linux 两独立进程通过，原执行次数不增加 |
| 现有功能兼容 | 原报数、更正、任务、培训与 Web 保存规则保持；权限和 T7 条件不放宽 | 公开全量 588/588；默认完整宿主回归另列，正常恢复未通过 |

## 已核实的实现依据

原 `index.ts` 中 `sendMessageWithOutcome` 保存的是完整 `dbText`，可能不同于当前流式增量。原 `storeMessageDirect` 会对同一 turn 的 `sdk_final/truncation_continue` 复用消息 ID 并覆盖正文。原执行回调结束也可能早于保存，部分输出异常会在原调用方捕获。因此，执行完成、源消息 ID 或回调正常返回均不能单独证明完整答案。

D5 只在现有候选转换中补终态持久结果关联，并复用 Q 原回复意图及 `createBotSender`。新增记录仍须纳入 T7 原扫描和恢复规则，不能因为本地测试通过就把未知对象或旧写者标为安全。

## 员工体验和接入方式

获准岗位的需求仍经 D1–D4 原入口执行。完成后，员工收到带受理编号、版本和页码的完整答案；`查询对话 <受理号>` 返回最新冻结版本首页，`查询对话 <受理号> <版本> <页码>` 查指定页。每页附下一页命令，正文按 Unicode 码点切分，不丢掉超过单条消息长度的内容。当前页正文上限 14000 UTF-8 字节，保留原 sender 的 16384 字节校验；这不是对真实平台限额的新承诺。

原执行终态写入同库 `wecom_conversation_results`，保存实际 query/turn/session、源消息 ID、摘要和完整正文，和执行完成同事务提交。旧源消息不能作为不可变版本；没有保存见证的历史完成记录只提示完整答案待核实，不补造答案。重复完成不生成第二版，后续有效修订追加版本。

`createBotConversationDelivery` 复用 `bot_reply_intents` 及原 `sender.notify`。调用者在完成/恢复时创建新的可信上下文，不跨越原请求生命周期保留旧 `req_id`。每次只处理给定受理号，至多读取 32 个版本、准备/投递 32 页，更多内容用返回游标继续；没有新增常驻扫描器。`prepared/blocked` 可受控恢复，`rejected` 必须显式指定 `retryRejected:true`；`attempting/unknown/accepted` 不重发。新查询可读原答案，不能把旧未知投递改成成功。

企微查询仅在显式配置 `conversations.deliveryGate` 时补建缺失意图，不顺带发送历史通知。所有写入沿用原门禁；读取超过逻辑超时后，门禁票据仍保留到实际读取结清。完成通知失败不改变已提交的执行状态。营销岗位无需经营岗位授权；主动通知和查询回复均在发送前重新读取原受理号及指定版本，核验本人原空间与当前授权。

## 实际验证

本地验证使用合成身份、临时 SQLite、离线企微 SDK 和确定性模型 I/O；原 N/O 目录只读，无安装或升级依赖。命令在本仓根目录执行，Windows Node 24.18.0。没有独立 lint 脚本，不声称 lint 通过。

| 命令/入口 | 实际结果与证据 |
| --- | --- |
| `npm test -- --maxWorkers=1` | 最终代码 43 文件、588/588 通过；`.local/d5-20261022/root-public-final.log` |
| `npm run typecheck`、`npm run build` | 最终代码均 exit 0；`root-typecheck-final.log`、`root-build-final.log` |
| D5 直接相关公开 suite | 初版 120/120，查询权限修补后相关五个 suite 108/108；`public-final.log`、`query-preflight-targeted-final.log`，最终全量覆盖两者 |
| `verify-conversation-execution.mjs N_SRC O_SRC WINDOWS_DRIVER` | Windows boot 2/2、restart 2/2；run `ce29faed-ae4b-4b86-b943-4eaead87b9b3`，PID 20236/26732，`native-final.log` |
| 同入口，`QIWE_D5_MIGRATION71=1` | v71→72，两个进程各 2/2；run `f80e9e90-3249-4df8-bbc2-5ea954ae993e`，PID 24128/32740，`native-migration71.log`；保留历史记录、备份失败拒绝、无猜测快照和追加版本通过 |
| 同入口，`QIWE_CONVERSATION_MIGRATION=1` | v70→72，两个进程各 2/2；run `de86aa73-d546-4d69-8708-12dc4c7aea3f`，PID 26540/25648，`native-migration70.log` |
| `verify-full-host.mjs N_SRC --host-overlay O_SRC --sqlite-driver WINDOWS_DRIVER` | 最终 Windows 默认宿主：岗位准备 3/3；boot/restart 各 8 通过、8 原有平台跳过；run `2026-10-23T07-23-37-501Z-7d8befa4-97f2-441a-9f4e-0b5c827f4c51`，PID 34528/37092，`windows-host-final.log`；正常恢复依旧拒绝 |
| Linux `verify-conversation-execution.mjs N_SRC O_SRC` | 最终 boot/restart 各 2/2，候选类型通过；run `4f58075e-1217-4863-8a8f-cf9398bb3ffe`，PID 44/81，`linux-execution-final.log` |
| Linux `verify-role-capabilities.mjs N_SRC O_SRC --skill-root SKILLS_ROOT` | 最终 5/5；run `b0b57cec-b3db-4d06-a516-ab730d18492d`，PID 51，`linux-skills-final.log`；同请求经过原 Pi/三个现有技能/工具/保存/新鲜可信上下文/原 notify 和完整 markdown 载荷；6 次确定性模型流、0 次网络调用 |
| Linux `verify-full-host.mjs N_SRC --host-overlay O_SRC` | 最终岗位准备 3/3；boot/restart 各 15 通过、1 原有平台跳过；run `2026-10-23T07-29-36-274Z-674b4df8-8641-4493-b513-494ef4fd72eb`，PID 70/130，`linux-host-final.log`；正常恢复依旧拒绝 |
| 独立规格及质量审查 | 查询发送前 Native 权限竞态 P1 已复现并修复，独立复现由 `sentAnswer:true` 变为 `false/blocked`；独立问题复审通过，整体代码和文档检查未发现其他阻塞项 |

上述日志均位于本地 `.local/d5-20261022/`，不提交生成物或私有源码。Native 审计记录在 `.local/d3-native/<runId>/audit.json`，含两进程 PID、实际候选及公开支持文件 hash。Windows Native/migration 证据来自查询修补前，覆盖未变化的候选事务和迁移；查询修补后的组合证据由最终 Linux 运行补齐。最终 Linux 执行/Pi 各 23 个公开源码、Windows/Linux 完整宿主各 24 个公开源码的 hash 均与待提交文件一致，摘要保存在 `final-audit-summary.json`。有效失败证据包括缺少结果读取端口、通知构造器、“后续 held 输出错误沿用旧完成见证”，以及查询后归档/改绑/维护/结果变化/迟到读取；修补后相关反例通过。

## 侵入度、回退与未完成边界

修改集中在原渠道适配、回复意图扩展及显式 Native 候选转换，没有改原 Agent 循环、技能、账号、账本和页面。中等侵入主要来自 Native schema 72 新增不可变结果表；沿用原升级前备份及拒绝降级，旧 v70/v71 数据不被重写成伪造的完成答案。回退须先停新入口、按原规则处理在途执行与通知，保留结果关联供查回；不能删表或换旧宿主绕过扫描。

默认完整宿主不启用 D5 转换，T7 `UNKNOWN_OBJECT`、四类恢复证明和旧写者等阻塞保留，见 [T7 增量登记](t7-recovery-evidence-acceptance.md#d5-对-t7-的必要增量2026-10-23)。原 main 真实渠道装配、完整 O 恢复后执行、真实模型质量、外部 MCP、活动工具业务写入时撤权、真实平台 ACK 和手机实收仍未验收。本阶段不部署、不连接真实渠道、不调用真实模型。
