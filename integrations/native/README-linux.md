# 本地 Linux 隔离验证

本入口验证本机独立 Linux 容器，不表示生产 Ubuntu 的版本、配置、服务状态或渠道验收。没有生产 SSH、真实消息、模型或部署。

运行环境固定为已在本机存在的官方 `node:22.23.2-bookworm-slim` 的 RepoDigest `node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`，实际为 Debian 12、Linux x64、Node 22.23.2 / ABI 127。`--pull=never` 不会用可变 tag 换镜像。入口再次检查 `desktop-linux` 必须是本机 Windows named pipe，拒绝远端 daemon。

`verifyOriginalLinuxSqlite(source)` 仅允许 Linux x64 / ABI 127，校验原 N 的 better-sqlite3 12.11.1 lock SRI、metadata、全部 lib JS、两个 loader 主文件及原 ELF 的固定 SHA256 `df9fbd0d061f360d81fb51e265c53c9605020bd68219e34f33c07c85de15719a`，再执行 `:memory:` SQL。不会下载、重编译或替换驱动。完整宿主入口在 Linux 无 `--sqlite-driver` 时使用此准入。

先在专用临时目录构建**受控副本**，由调用者审核内容，不可直接传原工作区、盘符或用户目录：

```text
COPY_ROOT/
  .local/full-instance/stage/app/
    src/                 # 仅 N 源码
    node_modules/        # 仅既有依赖
    package.json
    package-lock.json
    tsconfig.json
  .local/core-fix/appointment-identity-candidate/src/  # 仅 O 源码
  qiwe-agent/
    src/
    integrations/native/
    node_modules/
    package.json
    package-lock.json
    tsconfig.json
    tsconfig.build.json
```

不复制 data、store、config、`.env`、会话、日志、凭据、`.git`、依赖缓存、`.bin` 或 symlink。N/O 保持上面的相对关系。Windows 依赖副本不能自动当作跨平台依赖：qiwe 的 Vitest 4.1.12 / Vite 8 使用 `@rolldown/binding-linux-x64-gnu@1.2.14`；本次从 qiwe lock 中的 registry URL 获取，并校验对应 SHA512 SRI 后只解包 3 个普通文件到副本，未执行安装或生命周期脚本。N 的既有 `@esbuild/linux-x64` 保持不变。

副本准备后以 `sealControlledLinuxCopy(copyRoot)` 封存 `.qiwe-linux-stage.json`：只允许上述源码、依赖与指定元数据路径，拒绝 symlink、`.env`、Git、缓存及其他目录，记录每一个普通文件的 SHA256。运行入口在挂载前重新检查全部清单，新增、遗漏或内容变化均拒绝；同步源码后须重新封存。

```powershell
node --test integrations/native/linux-runtime.test.mjs
node --input-type=module -e "import {sealControlledLinuxCopy} from './integrations/native/linux-runtime.mjs'; console.log(sealControlledLinuxCopy(process.argv[1]));" 'D:/path/to/controlled-copy'
node integrations/native/linux-runtime.mjs 'D:/path/to/controlled-copy'
```

默认 CLI 运行完整宿主行为。本次通过的验收还在同一入口显式加了 `--typecheck`，可用以下命令复现类型检查与两进程宿主验收：

```powershell
node --input-type=module -e "import {verifyControlledLinuxCopy,runLinuxContainer} from './integrations/native/linux-runtime.mjs'; const root=process.argv[1]; verifyControlledLinuxCopy(root); process.exitCode=runLinuxContainer(root,['/input/qiwe-agent/integrations/native/verify-full-host.mjs','/input/.local/full-instance/stage/app/src','--host-overlay','/input/.local/core-fix/appointment-identity-candidate/src','--typecheck']);" 'D:/path/to/controlled-copy'
```

容器只挂载上述一棵只读副本，断网、只读 rootfs、移除 capabilities、禁止提权、限制内存/CPU/PID；唯一工作盘为 `/tmp` tmpfs，真实 HTTP 仅使用容器内 loopback。无 Docker socket、凭据、原目录或真实数据挂载。宿主测试临时 `node_modules` 必须是可写目录，逐包链接只读依赖，使 Vite `.vite-temp` 留在 tmpfs。

资源上限为内存 4 GiB、2 CPU、256 PID 和 768 MiB tmpfs。本机引擎可用约 7.66 GiB；早期 1.5 GiB 限额使原完整候选 TypeScript 检查在约 765 MiB V8 heap 上限 OOM，该次结果保留为失败，只提高独立容器内存上限后再验证，未调整全局 Docker 资源设置。

每次运行使用新 UUID 的独有 name 和 label。即使 Docker CLI 超时，finally 也只在重新核对该 name 和本次 label 后清理本次容器；停止后的自动删除视为成功，不操作其他容器。合成证据写 `/tmp/qiwe-full-host-evidence`，由完整宿主入口输出到 stdout，调用方可保留日志。

可在同样容器中设置 `QIWE_LINUX_NATIVE_SOURCE=/input/.local/full-instance/stage/app/src` 并执行 `linux-runtime.test.mjs`：额外真实验证原驱动加载，以及 JS、ELF、loader 被替换时在执行前拒绝。Windows 的该用例明确 skip，不能代替 Linux 的实际执行证据。

当前局部组合曾实际运行原 targeted 6、host-readiness 7、sqlite-driver 4，共 17 项通过；该结果与完整宿主验收分别记录，不能拼成完整宿主恢复成功。完整宿主以 `verify-full-host.mjs` 本次输出为准，原 collector 的不完整 inventory 若拒绝恢复，须保留拒绝事实。
