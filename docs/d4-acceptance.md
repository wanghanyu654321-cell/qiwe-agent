# D4 原岗位技能与工具装配

日期：2026-10-22。开发基线 `1ce8868decee95f02c8b5a18f95a6974b886b551`，分支 `feat/wecom-role-skills-d4`。本轮按 [执行说明书](roadmap.md) 和 [对话接线计划](wecom-native-conversation-plan.md) 推进。Linux 原服务/runner 隔离组合通过；完整宿主和真实产品启用仍受下述限制，不能直接部署。

## 核实后的边界

原实际入口为 `container/agent-runner/src/pi-index.ts`，不是旧 `index.ts`。`runTurn` 调用原 `createMcpTools`、`adaptClaudeMcpToolsToPi`、`PiRuntimeAdapter` 和 `runPiQueryAttempt`，最终进入已安装的 Pi SDK 0.84.2。宿主构造有效 MCP 配置，不等于这个 Pi 入口已经消费外部 MCP。

按用户“核实目前文件夹内”的要求扩大搜索后，已在现有 `claw-agent-mem0-p0/deploy/railway/package/skills` 找到 `beauty-local-content`、`vendor-content-strategy`、`vendor-copywriting`。三个文件均匹配原打包清单，原 `role-templates.json` 的 marketing 岗位也选择这三个技能，并禁用 host skills 和外部 MCP。本轮只将原文件复制到合成用户的临时技能目录；未重写技能或重新装配真实员工。当前生产 Profile 是否启用它们仍未知。

本地 `local-product-20261013-r1/runtime/data/skills/local-owner` 也有完全一致的副本。这消除了本轮技能来源缺口；Native 源码快照本身仍没有技能文件，不能据此推断生产安装状态。

| 原技能 | `SKILL.md` SHA-256 | 本轮作用 |
| --- | --- | --- |
| `beauty-local-content` | `792e944b9b96a7b592ff2f2f3b345f2644fd9711f8f0cc38de55a7aa0f83ccda` | 已审事实、缺项及草稿边界 |
| `vendor-content-strategy` | `3abdf5b95e8b2d62adc34e42c2f0cb769ca8e62eff1e81f25d4c7dc9f3b2c832` | 选题和拍摄需求方法 |
| `vendor-copywriting` | `a5d08a728d96673dcf3cb1c706606f47cd24cf15cb9e1249856ca99798b2c545` | 中文文案和单一行动号召方法 |

来源为原包 `role-templates.json` 的 marketing 条目及 `artifact-manifest.json`。技能负载不复制到本仓库；验证时显式提供本地目录，文件身份不匹配即拒绝。原基础技能允许在没有旧 `read_eval_fixture` 工具时输出人类可读草稿，故本轮使用原 SDK `read` 读取临时已审材料，不新增同名业务工具。

## SDK 和替身边界

沿用 PI coding skill 的 SDK 实锚方法及 MiniClaw skill 的源码、证据导航方法，不采用新建 Agent Core 或简历编写流程。原版本和原循环保留，不新增模型调用或依赖。

| 接点 | 验证要求 |
| --- | --- |
| 原 Profile 与有效技能解析 | 使用原解析函数，保留选定空间、Owner 和策略；不手写所需清单冒充原装配 |
| Pi 模型输入输出 | 只在原 SDK 的 `ModelRuntime.streamSimple` 注入确定性模型事件；测试输出不代表真实模型选择或生成质量 |
| 工具注册及参数 | 保留原 MCP→Pi adapter、SDK `prepareArguments`、参数校验和真实工具处理函数 |
| 本地能力协作 | 优先验证原 SDK 文件读取与原 `get_channel_context` 共同参与一条请求，使用临时合成材料；不外发、不访问真实业务资料 |
| 错误与持久化 | 工具失败、资料缺失必须在原事件/状态中可观察，保留 D3 的原输入、query/turn 和查询关联 |

外部 MCP 客户端、真实容器启动和完整 O 宿主恢复不因上述片段验证而完成。D5 的持久答案通知和手机实收仍属后续阶段。

## 已复现的必要修补

原 MCP 工具可通过 `{isError:true, content:...}` 返回业务错误，但原 Pi 工具适配器只返回内容和 details，SDK 将这次已正常返回的调用记为成功。隔离反例使用真实 `workspace_memory_search` 处理函数，在临时 IPC 路径为普通文件时触发 `ENOTDIR`：原 SDK 的 `tool_end.isError` 错误地为 false。

候选转换只把明确 `isError:true` 转为抛出的工具错误，复用 SDK 原错误处理路径；成功结果不改。修补仅应用新建的临时 runner 副本，不编辑原源码、不改变整个 Agent 的成功/失败规则。模型仍可读取工具错误后给出缺资料说明，不能把工具失败等同于整个对话必须失败。

## 实际验证范围与剩余边界

