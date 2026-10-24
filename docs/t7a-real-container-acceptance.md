# T7-A：原 Docker 传输与 Pi 主入口的本地验证

## 当前增量：本地原 Dockerfile 与原 shell 启动链

2026-10-24，基线 `030bfcd0d36b614c31c912a437d61320b31ff94a`。本轮在已有验证器增加显式原 shell 模式，复用原启动器、挂载、Pi main、追问、取消和退出场景；业务服务、D1–D5、恢复证明及门禁保持不变。本地构建副本与原 shell 实测已通过；完整宿主恢复与真实容器的同次联动仍未通过，具体缺口见下文。

构建使用本地 N 的 `container/Dockerfile` 和明确选出的 75 个源码、prompt、清单及启动辅助文件，没有复制业务数据、配置、密钥或宿主 `node_modules`。原 Dockerfile SHA256 为 `fbc6077c10535cbc65e2f7d4815cdf00971be249adcac8dde2f7de8b14e7e61a`。沿用原 Pi 0.84.2 和 agent-browser 0.33.1，下载仅用于构建原文件列出的依赖；运行验收禁用容器网络。构建输入与日志保存在 `.local/t7-runner-shell-20261024/`。

构建实测发现两项阻塞。原文件的两次构建因 Debian HTTP 502 失败；增加 `Acquire::Retries=5` 仍未处理这些 502，改为最多三次执行同一安装命令后，复用已下载包完成安装。随后原 `npm ci` 后的无锁二次安装把顶层 `pi-ai` 解析到 1.4.0，SDK 内部仍为 0.84.2，导致 `pi-runtime.ts:161` 的 TS2322；原锁文件实际上已固定两份 `pi-ai` 为 0.84.2，并包含 agent-browser 0.33.1。

`original-shell.mjs` 的 `createOriginalShellDockerfileCandidate` 只接受上述原文件哈希，生成独立本地副本：增加有限安装重试，将多余的无锁安装换成已安装 agent-browser 版本核对。保留 `npm ci`、原 package/lock、全部依赖与完整编译。副本 SHA256 为 `461ebea6553342cca3de87cb9bdfada56cc4ec7ac4bbf087425a67c3977002a6`，构建必须传 `--build-arg AGENT_BROWSER_VERSION=0.33.1`。原 Dockerfile、启动文件及业务源码没有原地修改。版本漂移检查同时核对实际顶层和 SDK 内部的 `pi-ai`；不靠类型断言或跳过编译绕过错误。

原 shell 模式必须显式给出镜像 ID 和构建记录，不能用镜像标签冒充固定版本：

```powershell
node integrations/native/verify-real-container.mjs N --host-overlay O --sqlite-driver DRIVER --typecheck --skill-root SKILLS --docker DOCKER_EXE --original-shell-image sha256:IMAGE_ID --original-shell-build-input BUILD_INPUT_ABSOLUTE_PATH
node --test integrations/native/original-shell-boundary.test.mjs integrations/native/original-shell-image.test.mjs integrations/native/real-container-boundary.test.mjs
node --test integrations/native/original-shell-dockerfile.test.mjs
```

镜像预检核对实际入口、原 shell/辅助文件、runner 源码及清单哈希和实际 Pi 版本。场景保留 `/app/entrypoint.sh`、真实 Chromium/CDP、原权限准备、`runuser`/`setpriv` 以及 `/tmp/dist/pi-index.js`。仅在隔离候选中导入确定性模型响应替身，不改原 Agent 循环。实际进程、UID、capabilities、CDP 响应和输入输出必须提供运行证据。

为执行原 shell 的改属主、降权和退出清理，测试容器在移除全部 capabilities 后仅添加 `CHOWN,DAC_OVERRIDE,FOWNER,KILL,SETGID,SETUID`；不使用 privileged 或 Docker socket。保持根文件系统只读、`no-new-privileges`、无外网，仅本轮合成挂载可写。Pi 应以 UID/GID 1000、零有效 capabilities 运行。原 shell 会在 Windows 挂载中产生 Linux 链接，因此新模式完成容器清理后保留本轮合成临时目录，明确记录 `workspaceRemoved:false`；不尝试删除上一轮审批拒绝清理的目录。

### 本轮实际验证

构建命令使用固定本地 Docker Desktop Linux endpoint：`docker --host npipe:////./pipe/dockerDesktopLinuxEngine build --pull=false --progress=plain --build-arg AGENT_BROWSER_VERSION=0.33.1 --build-arg TOOL_REFRESH=qiwe-local-shell-20261024 -f .local/t7-runner-shell-20261024/Dockerfile.locked-retry -t qiwe-runner-shell-local:20261024 .local/t7-runner-shell-20261024/build-context`。完整编译与构建 exit 0，镜像 ID 为 `sha256:f316ed6c4f0f9cdc4bfde0d7efad662cc9019d61d3508cc05f1b9a1754839658`。这是修复构建副本后的结果，不能写成原 Dockerfile 零修改构建成功。

