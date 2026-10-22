# D2 原消息受理与企微查回

日期：2026-10-22。开发基线 `5ee3ee019ee9afe93acc52097c04f86736903ddb`，分支 `feat/wecom-conversation-intake-d2`。执行依据为已确认的 [roadmap](roadmap.md) 和 [对话接线计划](wecom-native-conversation-plan.md)。本记录只覆盖 D2 本地隔离受理与查回，不代表真实企微上线。

## 交付范围

员工选择已开通岗位后，发送自然语言需求。通过显式注入的本地合成端口，需求成为原 Native `messages` 表中的一条真实输入，并在同一 SQLite 事务保存受理来源关系；企微回复受理编号，`查询对话 编号` 读取同一事实。重复消息返回原输入 UUID，不创建新输入；原消息内容被改动或丢失时，不把残留受理记录冒充有效结果。

本轮复用原消息保存函数、D1 岗位空间来源、统一授权、原回复意图和发送能力。没有重写 Web、Agent、技能解析、队列或账本，没有安装依赖。候选数据库增加一张 `wecom_conversation_receipts` 表，候选 schema 从69到70，升级仍执行原备份门禁；生产及原源目录均未修改。

原宿主会自动消费 `messages`，因此 D2 仅用于没有轮询器/runner 的原服务合成夹具。默认完整宿主候选不启用 D2 schema；专用组合验证显式启用，原 scanner 仍将新增表判为 `UNKNOWN_OBJECT` 并拒绝恢复。完整宿主的启动/重启回归只证明原路径兼容，不证明 D2 已在该宿主运行。

## 员工能看到的结果

| 操作 | 本地组合验证的结果 |
| --- | --- |
| `岗位 内容营销` | 使用原账号已授权岗位与本人非 Home 空间，无需员工重新装配 |
| 发送自然语言需求 | 保存需求并返回受理号；明确“执行尚未接通，本次未生成答案” |
| `查询对话 受理号` | 返回原岗位、同一受理编号；退出或切换岗位不搬迁已保存输入 |
| 重复消息、相同编号不同内容 | 同一输入不重复保存；冲突内容拒绝 |
| 提交响应丢失 | 提示受理结果待核实，通过已知编号查回，不盲目重新提交 |
| 原报数消息在选岗后重投 | 沿用原业务身份；不另写一条对话输入 |
| 对话受理未知后重投类似报数的文本 | 保持查回提示，不回落报数、不产生账本副作用 |

## 验证与审查

执行位置为 qiwe-agent 根目录；版本为上述基线加本次最终 diff。测试只使用合成账号/消息/临时数据库；外发替身只验证消息载荷，没有真实企微连接、手机实收或模型输出。

| 验证 | 命令与实际结果 |
| --- | --- |
| 公开回归 | `npm test`：42文件562项通过；`npm run typecheck`、`npm run build`通过 |
| Native边界专项 | `node node_modules/vitest/vitest.mjs run --config integrations/native/conversation.vitest.config.mts`：3项通过 |
| 原验证工具 | `node --test integrations/native/prepare-native-sqlite.test.mjs integrations/native/verification-options.test.mjs integrations/native/linux-runtime.test.mjs`：15通过、1项平台跳过 |
| Windows D2组合 | `node integrations/native/verify-conversation.mjs N源码绝对路径 O源码绝对路径 本机已验证驱动绝对路径`：候选类型检查通过，两个独立进程各2项通过 |
| Linux D2组合 | `node .local/d2-20261022/run-linux.mjs --conversation`：原Linux驱动、候选类型检查、两个独立进程各2项通过；封存源码只读、无网络、本机已有固定镜像，无拉取 |
| Windows原宿主兼容 | `node integrations/native/verify-full-host.mjs N源码绝对路径 --host-overlay O源码绝对路径 --sqlite-driver 本机已验证驱动绝对路径 --typecheck`：候选类型检查及D1服务3项通过；boot/restart各8通过、8项平台跳过 |
| Linux原宿主兼容 | `node .local/d2-20261022/run-linux.mjs`：候选类型检查及D1服务3项通过；boot/restart各15通过、1项平台跳过；不作为D2原宿主执行证据 |

N/O为[来源记录](source-provenance.md)中的原源码及overlay，只读全树哈希分别为`8611519397c78b1f5d9591ae18ea2c5d1c399aab3d63b9ea5311ebd8c18b0bad`、`054aff69be686477c6df8acf8f84810d43aba538a3643fcca2a2f32d1f5e11e0`。日志在本地`.local/d2-20261022/`，原合成数据不提交Git。

Windows D2 runId `f0997843-a5b5-4678-90b7-b4e08251e9a9`，PID22356/12480；Linux D2 runId `1a54afdc-cc36-4a53-b007-b71bdb83a231`，PID44/77。两者同一候选DB哈希、实际测试/适配源码及23个公开支持模块哈希核对通过；第二进程重新打开原存储，不重新创建授权、选岗或受理样例。原`initDatabase()`仍有启动维护写入，不能称为整个进程只读。

Windows原宿主runId `2026-10-22T13-15-03-320Z-f0c84f08-148f-4d7b-8fad-0f66f6a55597`，PID33140/4364；Linux原宿主runId `2026-10-22T13-21-58-429Z-48f6f8c8-6703-43a2-ba95-98e0f29d30f9`，PID77/137。两者208个候选模块和24个公开支持模块哈希已核对。

组合夹具覆盖离线SDK事件→原授权→原Profile/岗位空间→原SQLite消息/受理事务→原回复载荷。首轮及重启进程均从SDK入口重新发送`查询对话`，要求收到一条对应新`req_id`的回复、返回原受理号，且没有新增Native输入；不能以数据库直接读取或旧回复充当查回证据。另验证重复/冲突、撤权/错误门店/岗位、取消预算、暂停、同事务回滚、提交后响应丢失、原消息被改动后拒绝查回。合成v69库升级遇备份失败时保持原数据及版本，备份成功后v70保留原记录。

独立审查发现并复现“受理未知的对话重投误落报数”，修复后永久回归及审查者复现用例均通过。完整宿主回归曾因默认加载D2新表而丢失D1扫描明细，改为仅专用候选显式启用，保留原测试断言及新增表拒绝规则。Linux首次因Docker未启动未执行测试，启动现有本地Docker后，又发现证据目录位于只读挂载；验证器改为复用原`QIWE_EVIDENCE_ROOT`约定，最终D2组合通过。这些失败记录保留，不冒充通过。

独立审查未发现剩余P1/P2，记录及最终文件SHA256清单保存在本地`.local/d2-20261022/independent-review.md`和`independent-review-hashes.json`。无lint脚本，不宣称lint或远端CI通过。未修改生产、发送真实消息、调用项目模型或迁移真实数据库。

## 剩余工作

D3 需要把已保存输入接到原队列和原会话，在实际启动及历史/追问加载时重验权限，关联真实执行，并支持精确取消。D4 验证原岗位技能与工具装配；D5 关联持久答案、结果回复和失败查回。T7 仍须处理完整宿主恢复证明及新增受理关系的原扫描规则。当前不能对员工承诺“机器人已能完成自然语言工作”，也不能把本地回执当成实际完成结果。
