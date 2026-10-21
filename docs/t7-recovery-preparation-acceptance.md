# T7 恢复核对准备：实施及验收

日期：2026-10-21，UTC+8。基线`6045b3fafcf359abf3850afe2e3c1386402465c5`，分支`feat/wecom-recovery-preparation-t7`。继续既定T7；仅本地隔离合成验证，不动生产、不发真实消息、不新增模型调用，不读取实际DB/配置/凭据。原账号、账本、授权、Agent、页面不重做。

## 已确认契约与边界

原四类proof无实现分类器；不能从状态词、空目录或本进程队列全零授予恢复。Native渠道reload受paused守卫，连接又会写账号状态、补收、同步和处理卡片；把它塞进restore prepare既有副作用又使原review指纹失效。企微SDK连接生命周期独立于Native IM，不能混同。保持原prepare为核验，不增加特权连接或safe/ready端口。

基线缺少管理员可用的阻塞诊断；原review仅409。原文件扫描还遗漏项目根`.env`与`config/`（原load-env/config实际使用），不在data/env、data/config之内。队列getStatus仅瞬时投影，不能证明retry、IPC、旧Runner或全部回调结清。

## Task 1：补已知项目配置的只读残留覆盖

文件：新增`integrations/native/project-residue-overlay.mjs`、`project-residue.test.mts`；根执行者负责在`full-host-candidate.mjs`内接入原扫描。

接口：`applyProjectResidueOverlay(source: string): string`，只对已核验完整候选的`appointment-boot-inventory.ts`精确锚定转换。复用原collectResidue，增加project作用域，不另写文件遍历器；由原扫描器以可信`path.dirname(dataDir)`调用，同N配置。Linux继续用descriptor-relative、O_NOFOLLOW、共享总预算/截止时间及前后元数据检查枚举`.env`与`config/`；不读文件内容，不输出路径/文件名/密钥。项目记录采用独立hash命名空间，全部blocked；unsupported/错误/未知项必须阻断。不增加safe/complete许可，追加原扫描而不消除任何原blocker。

- [x] 合成文件、缺失、symlink/目录替换、depth预算/读失败、不泄漏正文及文件字节保持测试；原scanner出现目标RED后最小实现。共享行数/字节预算由同一闭包复用核实，未另做跨data+project耗尽行数/字节的运行反例。
- [x] 在完整Native候选中实际接入、重启复验；Windows明确不支持，不冒充Linux完成。

## Task 2：管理员只读恢复检查

文件：新增`integrations/native/recovery-inspection.ts`及`recovery-inspection-overlay.mjs`、`tests/recovery-inspection.test.ts`；扩充现有`full-host.test.mts`，根执行者整合builder。

新增`POST /api/appointment/maintenance/inspect`，严格空JSON、现有当前管理员/原Origin/全部资源ACL，复用原snapshot和scanner。返回固定四proof的unverified/not_reported、全量各类记录数量、原阻塞总数及当前队列/渠道的部分观察；不返回原标识、路径、正文、账号列表、secret_ref或原始错误。`restorePermission:'not_issued'`，不签票、不beginReview、不失效/复活票据，不调用prepare/drain/reload，不改gate或业务状态。

可选可信同步`readRecoveryObservation()`由原index装配，读取原queue.getStatus与listEnabledChannelAccounts/isChannelAccountConnected，仅输出安全数量。缺此端口时inspect明确503；旧review/restore调用方保持兼容。只称瞬时部分观察，retry/warm/旧Runner/外部writer仍unknown，绝不将全零视为证明。

- [x] 实际原main/HTTP上验证inspect原404→新增后200的行为RED/GREEN。
- [x] 单元验证未知类别/恶意字符串脱敏、缺证不升级verified、不修改入参、不暴露可变原对象。
- [x] 实际HTTP验证无认证、Origin、member、跨Owner、强制改密/失效账号等拒绝；无审计恢复、无消费或业务变化；重启后仍可检查。

## Task 3：组合验证、独立审查与GitHub

- [x] 复用完整宿主双进程verifier，在Windows及断网只读Linux以原驱动验证候选类型和实际接线；只假外部I/O，不假main/HTTP/DB/queue/scanner。
- [x] 适用全量测试、类型/构建、92项源码清单、暂存diff/敏感内容及独立规格/质量审查通过。
- GitHub交付采用依赖PR #9的分支PR，不合并main；发布状态以本分支PR为准。恢复许可/连接/在途结算证明仍缺，不计作通过。