原 shell 运行证据位于 `.local/t7-runner-shell-20261024/original-shell/c2f557bc-0392-499f-bf4a-5c3173c7c228/`，状态 `local-original-shell-passed`。宿主类型检查、runner 编译、场景均 exit 0；场景 1/1，74.35 秒，不作为生产性能承诺。

- 镜像预检确认原入口、源码、清单及六个辅助文件哈希；Pi SDK、顶层与嵌套 pi-ai 均为 0.84.2。
- 三个正常容器实际经过 PID1 原 entrypoint → runuser → Pi main；Pi UID/GID 1000、有效 capabilities 为零，root shell 为 `0xeb`，no-new-privileges 为 1。Chromium 以 node 身份启动，CDP 返回 Chrome 156.0.8078.47。
- 同一容器首答读取挂载资料与技能；追问包含前答；精确取消触发真实 SDK AbortSignal，取消输入没有完成答案，后继正常执行。逆序文件名按持久输入顺序回执，空闲 close/drain 和活动 drain 均实际退出。缺失测试 provider 产生原启动链非零退出。
- 三次运行的 provider 哈希均对应本轮源码；实际 `/tmp/dist/pi-index.js` 哈希均与候选编译产物 `cbb7aa99e42bc8a20e553d3c4d3d9caf65e5f0bf839313a02d00145652db7b43` 一致。来源校核保存在 `final-evidence-check.json`。
- 5 个本轮容器（预检 1、场景 4）均确认不存在。按前述规则保留合成目录 `qiwe-real-container-nVb2nu`，`workspaceRemoved:false`；镜像保留供后续联动，不提交镜像、依赖或原技能内容。

本轮专项 6/6；默认 Node 镜像模式回归 `be8954fc-fe83-4d8d-ae84-ad57ef6fcdbd` 为 `local-transport-passed`，原类型、编译及场景均通过，4 个容器已退出、合成目录已清理。公共 `npm test -- --no-file-parallelism` 为 43 文件、598 项通过，`npm run typecheck`、`npm run build` exit 0；无 lint 脚本。日志均保留在上述本轮证据根目录。测试模型响应为确定性合成数据，未调用外部模型、发送真实消息或修改生产。

### 完整宿主联动的实际缺口

当前原 shell 模式单独运行容器传输，不能称为“完整宿主恢复后带真实容器跑通”。现有恢复验证器的物理环境要求固定 PID1、仅祖先进程、无 Docker socket、无外网及私有 tmpfs 数据；完整宿主场景还禁止子进程，并用进程内 Pi 接点替换容器传输。原启动器却需要调用 Docker，并把宿主绝对路径交给 daemon 挂载。外部 daemon 不能自动看到该私有 tmpfs 的同一目录。

因此缺的是两者共用、可核实的运行环境：恢复检查需覆盖真实 daemon 与旧容器写者的退出/失权，以及宿主和容器挂载的是同一批合成文件。当前证明没有提供这些事实。不能靠换镜像、移动 socket 路径、删除进程检查或把两次独立通过拼接来满足。此轮不改这份恢复契约；组合验收保留为未通过，后续应先收敛这一个环境接点，不重复开发岗位、会话、账本、技能或发送能力。

## 上轮记录：缓存 Node 镜像的独立传输验证

2026-10-24，开发基线 `dd3baf2e101124692d10d8e459c47304cd84e5bb`。本轮只验证原 `runContainerAgent` 的真实 Docker 启动、挂载、管道和 Pi 长驻交互；复用已通过的 D1–D5 候选及 Pi 修补，不改业务服务、恢复门禁、数据库或生产配置。

## 本地镜像查找

已检查本机 Docker 镜像清单，以及可读的桌面项目、下载和常用资料目录。找到 MiniClaw 源码包、Frontagent 源码归档、Web 工作台部署包及构建记录；抽查相关归档的目录结构，未确认它们是原 runner 镜像导出。已缓存的 `claw-full-instance-probe` 是 Web 宿主启动入口，不能替代原 `helsome/miniclaw-agent` 的 shell 验收。部分目录无法读取，因此不宣称全盘不存在原镜像。

本轮使用已缓存 Node 22 镜像，ID 为 `sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`，禁止拉取。原 shell、Chromium、runuser 和宿主身份桥接未执行。测试引导在 `/home/node/.claude/skills` 专用 tmpfs 准备技能链接，保留原会话父目录和只读技能来源挂载，并加载真实编译的 Pi `main().catch(...)`；ModelRuntime 的模型事件由确定性数据代替，原 SDK 和工具实际执行。

## 验收边界

此入口单独运行原容器 transport，不启动或恢复完整 main。此前的完整宿主恢复证明依赖固定 Linux 进程和写者边界，不能容纳 Docker socket 或范围外兄弟写者。本轮没有修改该证明，也不能将两次独立测试拼成“恢复后的完整宿主已带真实容器跑通”。

