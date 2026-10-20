# T7 联调前装配与离线验收

后续状态（2026-10-20）：SDK受控出站、卡片更新和Native定向执行候选的新增实现及限制见[T7剩余接缝验收](t7-controlled-acceptance.md)。本文件保留前置版本的核验记录，以下阻塞项不是后续版本的当前实现状态。

日期：2026-10-20，UTC+8。基线T6 `cd767c1aef057063948e1de786ab47bdf9523094`，分支`feat/wecom-assembly-t7`。**本轮完成T7前置核验、最小装配和本地隔离验证，真实联调与发布仍未完成。** 不动生产、不连接企微、不发真实消息、不新增模型调用；不读取真实库、凭据或课程资料。

## 已核实的真实契约

SDK参考[官方仓库](https://github.com/WecomTeam/aibot-node-sdk)及本次实际安装的固定发布包。GitHub main读取版本为`80615b987ef69c6028ad764924609247c0725955`，其package版本1.0.6；npm安装版本为`@wecom/aibot-node-sdk@1.0.7`，声明gitHead `ea48edf7c99be0609fe9740050f4942f897a5d95`在本次GitHub读取中返回422。**不声称GitHub快照与npm发布包等价**；行为核验以锁文件对应的实际发布包为准。

- npm锁定完整性：`sha512-51w+sTqunry6GD3HFvmuh0gArMSJDFE418vyvR1wMJHj1N6DaFuGD3HuaY2fazZs3mb9FWeQFX3+vU5t0Qhwmw==`。
- 实际CJS bundle SHA256：`c29c2097c29d3ad2b535d27c83f1ea93881f70cc8d6de180504e31762aec1919`。
- SDK只作为开发依赖，精确固定1.0.7；`npm ci --ignore-scripts`从锁文件独立安装验证，运行源码仅作SDK类型导入。不复制第三方SDK或原Native源码。

| 接点 | 核验与处理 |
| --- | --- |
| SDK连接状态 | `isConnected`只表示socket OPEN，不能替代`authenticated`。监听真实`message.text`和`event.template_card_event`；connected/disconnected/reconnecting/error及`event.disconnected_event`废止当前认证会话，没有假设kickedoff事件 |
| SDK帧与单聊 | 账号只从已给定SDK实例的认证事件帧及服务端绑定解析。bot/corp不符拒绝；SDK事件类型允许缺chattype，但没有保证可推断single，因此继续拒绝缺失单聊归因及group，未开放群聊 |
| SDK发送 | 真实`reply/sendMessage/uploadMedia`可离线验证包装；file body显式chat_type=1。ACK是平台帧，不是业务完成或手机收取；本轮只使用合成ACK |
| 原Native读取 | 真实导出是`getTaskById`、`getRegisteredGroup`、`getAgentProfile`、`getWorkspaceAgentProfileBinding(folder)`、`getTaskRunById`；group返回executionMode，run快照已解析为对象。只读桥显式投影，不整行泄露提示词或重复JSON.parse |
| 原Native副作用 | initDatabase、ensureHome、默认Profile/list修复等读取外观函数可能写入，因此不调用。实际trigger缺少请求者ACL且会pump全库任务，不能临时构造deps或直接接入聊天；当前暂停装配没有执行回调 |

原Native契约来自本机现有源码与overlay的只读核验；其中db.ts SHA256为`961b1eb108c7b5433f4c00cfc68d2b2522823742399a26c913eb814230e755884`，task-scheduler.ts为`7ac6c9475ad236eb87eba442d393a680cb1e68bbb8189232cbc7f590a5c038f8`。这些是本地源码证据，不证明线上bundle、运行状态、实际数据库或现有任务已经核实。

## 最小改动与场景

`wecom-bot-assembly.ts`只订阅事件，不持有connect/disconnect或真实发送能力。发送仍显式注入原`isolated-synthetic`端口。每条已认证事件同步抓取独立帧，创建原T1上下文，按当前门店/账号选择预先注入的原业务对象，再交给原Delivery/Tasks；没有全局当前员工、HTTP入口、新业务库、Profile装配或第二个Agent循环。

认证会话有独立代次；掉线、重连、错误、踢线、认证刷新或close会abort在途。默认最多8个在途请求、4000ms预算，溢出明确拒绝，没有无限队列。关闭仅移除自己的监听和上下文/请求服务；共享SDK、账本、授权、Native桥和后台培训服务仍归原调用方持有。原业务写通过原authority和request预算保护，已发生动作的finish结果继续落库，不以新代理层改变原事务行为。

装配时固定准入的培训开关/解析回调与Native方法；之后修改调用方原options不能启用未准入能力或替换执行器。共享服务状态、成员绑定和授权读取仍实时生效。该配置引用问题以3项有效RED复现后最小修复，并在本项目AGENTS补充检查规则。

`native-bot-service.ts`只接收上述5个同步读取函数，固定enabled=false、不接受trigger/cancel执行回调；组合最小对象后继续交给原T5适配器验证Owner/Profile/非Home/run/key。它可读取已有运行结果，但不能用来触发或取消真实任务。

| 验收场景 | 可观察证据 |
| --- | --- |
| 多成员与单一事实 | 真实SDK MessageHandler分发A/B/C并发事件到共享临时SQLite；各自报数、卡片确认、本人查回与重复事件去重。同店汇总200元、另一店100元，跨成员报告不能读 |
| 文件回传 | 复用原ManagerArtifactStore生成真实XLSX；真实SDK上传/文件包装在替换的最低sendReply之上执行，成员和chat_type固定。查询汇总不重发文件 |
| 撤权和角色 | 未认证、未知成员、错bot/corp、跨店无映射、撤权、缺single/群聊均拒绝且不新增业务/回复行。marketing-only成员可查询原岗位任务，不提升为manager报数 |
| 会话失效与迟到 | 5类SDK生命周期、close及预算耗尽使迟到身份结果零业务写/零新发送。重认证只接新代次；修改原帧成员/金额不能改变私有抓取值。重复attach、容量溢出和observer失败有对应断言 |
| 已发生发送的记录 | 断线前保存的业务保留；已调用发送端口落unknown而非永久attempting。晚ACK不升级unknown，重放旧事件suppressed且不再发送 |
| 原Native读取桥 | 原函数形状的临时SQLite返回执行模式、folder绑定和对象快照，经新只读桥及旧T5校验查回原run结果。缺字段、修复型/异步返回、getter、错Owner/Profile/Home/host/script/run/key/快照拒绝；不泄露原prompt |
| 组合装配与原报告 | 实际只读Native身份SQLite、原BindingReader、原授权、真实SDK分发和新读取桥一起查询原250元报告及既有任务引用。新执行/取消均blocked、原runs不变；同进程重开后原编号可查，撤权/恢复不改原报告/run |

Native集成fixture仅模拟已核实的原函数返回形状，未import真实Native模块。SDK装配fixture替换sendReply以验证真实包装/分片，**不冒称验证了队列或真实网络**；另4项SDK队列测试保留实际sendReply、队列、JSON序列化和ACK处理，仅用内存fakeSocket替换最终I/O，分别覆盖下述出站阻塞。

## 已复现的真实联调阻塞

1. SDK的排队回复与上传没有AbortSignal。原sender预算先超时，队列仍可能稍后发出；关闭本地上下文不等于撤销SDK队列。上传chunk也会继续重试。离线测试证明超时后媒体流程可继续，但原sender会阻止最终文件消息；不能据此承诺传输已取消。
2. SDK同req_id队列中的ACK只按req_id归因，上一项超时后迟到ACK可能被下一项消费。保持原持久化去重和unknown不重发；这不是支持重发的准确回执凭证。真实出站准入前必须解决或受控证明这些约束，不能仅加Promise.race或改SDK私有字段。
3. 缺少chattype的卡片事件无法在本轮证明单聊归属，继续拒绝。原确认结果的stream包装已通过本地SDK序列化，但服务端对卡片回调的接受方式、专用update协议及手机效果仍未验收，不将SDK通用reply解释为真实卡片更新成功。
4. Native写入只允许未来在既有原进程依赖及Owner/工具/暂停/额度门禁下装配。裸trigger会推进全库任务，不能作为“仅执行这条任务”的测试入口。真实库路径、作用域、已有任务与Profile、运行bundle及绑定生命周期尚待具体授权核实。

因此本轮没有提供真实发送/执行开关，也没有尝试修补或启动第三方SDK/原Native运行循环。保留全部原功能，未接通项明确标为待验收。

## 实际验证与交付

| 命令／检查 | 结果 |
| --- | --- |
| T6基线`npm test` | 33文件428项通过 |
| 新读取桥及事件装配TDD | 首次可导入stub的有效行为RED后实现；装配中过宽存储拦截曾使已发送结果留attempting，新增回归RED后移除代理，原unknown补记恢复GREEN |
| 独立审查的异步拒绝回归 | 读取器误返回rejected Promise时，请求虽拒绝仍产生unhandledRejection；普通函数回调的两项有效RED（含同时abort）后，先消费拒绝再保持同步契约拒绝，专项21项及typecheck/build通过。测试不用会自行观察Promise结果的Mock掩盖缺陷 |
| T7集成专项 | 首轮4文件42项通过，随后补3项配置引用回归。SDK队列为既有发布包行为验收，初绿；组合Native用例一处文案预期按实际“明确未取消”纠正，未伪称产品缺陷修复 |
| `npm ci --ignore-scripts`、`npm test` | 锁文件安装成功；配置引用与异步拒绝修复后最终37文件475项通过 |
| `npm run typecheck`、`npm run build` | 通过 |
| 原调用方兼容（本地alias当前manager/training模块） | 17文件148项通过，未修改原私有工作区；不是全私有产品验收 |
| `npm run demo`、`demo:report`、`demo:delivery`、`demo:operations`、`demo:tasks` | 全部通过，含独立进程报数、通知恢复/unknown不重发、同版文件及任务结果查回 |
| `npm audit` | 0已知漏洞；SDK为开发依赖，原运行依赖未变 |
| 来源、最终diff及敏感内容 | 16份任务文件diff检查及凭据模式扫描通过；原59份源码/测试哈希不变，新增2份实现、4份测试与1份离线fixture，66项暂存manifest匹配；无未暂存及非忽略未跟踪文件 |
| 独立规格／质量审查 | 基准树`6acb7f929e03849b27db8108a1bb3548fa6eb6cc`发现1项P2；修复树`569f775257f6e3d2d572a8110ce8b041d4fb3edd`已独立复核通过，专项21项及两条Node进程异常路径均通过，无剩余P0/P1/P2。SDK、装配、依赖及未变范围审查继续有效 |

无lint脚本、无远端CI，不报告其通过。没有浏览器页面变更或手机实测。原始核验材料、SDK参考源码、测试数据库/工件及本地日志不提交。本轮PR以T6为base，main和生产保持不变。
