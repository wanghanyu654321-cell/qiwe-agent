# T7 完整 Native 宿主隔离验证

此入口在临时源码副本中实际运行原 `index.ts` 的 `main()`，启动真实 Hono/Node HTTP、WebSocket server、原 SQLite、GroupQueue、WebDeps、任务路由和 O 的完整 boot/warm/cold/Web/rejection/consumer/assembly/inventory 栈。它补充旧 `host-readiness` 的局部证明；旧套件不能替代本入口的结果。

2026-10-21新增[恢复核对准备](../../docs/t7-recovery-preparation-acceptance.md)：管理员`POST /api/appointment/maintenance/inspect`复用原鉴权/Origin/资源ACL，只返回固定证明状态和类别、渠道、队列计数。原project配置漏项通过`project-residue-overlay.mjs`扩展原扫描器；没有safe/ready许可或渠道连接。该入口只装配在本地合成候选，不代表已部署。

```powershell
node integrations/native/verify-full-host.mjs $NROOT --host-overlay $OROOT --sqlite-driver $PREPARED_DRIVER --typecheck
```

Linux 在固定原 ELF、ABI 和依赖通过 `linux-runtime.mjs` 核验后省略 `--sqlite-driver`。使用 `README-linux.md` 的断网、只读容器，不把 Windows 适配驱动称为原 Linux 驱动。只读源码挂载时设置 `QIWE_EVIDENCE_ROOT` 为容器可写临时目录；最终合成证据也输出到 stdout。

## 执行与证据

- 全 N 非测试 TypeScript 树 SHA-256：`8611519397c78b1f5d9591ae18ea2c5d1c399aab3d63b9ea5311ebd8c18b0bad`。
- O 源码/变换/fragment 树 SHA-256：`054aff69be686477c6df8acf8f84810d43aba538a3643fcca2a2f32d1f5e11e0`。
- 树身份涵盖排序后的相对文件名和每文件原始字节 SHA-256。输入变化立即拒绝；所有原始 N/O 文件只读。执行 O helper 的校验快照，fragment 也来自已核验字节。
- 临时副本共 208 个文件，其中 8 个 O runtime 模块和1份本仓库脱敏DTO。T7 scheduler 采用旧工具同一已核验组合；DB 保留完整 O 栈，仅移入独立核验的 T7 精确 run claim 函数。原inventory复用descriptor遍历补项目`.env/config`，共享原总行/字节/截止预算，保留原data键和全部阻断语义。
- 仅向临时 index 追加两个观测 export。保留原 `main().catch(...)`、真实 Web 启动及 shutdown 函数；audit 同时记录组合前 hash 和追加 export 后的实际 index hash、测试、配置、verifier 与 builder hash。
- 每次运行创建独立 `runId` 证据目录，先写 `preparing`，失败写 `failed`，双进程均通过才写 `passed`。旧运行的 evidence 不代表新运行通过。

verifier 启动两个独立 Vitest OS worker 进程，共用同一新建临时 cwd/data。第一轮创建合成记录并保存 messages/tasks/runs 的完整快照；第二轮不再次 create/store，以第一轮快照验证重启前后 SQLite 原记录一致。两轮实际 worker PID 必须不同，每轮都运行原 main、真实 loopback HTTP、原 SIGTERM shutdown 和 DB reopen。

验证覆盖：

