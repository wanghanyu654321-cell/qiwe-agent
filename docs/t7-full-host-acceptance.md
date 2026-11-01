# T7 完整宿主生命周期与Linux隔离验证

日期：2026-10-20，UTC+8。基线`9fe2de5969126685b850fd8b942f0e2417cfe03d`，分支`feat/wecom-full-host-t7`。继续已批准接入方案；原业务、账号、授权、账本、记忆和页面保留。仅本地隔离，不动生产、不发真实消息、不新增模型调用，不读取真实数据库或凭据。

## 实施与验收计划

- [x] 核实原index启动、配置、数据库初始化、queue、Web、恢复入口与关停调用方；区分原源码、overlay、实际运行副本及生产未知事实。
- [x] 在隔离源码副本组合完整必要的既有宿主overlay，执行真实main、HTTP、queue、DB和原关停；不以mock替代这些模块。
- [ ] 完整恢复验收：paused保护、恢复拒绝、跨进程查回分别记录；成功恢复、恢复后消费者及完整宿主在途执行结算仍缺必要证据，不能勾选。
- [x] 在本机Linux上用原ELF驱动运行同一完整宿主入口；实际环境和限制单独记录。
- [x] 直接专项、适用全量回归、类型与构建、来源和副作用核对；独立审查范围及遗留限制记录如下。

GitHub交付使用依赖前轮`feat/wecom-host-readiness-t7`的PR，不合并main。

## 当前基线

本轮初始工作区干净；远端main仍为`2590fa5f7dcca42a31ded5daf5ed2dbcc23da643`，前轮PR #8开放，head与本地基线一致。Docker CLI存在且配置指向本地named pipe；WSL登记Ubuntu和docker-desktop，初始均Stopped。尚不据此声称Linux容器或完整宿主已经运行。

## 实现边界

新增`integrations/native/full-host-candidate.mjs`按原Native和既有overlay全树hash核验，使用不可变转换器快照在临时目录组合207份候选模块，保留既有完整宿主、Web、queue、DB boot/rejection/inventory。定向scheduler/claim复用前轮实现；不修改原N/O目录。`verify-full-host.mjs`保留原main自启动，只追加用于观测的queue/gate导出；审计分别记录转换前hash、追加后的实际index以及测试、配置和工具hash。

完整宿主验证仅使用一次性cwd、HOME、合成session secret和原schema临时SQLite。原config、main、Web、HTTP路由、queue、DB、gate、scanner和shutdown均实际执行。没有启用渠道账号或容器岗位运行器；子进程、UDP、DNS及非本测试loopback连接由测试守卫拒绝。Windows守卫不是通用文件系统沙箱；Linux另用断网、只读rootfs及只读受控源码/依赖挂载限制进程。原静态前端资源未复制，不代表页面或WebSocket帧业务验收。

恢复前原消费者保持暂停。测试保存`promoting`消息、已到期任务和失败通知的完整原行，检查原queue接收任务后不执行、原main关停关闭Web/queue/DB，并重新打开同一SQLite核对。跨进程验证的最终结果以本轮runId证据为准，不能把同进程模块重新加载算作进程重启。

## 已核实的恢复缺口

原`scanAppointmentBootInventory`是元数据扫描器：固定加入`NON_DATABASE_RESIDUE_UNVERIFIED`、`EXTERNAL_WRITERS_UNVERIFIED`、`WRITER_COVERAGE_INCOMPLETE`、`OPAQUE_RUNTIME_METADATA_UNVERIFIED`，所有数据库/文件记录仍为`blocked`，最终`complete=false/safe=false`。原Web review实际返回409 `review_incomplete`，没有恢复票据。新库经原初始化也存在`execution/router_state`与`resource/billing_plans`，不能删行或直接当作无历史安全库。

原恢复协议要求：当前有效管理员及精确Origin → 服务端review快照/票据 → 再扫描一致 → claim → prepare → 同连接同步事务重验身份/快照/权限并写审计 → COMMIT后ready → 原drain。客户端不能传入inventory或safe。未知副作用、通知状态、外部writer或不透明元数据必须继续阻塞。

另一个装配缺口：原paused overlay跳过启用渠道连接，而prepare又要求启用账号已经连接；真实连接前的准备入口仍需核实，不能将`isChannelAccountConnected`伪造为true。恢复本身也不证明Docker runner和模型可用。

本轮保留原collector，未新增合成safe端口、强制ready或生产恢复开关。因此**成功恢复、完整宿主恢复后的任务执行/消费者顺序、在途执行关停结算未验收**。前轮定向执行与局部门禁测试通过不能补齐这些证据；企微→完整宿主的实际运行接线也仍待恢复条件闭合后验收。

## Linux环境事实

本机Ubuntu WSL实际为Ubuntu 26.04、x86_64、Node 22.23.2 / ABI127；本地Docker Desktop Linux引擎29.8。验证容器采用本机已有官方镜像RepoDigest `node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`，实际用户空间为Debian12，使用`--pull=never`。这些是本机环境，**生产Linux发行版、Node、驱动、进程和数据状态均未知**。

原better-sqlite3 12.11.1 ELF SHA256为`df9fbd0d061f360d81fb51e265c53c9605020bd68219e34f33c07c85de15719a`；Linux准入检查lock SRI、package metadata、全部lib、loader及二进制身份，再真实加载。原Agent容器的Node24 Dockerfile不能用作Native宿主Node/ABI证据。

