# T3 本地隔离实施约定

日期：2026-10-17。依赖T2 `50471d3517eb6d4936e5599f1e1a31a1e107bb00`；T2 PR尚未合并，本阶段单独分支并向T2分支提依赖PR。

目标：复用原通知状态、T1授权和T2业务处理，接入机器人回复计划的受控发送，覆盖失败恢复及重复投递。本阶段只有显式合成SDK端口，不安装/连接真实SDK、不发真实消息、不调用模型或修改生产。

1. 保留`ReportDelivery`与原确认事务，`prepared/blocked → attempting → accepted/rejected/unknown`。只有明确未开始发送的blocked可再次尝试；attempting、unknown、accepted、rejected均不自动重发。已提交业务不会因通知失败回滚。
2. 在原ManagerStore同一SQLite文件添加最小`bot_reply_intents`元数据表，以平台corp/bot/member/messageId产生稳定主键。原单条report.delivery不足以记录待核对卡片及多次查询，不能依赖进程内Map或SDK队列去重。业务前先持久预留指纹/归属/req_id，冲突在业务前拒绝；reserved行没有正文或delivery，不可claim。业务完成后升级回复计划，崩溃时同指纹可继续。表中不复制业务账本。
3. 确认即时回复与后台确认通知恢复共用原delivery claim；事件回复与原通知在同一事务claim/finish，防止两个通道双发。新的明确查询是独立回复，不篡改原unknown/attempting状态。
4. 回调回复使用原事件req_id；主动恢复仅向原botSource.memberId单聊发送，并核对当前绑定、本人Home、账号/门店/岗位及原报告归属。卡片客户端、序列化结果和持久记录不能授权发送。T2工厂登记私有回复快照，T3只消费本工厂签发对象。
5. 复用既有发送器的限时、取消、发送前核验及未知结果保守处理；不复用企业应用HTTP协议到机器人。官方SDK ACK使用顶层errcode及关联req_id，不要求HTTP msgid。accepted只表示平台ACK，不表示手机实收。
6. SDK调用前先持久化attempting。断线预检、撤权、预算耗尽等明确未发送记blocked；调用后超时/断连/模糊错误记unknown。ACK写库失败或进程退出保留attempting，恢复不盲重发。迟到结果不覆盖终态。显式新查询可查回已提交业务。

实施与验收：持久回复表及原claim守卫 → 合成SDK发送适配 → T2受控消费及T3装配 → 重开/新进程/并发/失败验证 → 旧XML/Web回归 → 独立规格与安全审查 → GitHub提交。先有效失败测试再最小实现，不新增全能调度器或后台循环。兼容T1合法Home上限200，发送目标不从body.chatid取值；sender严格重建主动发送body。

局限：Native/绑定/授权/发送多系统不能原子撤权；发送前重验缩小窗口，不宣称绝对消除。群聊、文件、模型、SDK真实资格/窗口/配额及手机验收留待后续阶段。
