# T7 媒体协议、宿主门禁及原驱动验收

日期：2026-10-20，UTC+8。基线`f8673f351828d9f431fc2a108674e7ed0f19b095`，分支`feat/wecom-host-readiness-t7`。继续上一轮已批准的接入方案，仅本地隔离，不动生产、不发真实消息、不新增模型调用；原私有源码、依赖、数据库和配置保持只读。

## 实施与验收计划

- [x] 媒体：从官方文档原文核对分片起点、字节大小、分片数、MD5和回执。已有实现正确则保留；补协议边界回归及可追溯证据，不为形式更换SDK或重写上传。
- [x] 宿主：核实原BootGate、overlay和index中的同一门禁实例接线；在临时源码副本组合原overlay与定向补丁，使用真实BootGate按原恢复流程测试，不能制造ready门禁绕过暂停。
- [x] 原驱动：识别原包版本、系统/架构/ABI问题；只在隔离目录装配同版本官方平台二进制，实际运行原sqlite-compat及原db/scheduler。不改原node_modules，不升级项目驱动或将替代驱动测试当原驱动验收。
- [x] 组合：原授权事务、真实门禁、原queue、原SQLite驱动与候选调度器一起跑；仅runner/发送/配置为合成对象。验证暂停、恢复、撤权、繁忙、取消、幂等和无关任务不变。
- [x] 交付：直接专项后执行适用全量测试、类型、构建及既有回归；独立规格和质量审查最终版本；更新来源及当前状态后提交依赖上一轮的PR，不合并main。

## 当前核实事实

- 原项目本轮基线测试：39文件515项通过。
- 官方媒体页面`https://developer.work.weixin.qq.com/document/path/101463`可通过普通HTTPS直接读取，前轮页面读取失败不代表内容不存在。2026-10-20读取的完整HTML SHA256为`5980825b2bc9958f7c602506dd4f03d6ecaa0da9fd4a5d286a80ea3833c3a603`；正文明确分片从0开始。原始网页仅保存在本地忽略目录，不提交全文。
- 原Native实际安装better-sqlite3为12.11.1；当前Node为Windows x64 ABI137，原二进制为Linux ELF，属于平台不匹配。后续原驱动验证不能仅重跑替代驱动测试。

## 最小改动与实际证据

媒体仍复用原SDK公开reply、请求号与持久通知状态，分片继续零起；补文件最少5字节、保守20,000,000字节及文件名UTF-8上限校验。三项有效RED先复现越界请求已经发出init，再最小收紧；额外524288字节整片和256字节UTF-8名称正例初绿，属于已有正确行为验证。详细差异见[官方媒体合同核验](wecom-media-protocol.md)。

原驱动准备脚本只显式下载同版本官方npm包与Windows x64 ABI137预编译包，校验npm SRI、GitHub发布asset digest、解出二进制固定SHA、包元信息及全部原lib JS一致。实际加载前再次离线验证，不能只信本地manifest。所有文件仅写新临时目录，原Linux二进制不替换；不执行install/rebuild或包生命周期脚本，不新增项目依赖。

真实BootGate初始paused，paused下beginWrite仍可能给票，因此必须同时检查isPaused。复用原review→claimRestore→enterFinal→同步commitRestore流程，测试中review证据明确为合成，不构成真实恢复许可。原overlay只在临时、完整来源hash匹配的源码快照上组合；旧overlay只认未修改输入的身份，因此仅增加精确已核实T7定向输出的输入身份，其余原检查保留。未修改原私有文件。

同一公共port用例现在实际组合：原授权事务→真实BootGate→候选scheduler→原N GroupQueue→真实better-sqlite3/原sqlite-compat及db→合成runner。paused无run写，正规恢复后执行指定A、繁忙预启动取消、撤权和原B–E记录不变。另用真实原可靠性恢复模块验证暂停时不改记录/不调合成provider，以及stop必须等provider实际settle后才释放写票。无真实模型或发送。

有效宿主RED：仅前轮定向补丁+真实gate时，paused启动原scheduler会改变到期任务、创建backfill/missed run、领取失败通知；原recovery stop也不等待provider物理settle。组合原门禁overlay后7项GREEN。验证脚本增加明确模式参数；未知、重复或矛盾参数失败关闭，不能静默回落到替代驱动。脚本参数与归档/加载准入共6项node:test通过，测试无需下载。

## 实际验证

| 位置／命令 | 结果 |
| --- | --- |
| 本项目`npm test` | 基线39文件515项；最终39文件519项通过 |
| 本项目`npm run typecheck`、`npm run build` | 通过 |
| 媒体SDK及file sender专项 | 2文件31项通过，实际固定SDK仅socket为内存对象 |
| `node --test integrations/native/verification-options.test.mjs integrations/native/prepare-native-sqlite.test.mjs` | 6项通过：参数准入、归档路径/链接安全、离线包/二进制替换拒绝 |
| `node integrations/native/verify-targeted.mjs N_SRC --sqlite-driver PREPARED_PACKAGE --host-overlay O_SRC --typecheck` | 3文件17项通过（定向6、真实驱动4、宿主7）；原候选完整tsc退出0 |
| 原调用方alias兼容`node node_modules/vitest/vitest.mjs run --config .local/t5-20261018/legacy-vitest.config.ts` | 17文件148项通过；不是整个私有产品验收 |
| `npm run demo`、`demo:report`、`demo:delivery`、`demo:operations`、`demo:tasks` | 五组通过，原报告/文件/任务编号新进程查回、unknown不重发仍通过 |
| 默认替代驱动`verify-targeted.mjs N_SRC --typecheck` | 6项通过，候选完整类型检查退出0；该兼容模式不算真实驱动证据 |
| `npm audit --omit=dev` | 0已知漏洞；没有更新依赖、npm或原驱动版本 |

宿主和驱动命令从本项目执行，N/O只读，脚本实际创建新的OS临时副本、删除凭据/模型环境变量、全量mock config（不importOriginal）、使用合成runner/provider。完整HTML、原源码副本、数据库、二进制、下载包、私有核验日志均不提交。来源hash、变更diff及独立审查按最终提交核对。

独立规格和质量审查未发现剩余P0/P1/P2。审查要求纠正了“不同suite通过等于同一链组合通过”以及“index文本核实等于完整宿主运行通过”的陈述，已补真实gate的同链测试并限定运行范围。无lint脚本及远端CI，不报告其通过。

## 边界与下一步

源代码核实与运行验证分开：完整原index变换结果仅检查同一gate传入queue/Web/scheduler、ready后才启动消费者及原停机顺序，不导入index、不启动HTTP/SDK。运行候选使用真实O gate与scheduler/IPC/recovery overlay，保留N原queue和T7定向db，不把整个O warm/cold队列、DB boot promotion和Web栈算作通过。调用链本身在入队与执行前都受同一门禁保护。

原账号、授权、账本、记忆、岗位、培训、页面、发送服务和Agent循环未重做。当前仍只允许isolated-synthetic；完整真实宿主启动/恢复证据、Linux原二进制所在实际运行环境、绑定、平台ACK、手机接收与文件打开，仍须后续受控联调。缺少单聊归属的事件继续拒绝，不能推断为single。