检查范围包括原 stdin EOF、输出解析、挂载来源及读写模式、同一子进程连续追问、准确输入回执、实际中断和后继输入、空闲 drain/close、活动 drain 答完退出，以及启动失败。挂载检查使用合成他人/项目数据作反例；缺失路径的工具错误只证明挂载不可见，不代表通用文件权限验收。

所有 Docker 探测、启动和停止固定到本机 Desktop Linux endpoint。子容器无网络、无 Docker socket、根文件系统只读、移除全部 capabilities；仅本轮合成目录可写。外层记录本轮 UUID 标签和容器名，超时先终止本轮测试进程树，再按标签核对清理；归属或清理无法确认时保留临时目录并失败。

## 命令与证据

在仓库根目录，沿用已校验的 N/O 源码、原技能目录及本地准备好的 SQLite 驱动：

```powershell
node integrations/native/verify-real-container.mjs N --host-overlay O --sqlite-driver DRIVER --typecheck --skill-root SKILLS --docker DOCKER_EXE
node --test integrations/native/real-container-boundary.test.mjs
# 明确设置 QIWE_REAL_CONTAINER_DOCKER 后执行真实超时清理反例
node --test integrations/native/real-container-cleanup.test.mjs
```

运行证据存放 `.local/t7-real-container-20261024/`，每轮生成独立 runId、来源哈希、原 runner 编译哈希、Docker inspect、实际输入/输出和清理记录。

最终成功运行 `82be09c1-b505-4c72-808c-93c7d9df3274`：宿主 PID 5868，三个正常子容器的 daemon PID 为 44204/44979/45481，另一个容器用于真实启动失败反例。原宿主类型检查、runner 编译和场景均 exit 0；场景 1/1 通过，耗时 156.75 秒。四个容器确认不存在，`workspaceRemoved: true`，整轮状态 `local-transport-passed`。

- 首答读取实际挂载的批准资料和完整技能文件；独立断言四个工具结果及错误标志，不把错误文字当作成功读取。
- 同一 daemon PID 的追问包含前答，回执归属 `warm-delivery`；中断确实触发 SDK AbortSignal，`interrupt-delivery` 没有完成答案，后继 `successor-delivery` 正常执行。
- 文件名顺序与持久游标顺序相反的输入按 `ordered-old → ordered-new` 处理，答案绑定相应回执批次。
- 空闲 `_drain`、`_close` 导致实际退出；活动 `_drain` 保留当前答案后退出。缺失启动文件产生非零退出，原启动器返回 error。

专项验证：边界测试 2/2；真实超时进程树清理及外来标签拒删 1/1。日志分别为 `boundary-final.log`、`focused-final.log`；后一日志包含此前相同边界用例与清理用例，边界后来增加 tmpfs 断言后单独重跑。`preparation-compatibility.log` 记录默认生成内容比较。最终源码与成功 audit 的七项输入哈希逐项相符，编译 Pi 入口 SHA256 为 `8beecf2243dbf6ac41713cbbdacb5646df1b515bf3fb7ca57165fb20cb4ffc23`。

前六轮保留未到达 bootstrap 的失败和后续定位结果，涉及测试员工 Home 准备、Windows 自定义技能软链接、原参数准入、只读卷参数解析，以及 SDK 冷加载等待；没有据此修改原业务代码或门禁。单独只读加载原 SDK 实测 30.464 秒，因此只将 SDK 初始化等待改为 60 秒，普通行为等待仍为 30 秒；本轮不是生产性能验收。

第七轮 `25f20c6d-9ff8-4aa4-9ea2-8305f7599dcf` 的场景 1/1 通过，但外层清理失败，整轮仍记失败。Linux 技能链接写入 Windows 挂载后成为无法被 Node 普通删除的 reparse 条目。自动审批拒绝人工删除三个链接，旧目录 `qiwe-real-container-DXae6I` 保留，未再尝试删除；记录在该轮 audit 的事后注记。新一轮把测试引导的技能链接放进上述 tmpfs，不改变原会话持久文件。此保留目录是本轮尚未清理的本地遗留项。

共享准备函数仅增加默认关闭的 `trueMain` 选项；与基线比较，默认生成的 69 个文件内容一致。其他改动为验证脚本，未增加依赖、业务 API、schema 或新的 Agent 循环。公共回归本轮 598 项通过，类型检查与构建通过；仓库未配置 lint 脚本。

## 上轮未覆盖项与当前边界

上轮缺少的原 runner 镜像、完整 shell、浏览器及身份启动链，已由本页当前增量覆盖。完整宿主与真实子容器的同次运行仍未通过。两轮独立传输场景均没有完整宿主的 memory IPC 消费者，原运行时按既有策略提示无法取得持久记忆快照后继续；验证的追问上下文是原 SDK 会话历史，不是持久记忆服务。真实企微实收、模型质量和生产部署仍待单独授权与验收；不把独立 transport 通过写成产品已开放。