1. 原 Web server 绑定随机 IPv4 loopback 端口；维护状态为 paused，真实未认证请求 401。
2. 原 review 因不完整 inventory 返回 409；wrong/missing Origin、当前 member 角色、expired/missing session、未签发票据、未确认、未知字段和超限 body 均按原契约拒绝。
3. 每类拒绝后 gate 仍 paused、无 `appointment_restore_committed` 审计、合成业务快照保持。
4. 原 queue 可接收暂停任务但不消费；promoting 输入不被 boot 重置为 queued，过期任务不被 materialize，失败通知不被 pump。
5. 原 shutdown 关闭 Web、queue、SQLite；第二个 OS 进程再次启动并查回第一轮原快照。
6. TCP/Unix/DNS/UDP/child-process 防护含实际触发的反例。控制反例完成后清空防护计数，再报告宿主执行期间 `observedNoBlockedAttempts`。
7. 管理员inspect读取原scanner与原进程队列/渠道投影；重启后可重复读取。未授权、异源、跨Owner、停用、强制改密、无效会话和异常观察端口拒绝。gate调用透传观测确认检查不调用beginReview/publish/claim/write/commit；原业务快照及审计状态保留。
8. `project-residue.test.mts`实际调用原scanner/真实SQLite，Linux覆盖项目配置、嵌套文件、缺失、symlink/替换、深度预算和读失败；Windows明确跳过Linux场景，只验证不支持时关闭。文件内容不被扫描或回传。

## 隔离范围

子进程环境采用明确白名单：新建临时 HOME/cwd/data、固定合成 session secret、禁用 plugin autoscan、无真实账号配置或 `.env`。未 mock main、Web、queue、DB、gate、scanner、runner 或 IM manager。

TCP 仅准本次真实 HTTP fixture 的 `127.0.0.1` 端口，拒绝 Unix socket/named pipe、其他地址和端口；listen 所有使用的重载强制 IPv4 loopback。DNS 只准数字 loopback lookup，resolve/reverse 与 UDP bind/connect/send 均拒绝；child_process exec/execFile/spawn/fork 家族均拒绝。定时器只透传记录并在测试收尾清理。原 `process.exit` 由测试观测，原 shutdown 函数执行完毕后由 Vitest 结束 worker。

这些 JavaScript 防护不等于通用文件系统或 native addon 沙箱；Linux 额外依赖实际 `--network none`、只读 rootfs/源码与临时写入根。结果只声明观测范围内未出现被阻断的宿主尝试，不宣称任意 native 代码都不可能产生副作用。

## 未完成的验收

原 `scanAppointmentBootMetadata` 只观察 metadata，每条记录仍为 `blocked`，最终始终 `complete:false, safe:false`。四项原 blocker 为：

- `EXTERNAL_WRITERS_UNVERIFIED`
- `NON_DATABASE_RESIDUE_UNVERIFIED`
- `OPAQUE_RUNTIME_METADATA_UNVERIFIED`
- `WRITER_COVERAGE_INCOMPLETE`

即使新数据库，原 migration 仍生成 `execution/router_state`，另有 sqlite observation 和 billing seed。Windows 还明确返回 `RESIDUE:UNSUPPORTED_ROOT`。本入口没有伪造完整 inventory、绕过 review/claim/final/同步 commit、添加可信恢复证据适配器或设置 ready。

因此：成功恢复、恢复后仅授权任务执行、完整宿主在途 provider/runner 的真实等待结算尚未验证。旧 readiness 局部测试中的 fake provider/runner 等待证明不能拼接为完整 main 的成功恢复证明。要继续完成，须先提供原受控 writer、逐记录恢复证据及外部义务结清契约。

本入口未复制 `web/dist`，静态站点目录会有 serveStatic 提示；只验证 API 与 WebSocket server 启动，不代表浏览器 UI 或 WebSocket 消息收发验收。

本轮是验证 harness 的补齐，没有声称修复原生产业务缺陷。早期 fixture 参数及 queue 接收语义断言的错误是测试修正，Linux 导入超时是环境结果，均不算业务 RED。

另做过一次本地故障注入负控：仅在 `.local` 临时 verifier 生成的候选 DB 副本中，把 O 的 boot 保护条件替换为 `if (true)`，恢复旧 N 的无条件 promoting 重置；同一完整宿主测试真实失败（exit 1），记录从 `promoting` 变成 `queued`，`delivery_updated_at` 也被改写。移除该临时故障注入后的正式工具通过。这证明当前场景会抓到缺失 DB boot 栈；不是新修复生产 bug 的 TDD 声明。精确临时差异、前后 hash 与失败日志保存在本地 `.local/t7d/legacy-db-boot-negative-control-*`，不提交原源码副本。