## 验证与当前状态

已实现并完成下列本地验证及独立审查，无阻塞项。只读审计位于本机`.local/t7e-20261021/{channel,residue}-audit.md`，不是运行验收。不复制私有源码、凭据或原始业务数据到Git。

所有命令在`qiwe-agent`根目录执行，基于上述HEAD加本轮变更；日志位于本机`.local/t7e-20261021/`。下列Native源码路径为本机已核验N/O来源，参数要求显式绝对路径，不接触其运行数据。

| 验证 | 实际命令及结果 |
| --- | --- |
| 公开回归 | `npm test`：40文件522项通过；`npm run typecheck`、`npm run build`通过 |
| 验证工具回归 | `node --test integrations/native/prepare-native-sqlite.test.mjs integrations/native/verification-options.test.mjs integrations/native/linux-runtime.test.mjs`：14通过、1项Linux专属跳过 |
| 既有调用方兼容回归 | `node node_modules/vitest/vitest.mjs run --config .local/t5-20261018/legacy-vitest.config.ts`：17文件148项通过（alias当前manager/training）；不是全私有产品验收 |
| Windows完整候选类型与宿主 | `node integrations/native/verify-full-host.mjs ABSOLUTE_NATIVE_SRC --host-overlay ABSOLUTE_OVERLAY_SRC --sqlite-driver ABSOLUTE_PREPARED_DRIVER --typecheck`，原12.11.1驱动JS及匹配Windows二进制；候选类型通过，`windows-final.log`两个phase各2通过、6项Linux专属跳过 |
| Linux完整候选类型与宿主 | `node .local/t7e-20261021/run-linux.mjs --typecheck`，本机现有Docker镜像Debian12/Node22.23.2/原Linux ELF驱动；候选类型通过，`linux-final.log`两个phase各7通过、1项Windows专属跳过 |
| 补充错误反例后的最终测试版本 | Windows同一verifier不带`--typecheck`、Linux同一runner不带`--typecheck`：`windows-extra-errors.log`两个phase各2通过/8跳过，`linux-extra-errors.log`两个phase各9通过/1跳过。只追加`.env` symlink和合成EACCES测试，运行实现未改变 |

最终Windows runId `2026-10-21T09-09-25-717Z-6b1c10e4-f957-4734-b37c-132072f4ec8e`，进程19556/2764；Linux runId `2026-10-21T09-09-28-676Z-0291ec87-072e-4dab-b0d9-55f5f27cc0e5`，进程37/81。各自boot/restart使用不同OS进程和同一合成SQLite快照。审计含208个实际组合模块hash，校验原N/O全树身份；不是将不同suite拼成同一请求端到端。

Linux使用已缓存固定digest镜像，无拉取；实际容器`network=none`、只读rootfs及只读受控源码挂载、独立tmpfs、cap-drop ALL/no-new-privileges。未挂载真实data/config/env。首次Docker未运行导致的环境失败单独记录，不计作需求RED；原scanner漏项及HTTP404才是目标RED。初版跨Owner测试创建第二管理员造成重启多一个Home的夹具问题已改为临时切换原合成资源owner并恢复，最终复验通过。

候选接口`POST /api/appointment/maintenance/inspect`请求为`{}`；沿用原session/Origin/当前管理员/全部资源ACL。成功200仅返回固定类别计数、四类未核实证明及本进程部分观察，始终`restorePermission: not_issued`。无权限、非法请求沿用原拒绝；观察端口缺失/非法/异步/抛错返回503，旧review仍按原规则拒绝。此接口只在临时组合候选中装配，未部署到生产。

限制：原collector仍永久incomplete，尚无可用恢复票据，未验收正常restore、恢复后消费者和真实企微连接。inspect不失效既有有效票据由独立控制流审查及真实gate调用监视核实，未执行成功review→inspect→restore场景。队列观察不能证明重试计时器、旧Runner或外部写入者结清。静态前端资产不在候选中，本轮验收HTTP/API和WebSocket服务启动，不验收页面。无lint脚本/CI配置，不宣称lint或CI通过。
