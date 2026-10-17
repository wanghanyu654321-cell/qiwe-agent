# T3 本地隔离验收

日期：2026-10-17，UTC+8。依赖T2基线`50471d3517eb6d4936e5599f1e1a31a1e107bb00`。开发分支`feat/wecom-delivery-t3`，向未合并的`feat/wecom-report-t2`提交依赖PR。源码指纹见[source-manifest.json](source-manifest.json)。

## 结果与实现

T3已在本地合成环境接通结果回复、受控恢复与重复投递处理。复用原账本、确认事务、`ReportDelivery`状态、claim与attempt CAS；新增两份机器人适配源码及同一SQLite文件中的`bot_reply_intents`元数据表，没有另建业务账本或改写Agent循环。

| 场景 | 可观察结果 |
| --- | --- |
| 文字报数→待核对卡片→确认→新查询 | 合成SDK收到对应reply；业务记录及金额来自原账本，确认回复和报告通知同步保存回执 |
| 重复消息、重复确认、独立连接竞争 | 同事件只调用一次SDK；即时确认回复与主动恢复竞争原同一claim，不各发一次 |
| 原事件编号改为另一份报告/载荷 | 业务前reservation固定来源、指纹及req_id；拒绝冲突且第二份报告仍pending，含并发反例 |
| 断线、发送前撤权、预检超时 | 明确未调用SDK时记blocked；业务仍confirmed。恢复授权/连接后，可由受控服务端recover只向原成员恢复一次 |
| 调用后异常、超时、断连、取消或关闭 | unknown；迟到ACK不升级状态，重开与新进程不盲重发 |
| SDK ACK0 | accepted、ackReqId记录关联回执；msgid可null，不伪造HTTP msgid，也不声称手机实收 |
| 非零结构化ACK | rejected，保留错误码；不自动重试。无法验证关联的帧仍unknown |
| 回执写库失败/进程中断 | 保留attempting，不把错误当“肯定未发”；后续恢复不重发，业务不回滚 |
| 原通知unknown时新查询 | 新查询独立投递成功，显示已入账及原未知状态；不重置原通知状态 |
| 权限与兼容 | 私有工厂结果才能消费；客户端改金额/对象/收件人不授权；原Home最长200可用，201由T1拒绝；旧XML/Web及1024字符HTTP msgid仍可保存 |

未完成业务的reserved行只保留去重元数据，不含可发送正文或delivery；get/claim隐藏它，同指纹重开可升级。元数据表只保留当前路由，已调用SDK的unknown/attempting/终态不刷新路由重发。不同intent不能共享req_id，避免SDK同路由队列承接迟到ACK的风险。

`recover`是受控服务端接口，读取当前可信成员及原botSource；不从调用参数接受收件人。没有新增公网入口、员工重试指令或后台循环。企微“查询 报告编号”不隐式补发原通知。当前业务前检查、提交和通知分别保留事实，不能将HTTP接收或SDK队列入队当业务完成。

## 实际验证

环境：Windows，Node.js 24.18.0。执行目录为本仓库，以下均实际通过：

- `npm test`：15文件，171测试；其中store新旧专项61项。
- `npm run typecheck`、`npm run build`：通过；三个demo均执行构建。
- `npm run demo:delivery`：真实临时Native/授权/经营三库；父进程断线确认blocked，独立子进程恢复一次accepted，再新进程零发送；另一报告unknown跨进程不重发，新查询reply一次且原unknown不变。
- `npm run demo:report`、`npm run demo`：原报数/新进程查回及开通撤权回归通过。
- 原私有工程11份manager测试显式别名使用本仓账本/解析器：123测试通过，涵盖旧XML/Web/回传。测试发送端仅合成fetch或127.0.0.1回环，不是原工程全量或真实渠道联调。
- `npm audit --audit-level=low`：0项漏洞；无新增依赖。项目无lint脚本，未配置远端CI，不把本地结果写成CI通过。
- 最终diff、当前来源哈希、公开范围及相对文档链接检查通过。没有纳入数据库、配置、凭据、课程材料或原私有Git历史。

新增行为先红后绿：sender9项、私有消费3项、装配8项，以及store/预留/guard/CAS对应失败用例。另修复大金额先除100导致末分显示误差，以及回执后读取故障时退回旧prepared的错误反馈，两项均先复现再修复；账本金额和原业务口径未改。

## 独立审查与契约

未参与实现的审查者按规格、安全、数据一致性、异常、兼容性审查，独立运行171全量测试、类型和构建。发现2项P2均已修复并以原反例复核：去重原先发生在业务后，以及合法121–200字符Home被新发送元数据错误拒绝。最终无未解决P1/P2；该结论仅针对当前本地切片。

官方契约基于固定[SDK client](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/client.ts)、[WebSocket ACK处理](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/ws.ts)、[接口类型](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/types/api.ts)和[单聊主动发送说明](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/README.md)：reply用原req_id，sendMessage单聊chatid用原userid；ACK顶层errcode和关联req_id；不要求msgid。SDK `isConnected`是属性且只证明socket open，真实装配须跟踪authenticated生命周期。主动body严格重建，不能让body.chatid覆盖目标。

## 保留边界与下一步

- 未安装/连接真实SDK、发真实消息、调用项目模型或改变生产、DNS、账号、账本数据、知识及记忆。
- ACK均为合成端口返回，不代表企微真实平台、手机实收或员工场景验收。当前只接受明确single的文字/卡片；缺失chattype暂拒绝。
- 不承诺exactly-once外部投递：attempting/unknown可能已发送，安全做法是不重发并保留查回。明确rejected也不自动重试；需核实原因后另行确定处理。
- Native、绑定、授权和外部发送不能跨系统原子撤权；发送前重验缩小窗口。同步SQLite锁等待后检查预算，不能保证立即中断锁等待。
- 不依赖旧req_id或response_url跨重启仍有效；主动恢复使用新SDK请求。真实平台窗口、配额、离线补投、连接/认证恢复及版本制品仍需T7受控验收。
- 同一SQLite文件内排重；跨文件全局路由/去重尚未实现。真实装配前必须核对原账本路径、scope与员工映射。元数据保留策略和长期规模测试留给T6。
- 下一步为T4：复用原更正、汇总和Excel服务接企微；当前不自动开展或发布这些功能。