- 原岗位解析使用 `resolveAgentProfileUserSkillsPolicy`；临时夹具创建其输出到 Pi 技能目录的链接，原 SDK `DefaultResourceLoader` 再读取技能。没有执行原 `runContainerAgent` 的真实进程启动/挂载和 `buildClaudeContextPlan` 的全部来源优先级合并。
- 内容营销夹具使用原包的三个技能和已审合成资料。固定模型事件读取两项方法、资料和当前渠道，再输出带来源的合成选题、文案及 `draft / executed:false`。这证明接线和工具执行，不证明真实模型能自主选技能或文案质量。
- 缺资料可以使 Agent 正常结束，同时答案明确 `partial / draft:null`；运行完成不等于业务草稿已生成。工具错误的 SDK 事件及 SDK JSONL 持久状态单独验证，外层所有 UI 的错误字段未验收。
- 岗位版本变化只验证原下一轮 session 重置；排队撤权验证不启动 runner。没有证明活动工具写入时即时撤权，不能凭提示词或队列入口检查开放任意高副作用工具。
- 原 Profile 没有已核实的内置工具逐项白名单；技能取消选择/禁用不能描述成所有 SDK 内置工具一并禁用。原包禁用外部 MCP；当前 Pi 没有消费宿主外部 MCP 配置，此缺口仍保留。
- D4 本轮查回为同进程新 SDK 消息查询。D3 的独立进程状态查回已有历史证据，但不能自动覆盖 D4 草稿内容；D5 需接持久答案通知及第二进程答案查回。

## 复验入口

在仓库根目录，使用已经存在的源码、技能文件和依赖：

```text
node integrations/native/verify-role-capabilities.mjs N_SRC O_SRC [WINDOWS_DRIVER] --skill-root ABSOLUTE_SKILLS_ROOT
node --test integrations/native/linux-runtime.test.mjs integrations/native/prepare-native-sqlite.test.mjs integrations/native/verification-options.test.mjs
npm test -- --maxWorkers=1
npm run typecheck
npm run build
```

Linux 省略 Windows 驱动参数，使用固定镜像、断网、只读受控副本及原 Linux SQLite 12.11.1；只准三个指定 `SKILL.md` 文件，不把整个旧业务数据目录挂入容器。Windows 原目录链接遇到 EPERM，不能记为完整 Windows 组合通过。未新增依赖；项目没有独立 lint 脚本。

## 验证记录

全部命令在 `qiwe-agent` 根目录运行，基线为本文首段提交，证据目录为本地 `.local/d4-20261022/`。

| 检查 | 实际结果 |
| --- | --- |
| `npm test -- --maxWorkers=1` | 42 文件、575 项通过；`public-final-serial.log` |
| 默认并发 `npm test` | 574 通过、1 失败：原 `retains the original gate ticket...` 用例在 200ms 预算内未进入受理；`public-final.log`。同版本串行全部通过，未改产品超时或弱化断言，保留计时敏感限制 |
| `npm run typecheck` / `npm run build` | 均退出 0；`typecheck.log` / `build.log` |
| Node 验证工具测试 | 17 通过、1 项 Linux 原驱动专用检查在 Windows 跳过；`linux-stage-green.log`。Runner/技能受控副本路径先验证拒绝，再补精确许可 |
| Windows D4 | 原 SDK 错误、参数及缺文件和守卫场景 4 项通过；组合因原目录链接 EPERM 失败，不声明完整 Windows 通过 |
| Linux D4 冻结组合 | 5 项通过，原宿主候选和原 runner 类型检查均退出 0；`linux-final-submission.log`，运行 `fbd371c7-b805-4a90-948f-bfb67a2c18ad`、PID 51。三份执行文件与全部公开模块 source hash 已和当前文件逐项核对 |
| CLI 参数拒绝 | 重复、缺值、未知参数和多余位置参数均在源码读取前退出 1 |

工具失败标记是本轮有效缺陷 RED。早期组合夹具的记忆 transport 抛错、共享 IPC 根目录破坏及不可克隆工具函数导致的错误，均是夹具修正，不包装成生产问题修复或成功验收。

冻结组合沿用原 N 树 `8611519397c78b1f5d9591ae18ea2c5d1c399aab3d63b9ea5311ebd8c18b0bad` 和原 runner 源码/提示词树 `6d8a8fdb9717820a10478c875d6b424ce452157ea17c94aaac26dad3e64f4d17`。审计同时记录机械 export 后的实际宿主文件、修补后的工具适配器、测试及编译模块身份。6 次模型流调用均为确定性替身，观测到的网络调用为 0。

最终变更不包含原技能负载、数据库迁移、账号数据或新依赖；原源码只读，默认完整宿主不变。下一步接 D5 的持久答案投递及第二进程查回；真实启用前还需 T7 恢复和相应渠道/模型验收。
