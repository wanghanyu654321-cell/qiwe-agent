# T7-A：原 Docker 传输与 Pi 主入口的本地验证

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

## 尚未覆盖

需要可核验的原 runner 镜像，才能验证完整 shell、浏览器及身份启动链；还需在不绕过原恢复条件的前提下验证完整宿主与真实子容器的同次运行。本场景没有完整宿主的 memory IPC 消费者，原运行时按既有策略提示无法取得持久记忆快照后继续；验证的追问上下文是原 SDK 会话历史，不是持久记忆服务。真实企微实收、模型质量和生产部署仍待单独授权与验收。本轮不把独立 transport 通过写成产品已开放。
