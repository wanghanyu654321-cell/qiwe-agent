# T5 验收记录

日期：2026-10-18，UTC+8。基线T4 `70ae2d209c85b0b05d648afb0f19c514afde5c15`；分支`feat/wecom-tasks-t5`。本地Windows、Node.js 24.18.0、真实临时SQLite/培训文件与合成端口。无生产操作、真实渠道发送、模型调用或私有运行循环变更。

## 已实现与验收证据

| 范围 | 行为及验证 |
| --- | --- |
| 企微入口 | 执行已有任务别名、培训问答/教案、查询与取消任务。每条命令按原岗位重新授权，成员/门店/本人Home/绑定及事件一致；training-only员工不被提升为manager |
| 原Native任务适配 | 受控alias映射到既有非Home工作区task/profile；核验工作区Owner、显式非Home、当前Profile所有者/绑定、agent/container类型及原暂停门禁。默认不执行，不创建任务或改Home |
| 原引用和幂等 | `bot_task_refs`只保存渠道任务引用/执行受理和取消元数据，不是第二执行器。事件全局预留、SQLite唯一键和CAS；原trigger的active-conflict返回他人runId时不收编；同事件并发只触发/回复一次 |
| 进度和结果 | linked仅指保存原引用；进度读取原精确run/key/快照或原培训get。queued/running/retry_wait/success/delivered/failed/cancelled等分别解释，原提示delivered不当执行成功，ACK不当任务完成 |
| 培训复用 | 原知识审批与来源哈希、检索片段、问答/45分钟教案输出合同和持久结果保留。知识/输出模块及3份原测试字节一致。只注入合成generate，不导入原Pi worker、凭据或课程资料 |
| 培训取消 | 新增原service的`cancel(actor,key,expectedRunId?)`和`close()`。取消前核验保存的原id/actor/input，原服务再按expectedId栅栏；先落cancelled再abort，迟到输出不能覆盖，重复取消幂等 |
| Native取消 | 原精确run/key/任务快照验证后调用cancelRun；不使用宽泛stopGroup或工作区interrupt。请求受理与原cancelled终态分开，结果未知不通过新指令自动再取消 |
| 结果查回 | 继续复用T3回复outbox，业务前指纹预留。长结果按Unicode码点分为2000字页，在企微查完整内容；查询不重跑任务、不会把查询ACK覆盖执行/取消事实 |
| 重启 | 新进程重开同一渠道元数据、合成原Native事实和原培训文件：ready结果/unknown/取消记录按原编号查回，重复原事件零trigger/cancel/generate/reply。培训控制器不属于本实例时unknown，不冒充已取消 |
| 现有能力 | 报数、更正、汇总、Excel和Web/XML调用保持原路径；没有新公网路由、新依赖或原库迁移。账号、岗位、账本、知识和记忆不删除或重建 |

渠道引用字段只来自T1服务端上下文，岗位名称不授予权限，文本不能提供Owner、门店、原runId、Profile或工具权限。任务触发之前持久化attempting；之后超时/崩溃保留unknown，不自动重提。异步返回和实际企微回复前重新验权；Native、授权库及业务库间仍无跨库原子事务。

## 原接缝核验与未接通部分

原Native源码中`MessageCreateSchema`仅chatJid/agentId/content/attachments/followUpBehavior，没有单消息profileId或外部幂等键。主、子会话都从工作区解析Profile；Home会恢复默认Profile，不能通过新会话或临时换绑定隔离岗位。当前本地overlay仍暂停执行/取消，未装配受控机器人执行入口。T5没有恢复这些入口，也没有拿管理员Cookie绕过原Owner/工具门禁。

可复用的原scheduler契约为：`triggerTaskNow(taskId,deps,idempotencyKey)`、`getTaskRunById(runId)`和`cancelTaskRunNow(runId)`。原task_runs有稳定幂等和取消栅栏，适用于已有任务，不等价任意用户对话。适配器的inspect是**新受控端口约定**，投影已有task/group/profile字段，不是已经存在的Native Hook。读取和执行的真实装配尚未完成；本轮仅用合成投影验证契约。

原run快照不包含Profile版本。当前只核验执行前/查回时的配置与绑定，不宣称任务已冻结某个Profile内容版本。脚本、host执行、Home任务或无法核实的原记录一律不通过本切片执行；原功能继续保留在原工程。

## 验证记录

| 命令／检查 | 结果 |
| --- | --- |
| 基线`npm test`，T4 HEAD | 21文件299项通过 |
| T5新行为测试 | parser/任务引用/Native/培训取消/企微路由有效RED后实现；两项P1回归分别复现误取消和误用Home后修复 |
| 新仓`npm ci --ignore-scripts`、`npm test` | 从锁文件重新安装成功，29文件415项通过 |
| `npm run typecheck`、`npm run build` | 通过 |
| `npm run demo`、`demo:report`、`demo:delivery`、`demo:operations`、`demo:tasks` | 全部通过，包含独立进程任务/文件查回及重复事件零副作用 |
| 原仓兼容测试（以本次manager/training模块做alias） | 17文件148项通过，含旧manager、培训generation/knowledge/output/http/opening/native-auth合同；不是全私有仓或真实渠道验收 |
| `npm audit`、来源manifest | 0已知漏洞；55份源码/测试哈希匹配，5份原培训文件及原Excel模板/测试不变 |
| 暂存diff／敏感内容检查 | 24份任务文件，diff检查通过；55份暂存源码/测试manifest匹配，凭据模式扫描未发现命中；未暂存及非忽略未跟踪文件为空 |
| 独立规格／质量审查 | 固定树`3a4d38bbf850fc77306a81080dbd4ceb5382db70`审查通过，两项P1已关闭，无剩余可操作发现；审查者独立复跑415项测试、类型检查、构建和独立进程演示，核对55份暂存manifest与公开范围 |

无lint脚本、无远端CI，不报告其通过。无浏览器页面改动，企微场景以官方形状载荷/发送合成端口验收。原私有仓包含先前脏改；本轮只读核验，不提交或修改该目录。

## 风险与后续

- 真实SDK、平台窗口/限流、手机收取、真实Native服务装配与恢复暂停，以及任何模型调用均待后续具体授权和T7验收。本轮不能证明原Agent已恢复或真实员工已可使用。
- Native自由对话的岗位隔离、请求幂等和安全精确取消仍缺接缝；本轮只适配已有非Home岗位工作区任务，不增加第二个运行循环。
- 原培训生成服务按账号和`web:local-training`业务命名空间隔离。可信装配者必须私有持有配置，并按租户/门店/Home分区目录，查询和发布继续核验授权。这个namespace不是新Native Home。
- 本实例只能中止自己持有的培训控制器；其他进程/重启后的未完成培训返回unknown，不自动重跑、不谎称已取消。多进程Owner路由/恢复另行验收。磁盘/SQLite提交失败保留不确定状态，由原编号查回和管理员核实，不自动覆盖文件或窃取claim。
- 取消不回滚原工具已发生的外部副作用，Native取消受理也不保证进程已退出。运行success仅为原执行状态；业务结果仍遵循原账本/事务事实。
- T2/T3/T4 PR仍开放，本阶段依赖T4分支提交PR，不直接合main。下一步T6进行性能、多成员及兼容验证，不能据合成数据承诺耗时或容量。