Linux工具仅接受经白名单及逐文件hash封存的专用副本，排除data/config/store、环境、凭据、`.git`及symlink；挂载只读且不包含Docker socket。唯一运行盘是tmpfs。使用本轮唯一name/label核实并清理专用容器，不操作现有容器。详见[Linux入口](../integrations/native/README-linux.md)。

## 验证结果

所有命令在本仓库执行，公开基线为上文SHA；本轮新增工具的最终tree及审查在提交前记录。

| 命令 / 场景 | 实际结果 |
| --- | --- |
| `npm test` | 39文件 / 519项通过 |
| `npm run typecheck`、`npm run build` | 通过 |
| `node --test integrations/native/prepare-native-sqlite.test.mjs integrations/native/verification-options.test.mjs` | 6项通过 |
| `node node_modules/vitest/vitest.mjs run --config .local/t5-20261018/legacy-vitest.config.ts` | 原兼容17文件 / 148项通过 |
| 构建后`node examples/local-{identity,report,delivery,operations,tasks}.mjs`（逐文件实际执行） | 5个合成演示通过，包含各自的跨进程查回；非完整Native恢复 |
| Windows完整宿主`verify-full-host.mjs N --host-overlay O --sqlite-driver PREPARED --typecheck` | 候选类型检查通过；boot/restart各1项通过，独立PID32176/45236，同库同业务快照、9类HTTP拒绝、原关停及DB重开通过 |
| Linux `verify-full-host.mjs N --host-overlay O --typecheck`（断网只读容器） | 原ELF驱动、完整候选类型检查通过；boot/restart各1项通过，独立PID44/81，同库查回及全部拒绝/暂停保护通过。首次导入30秒超时、后续1.5GB下类型检查V8 OOM均保留为环境失败；仅将测试时限调整到120秒、专用容器内存提高到4GB后通过，检查项未删减 |
| Linux局部targeted / readiness / driver组合 | 6+7+4=17项通过，仅局部组合 |
| `node --test integrations/native/linux-runtime.test.mjs` | Windows 8项通过、1项Linux真实驱动用例明确跳过；Linux 9项实际通过，含原驱动加载及JS/ELF/loader篡改执行前拒绝、清单marker目录/符号链接拒绝 |
| 完整宿主故障注入负控（仅一次性副本） | 恢复旧DB boot无条件重置后，同一测试因`promoting→queued`及更新时间变化而exit1；正式工具没有此开关、N/O原件未改 |
| verifier准入反例 | 不存在source/overlay均exit1、未启动main、各自唯一audit标为failed，不沿用旧成功证据 |
| lint / CI | 项目无lint脚本；当前仓库未配置CI，未声称通过 |

Windows本次runId为`2026-10-20T12-00-36-281Z-1501f62e-a680-4564-9e1c-5c1316d31bf7`；本机`.local/t7d/<runId>/full-host-{audit,evidence}.json`记录两轮，实际test/verifier/builder hash绑定执行时源码。暂存前仅对3份新文件整理EOF多余空行，并按仓库约定归一化LF；规范化后与执行源码逐字一致，raw执行hash不冒充Git blob hash。准入反例记录在`.local/t7d/full-host-admission-controls.json`；故障注入的精确差异与失败日志为同目录`legacy-db-boot-negative-control-*`。这些合成运行原始日志不进入Git；公开记录不包含真实数据。

Linux runId为`2026-10-20T12-01-42-313Z-c65195d6-a6cf-4099-85ce-fec4abd3620e`。本机证据在`.local/t7d-20261020/linux/full-host-4g-final.log`；`container-isolation-4g.json`是实际运行中按本次name/label读取的inspect白名单结果，确认network=none、rootfs只读、唯一`/input`挂载RW=false、capabilities全移除、禁止提权、4GiB/2CPU/256PID，没有读取或输出环境变量。启动前置清单的marker类型检查补强单独通过工具测试，不改变已运行的Native、驱动或容器参数。

## 独立审查与副作用核对

未参与实现的审查者分别核对规格及实现，读取实际Windows/Linux证据及执行文件hash。已处理：同进程重载冒充重启、网络重载/IPv6/socket漏口、只读挂载下证据目录、失败运行沿用旧证据、准入失败停留preparing、Docker超时残留与自动删除竞态、清单marker跟随符号链接风险。最终暂存版本与来源清单、换行归一化及敏感内容在提交前再次核对；独立审查不把尚未实现的成功恢复视为通过。

本轮仅增加隔离验证工具、测试和文档，没有修改`src/`业务能力、账号、授权模型、账本schema、页面、原N/O或生产配置；没有真实企微/模型准入。原驱动、源码及依赖只用于本机受控副本，未进入Git。专用容器已退出清理；本轮启动了本机既有WSL/Docker Desktop以供隔离验证，未改全局资源配置或操作其他容器。

## 下一步

先补原恢复清单的四类可验证证据和历史记录状态/关闭规则、渠道准备流程，再在同一完整宿主中验证正常恢复、消费者启动和在途结算；仍先用隔离合成数据。生产启动、真实成员及账本路径核实、手机实收和模型评测需要另行具体授权，本轮不执行。
