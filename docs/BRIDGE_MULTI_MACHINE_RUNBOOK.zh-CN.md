# lark-coding-agent-bridge 多机器运维 Runbook

## 文档状态

- 用途：供后续 Agent 在没有历史会话时执行 Windows 与 Ubuntu 的同步、构建、安装、升级、发布、回滚、全新部署和故障诊断。
- 最后更新日期：2026-08-28。
- 最后验证日期：2026-08-28。
- 最后验证的 Bridge 版本：`v0.8.0`。
- 最后验证的 commit：`5e2aabb9bc9fd251ca5c5851a7f75b14f791a844`。
- 适用平台：Ubuntu Bash、Windows PowerShell。
- Windows 验证状态：用户提供的当前机器实测为构建成功、TypeScript 类型检查通过；700 项测试中 695 项通过、5 项失败，失败涉及缺少 `sh`、Codex 测试二进制兼容性和 Bridge 环境变量。不是“Windows 全部测试通过”。
- Ubuntu 验证状态：2026-08-28 在本机实测构建和类型检查通过；700 项测试中 698 项通过、2 项失败，失败由当前 Bridge 注入的 profile 环境变量影响。不是“Ubuntu 全部测试通过”。
- 维护要求：每次同步、部署、升级或发布前先读本文；实际命令与本文不一致时不得静默绕过，完成安全操作后同时修正文档，并标明验证平台。

本文是操作手册，不替代项目的 `README.zh.md`。未经实际验证的内容标记为“待验证”。

## 0. 不可违反的操作边界

1. 不提交或输出 App Secret、Token、Cookie、OAuth 凭据、SSH 私钥、二维码或其他认证材料。
2. 不提交 `.lark-channel`、`node_modules`、日志、会话数据、Profile 私有配置、`.tmp-lark-auth-qr.png` 或本地缓存。
3. 不把 Token 写进 Git remote URL。
4. 保留用户已有修改；只暂存当前任务明确涉及的文件。
5. 不执行 `git reset --hard`、force push、强制覆盖 checkout 或未经授权的清理。
6. 有未提交修改时，不自动 pull、merge 或 rebase。
7. 提交前必须检查工作区 diff、staged diff、文件名和敏感信息风险。
8. 若敏感信息已被 Git 跟踪，立即停止提交，报告文件和泄露类型；不要在报告中复述秘密。
9. Bridge 环境中不得 unset `LARK_CHANNEL`、`LARK_CHANNEL_HOME`、`LARK_CHANNEL_PROFILE` 或 `LARKSUITE_CLI_CONFIG_DIR`，不得使用 `env -u LARK_CHANNEL` 绕回普通配置。
10. 出现 `lark-channel context detected but lark-cli is not bound to it` 时停止；要求重启 Bridge 或运行项目支持的 doctor/preflight，不自行 bind，不读取配置中的密钥。
11. 认证失败时区分 HTTPS 凭据与 SSH 授权问题；不读取、生成或输出私钥。
12. 从正在运行的 Bridge 会话内操作时，不得在回复完成前重启承载当前会话的 Profile。需要重启时先报告影响，并由外部终端执行或安排在最终步骤。

## 1. 环境与目录清单

### 1.1 三套内容必须区分

- 源码仓库：Git 跟踪的项目文件，用于修改、测试、提交和发布。
- npm 全局安装程序：`lark-channel-bridge` 和 `lark-robot` 命令实际加载的安装位置。更新源码不会自动更新它。
- `.lark-channel` 私有运行数据：应用凭据、Profile、会话、日志、附件和 lark-cli 状态。它不属于源码，不随 Git 同步。

### 1.2 当前已知基准

Windows：

- 正式源码目录：`D:\lark-coding-agent-bridge`。
- 私有运行目录：`$env:USERPROFILE\.lark-channel`。当前机器对应用户目录由 PowerShell 现场解析，不在文档中固化用户名。
- 全局安装：npm 全局安装的 Bridge `0.8.0`；实际路径需用下面命令现场验证。
- 后台启动：Profile 的 `launcher.cmd` 配合用户 Startup 启动项；Profile 名称待现场确认。
- 日志：`$env:USERPROFILE\.lark-channel\profiles\<PROFILE>\logs`。

Ubuntu（2026-08-28 已验证）：

- 源码目录：`/home/wujie/Chance/lark-coding-agent-bridge`。
- Node.js：`v24.18.0`。
- pnpm：`10.33.0`。
- npm 全局前缀：`/home/wujie/.nvm/versions/node/v24.18.0`。
- Bridge 命令：`/home/wujie/.nvm/versions/node/v24.18.0/bin/lark-channel-bridge`。
- Robot 命令：`/home/wujie/.nvm/versions/node/v24.18.0/bin/lark-robot`。
- 当前 npm 全局 `0.8.0` 是指向源码目录的 link；源码构建产物变化会影响该 link，但运行中进程仍须重启才加载新代码。
- 私有运行目录：`/home/wujie/.lark-channel`。
- Profile：`codex`。
- 当前分支：`main`，跟踪 `origin/main`；默认分支为 `main`。
- `origin`：个人 fork `git@github.com:<OWNER>/lark-coding-agent-bridge.git`；`upstream`：原项目 `https://github.com/<UPSTREAM_OWNER>/lark-coding-agent-bridge.git`。实际 owner 用脱敏 remote 检查确认。
- 后台服务：systemd 用户单元 `lark-channel-bridge.bot.codex.service`，已启用并运行。
- 日志：`/home/wujie/.lark-channel/profiles/codex/logs/daemon/`。
- 采集时 systemd 提示 unit/drop-in 在磁盘上变化、需要 `daemon-reload`；执行重启前应先确认，不在文档提交任务中打断当前会话。
- 源码、全局安装和运行版本均为 `0.8.0`；源码 HEAD 为基准 commit。

### 1.3 每次操作前重新采集

Ubuntu Bash：

```bash
pwd
git rev-parse --show-toplevel
node --version
pnpm --version
npm prefix --global
npm root --global
command -v lark-channel-bridge
readlink -f "$(command -v lark-channel-bridge)"
lark-channel-bridge --version
lark-channel-bridge profile list
lark-channel-bridge status --profile <PROFILE>
lark-channel-bridge ps
```

Windows PowerShell：

```powershell
Get-Location
git rev-parse --show-toplevel
node --version
corepack pnpm --version
npm prefix --global
npm root --global
Get-Command lark-channel-bridge | Format-List Source,Path,CommandType
lark-channel-bridge --version
lark-channel-bridge profile list
lark-channel-bridge status --profile <PROFILE>
lark-channel-bridge ps
```

成功标准：源码目录、命令路径、Profile、全局版本和运行版本均可明确；任何不一致先记录，再决定升级或回滚。

## 2. 仓库预检与两台机器日常同步

### 2.1 通用仓库预检

Ubuntu Bash：

```bash
pwd
git rev-parse --show-toplevel
git status --short --branch
git branch --show-current
git rev-parse HEAD
git describe --tags --exact-match HEAD 2>/dev/null || true
git symbolic-ref -q --short HEAD || true
git remote -v | sed -E 's#(https?://)[^/@]+@#\1<redacted>@#g'
git branch -vv
git fetch --prune origin
git status --short --branch
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
git rev-list --left-right --count "HEAD...@{upstream}"
```

Windows PowerShell：

```powershell
Get-Location
git rev-parse --show-toplevel
git status --short --branch
git branch --show-current
git rev-parse HEAD
git describe --tags --exact-match HEAD
git symbolic-ref -q --short HEAD
git remote -v | ForEach-Object { $_ -replace '(https?://)[^/@]+@', '$1<redacted>@' }
git branch -vv
git fetch --prune origin
git status --short --branch
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
git rev-list --left-right --count "HEAD...@{upstream}"
```

解释 `git rev-list --left-right --count HEAD...@{upstream}` 的两个数字：

- `0 0`：完全同步。
- `0 N`：本地只落后；工作区干净时可快进。
- `N 0`：本地有未推送提交；先验证再 push。
- `N M`：已经分叉；停止自动更新，先审查双方提交和冲突风险。

不要假定默认分支叫 `main`。可用以下命令确认：

```bash
git remote show origin
git symbolic-ref -q --short refs/remotes/origin/HEAD
```

```powershell
git remote show origin
git symbolic-ref -q --short refs/remotes/origin/HEAD
```

### 2.2 开始工作前

1. 进入实际仓库根目录。
2. `git status --short --branch` 必须先检查。
3. 确认当前不是 detached HEAD；若 detached，按 11.4 处理。
4. `git fetch --prune origin`。
5. 确认 upstream 和 ahead/behind。
6. 仅在工作区干净且“本地只落后”时快进：

Ubuntu Bash：

```bash
git merge --ff-only '@{upstream}'
```

Windows PowerShell：

```powershell
git merge --ff-only '@{upstream}'
```

7. 若 `package.json` 或 `pnpm-lock.yaml` 自上次工作后变化，执行锁定依赖安装。
8. 开始修改；不要顺手格式化或提交无关文件。

回滚：快进前先记录旧 HEAD。若必须回到旧版本，不覆盖工作区；创建新分支指向旧 HEAD，或按发布回滚流程检出已验证 tag。禁止直接 hard reset。

### 2.3 完成工作后

1. `git status --short`。
2. `git diff --stat` 和 `git diff -- <相关文件>`。
3. 运行构建、类型检查和相关测试；需要发布时运行完整测试。
4. 按第 10 节检查敏感文件。
5. 精确暂存，不使用无审查的 `git add -A`。
6. 查看 `git diff --cached --stat` 和 `git diff --cached`。
7. commit。
8. 普通 push，不 force push。
9. 另一台机器先确认工作区干净，再 fetch 和 `merge --ff-only`。
10. 两台机器分别执行 `git rev-parse HEAD`，结果必须相同。

## 3. Ubuntu 标准操作流程

### 3.1 修改、验证、提交、推送

```bash
cd /home/wujie/Chance/lark-coding-agent-bridge
git status --short --branch
git branch --show-current
git fetch --prune origin
git rev-list --left-right --count "HEAD...@{upstream}"
git merge --ff-only '@{upstream}'   # 仅限工作区干净且本地只落后
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
git status --short
git diff --stat
git diff -- <FILE...>
git add -- <FILE...>
git diff --cached --stat
git diff --cached
git commit -m "<TYPE>: <SUMMARY>"
git push
git fetch origin
git rev-list --left-right --count "HEAD...@{upstream}"
```

成功标准：构建和类型检查退出码为 0；测试结果已记录；staged diff 只有相关文件；push 后 ahead/behind 为 `0 0`。

异常：测试因 Bridge 环境变量失败时，不得 unset 环境变量伪造绿色结果。记录失败用例，必要时让 GitHub CI 的干净环境复核。

### 3.2 从源码全局安装 Bridge

```bash
cd /home/wujie/Chance/lark-coding-agent-bridge
git status --short --branch
git rev-parse HEAD
git describe --tags --exact-match HEAD 2>/dev/null || true
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
npm install --global .
hash -r
command -v lark-channel-bridge
readlink -f "$(command -v lark-channel-bridge)"
lark-channel-bridge --version
npm ls --global --depth=0 lark-channel-bridge
```

说明：本地目录执行 `npm install --global .` 可能形成指向源码目录的 link。必须保留源码目录，并在每次更新后重新构建；若希望安装不可变包，可先 `npm pack`，审查生成文件清单后全局安装生成的 `.tgz`。

### 3.3 重启、状态、日志与端到端验证

不要从即将被重启的 Bridge 会话中直接执行重启。使用外部终端：

```bash
systemctl --user daemon-reload
lark-channel-bridge restart --profile <PROFILE>
lark-channel-bridge status --profile <PROFILE>
lark-channel-bridge ps
systemctl --user status lark-channel-bridge.bot.<PROFILE>.service --no-pager
journalctl --user -u lark-channel-bridge.bot.<PROFILE>.service -n 100 --no-pager
tail -n 100 ~/.lark-channel/profiles/<PROFILE>/logs/daemon/daemon-stderr.log
```

端到端验证：

1. 在飞书私聊向对应 bot 发送唯一测试文本。
2. 确认消息进入正确 Profile 和工作目录。
3. 确认 Agent 只回复一次。
4. 执行 `/status`，确认 Profile、agent、cwd、lark-cli 身份和版本。
5. 在授权范围内执行一个低风险 lark-cli 只读操作，确认 API 可用。
6. 再次重启服务，确认启动后仍能回复。

回滚：按第 7.3 节安装上一已验证 tag，然后重启同一 Profile。保留失败版本日志，不删除 `.lark-channel`。

## 4. Windows 标准操作流程

### 4.1 修改、验证、提交、推送

PowerShell：

```powershell
Set-Location 'D:\lark-coding-agent-bridge'
git status --short --branch
git branch --show-current
git fetch --prune origin
git rev-list --left-right --count "HEAD...@{upstream}"
git merge --ff-only '@{upstream}'   # 仅限工作区干净且本地只落后
corepack pnpm install --frozen-lockfile
corepack pnpm run build:web
corepack pnpm exec tsup
corepack pnpm exec tsc --noEmit
corepack pnpm exec vitest run
git status --short
git diff --stat
git diff -- <FILE...>
git add -- <FILE...>
git diff --cached --stat
git diff --cached
git commit -m "<TYPE>: <SUMMARY>"
git push
git fetch origin
git rev-list --left-right --count "HEAD...@{upstream}"
```

项目部分 npm script 内部直接调用 `pnpm`。若出现 `pnpm is not recognized`，先检查：

```powershell
corepack --version
corepack pnpm --version
Get-Command pnpm -ErrorAction SilentlyContinue
```

在 pnpm 未加入 PATH 时，使用上面的 Corepack 等价命令，不通过复制 Ubuntu 的 `node_modules` 解决。

### 4.2 全局安装、命令路径与版本

```powershell
Set-Location 'D:\lark-coding-agent-bridge'
git status --short --branch
git rev-parse HEAD
git describe --tags --exact-match HEAD
corepack pnpm install --frozen-lockfile
corepack pnpm run build:web
corepack pnpm exec tsup
corepack pnpm exec tsc --noEmit
corepack pnpm exec vitest run
npm install --global .
Get-Command lark-channel-bridge | Format-List Source,Path,CommandType
npm prefix --global
npm root --global
npm ls --global --depth=0 lark-channel-bridge
lark-channel-bridge --version
```

成功标准：命令路径位于预期的 npm 全局目录，版本等于目标版本；测试中的平台失败必须如实记录，不得省略。

### 4.3 后台启动、状态和日志

优先使用项目官方服务命令：

```powershell
lark-channel-bridge restart --profile <PROFILE>
lark-channel-bridge status --profile <PROFILE>
lark-channel-bridge ps
```

当前 Windows 部署还使用 Profile `launcher.cmd` 配合 Startup，现场检查：

```powershell
$ProfileRoot = Join-Path $env:USERPROFILE '.lark-channel\profiles\<PROFILE>'
$Startup = [Environment]::GetFolderPath('Startup')
Get-ChildItem $ProfileRoot -Filter 'launcher.cmd' -Recurse
Get-ChildItem $Startup
Get-ChildItem (Join-Path $ProfileRoot 'logs') -Recurse -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 10 FullName,LastWriteTime,Length
```

不要同时启动 Startup、Task Scheduler 和前台 `run` 三个实例。先用 `lark-channel-bridge ps` 和任务管理器确认只有目标 Profile 的一个实例。

端到端验证与 Ubuntu 相同：唯一测试消息、`/status`、低风险 lark-cli 只读调用、重启后复测。

## 5. 依赖目录处理

规则：

- 不提交 `node_modules`。
- 不在 Windows 与 Ubuntu 之间同步 `node_modules`。
- 不使用普通递归复制迁移 pnpm 依赖目录。
- pnpm 依赖含链接和内容寻址结构，复制可能展开链接、造成文件数量和占用异常增加，也可能带入错误平台的原生二进制。
- 迁移源码后依据 `pnpm-lock.yaml` 在目标机器重新安装。
- 安装后必须重新构建、类型检查并记录测试结果。

Ubuntu：

```bash
rm -rf node_modules   # 仅在确认目标是当前仓库依赖缓存且无用户文件后使用
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Windows：

```powershell
# 删除前先 Resolve-Path 并确认目标是 D:\lark-coding-agent-bridge\node_modules。
Resolve-Path '.\node_modules'
Remove-Item '.\node_modules' -Recurse -Force
corepack pnpm install --frozen-lockfile
corepack pnpm run build:web
corepack pnpm exec tsup
corepack pnpm exec tsc --noEmit
corepack pnpm exec vitest run
```

删除依赖目录是可恢复但耗时的操作，不应作为普通同步步骤；仅在依赖损坏或平台迁移时执行。

## 6. Bridge 源码升级与实际运行版本更新

1. 预检工作区、分支、upstream 和 ahead/behind。
2. fetch，并以 `--ff-only` 更新；或安全检出用户指定的 commit/tag。
3. 记录目标：`git rev-parse HEAD` 和 `git describe --tags --exact-match HEAD`。
4. `pnpm install --frozen-lockfile`。
5. 构建。
6. 类型检查。
7. 测试并记录通过/失败数量与原因。
8. `npm install --global .` 或安装经审查的 `.tgz`。
9. 检查 `command -v`/`Get-Command` 和 npm 全局路径。
10. 检查 `lark-channel-bridge --version`。
11. 从外部终端重启指定 Profile。
12. 检查进程、服务状态和日志。
13. 发送飞书消息进行端到端验证。
14. `/status` 确认实际运行 Profile 和版本。

关键事实：同步源码不会自动更新 npm 全局安装，也不会替换已经运行的 Node.js 进程。即使全局安装是源码 link，运行中进程仍须重启才加载新构建。

失败回滚：保持 `.lark-channel` 不动，检出上一已验证 tag，重新安装依赖、构建、全局安装并重启。若配置格式发生不可逆迁移，先使用项目提供的 export/备份流程；不得手工复制含秘密的配置到 Git。

## 7. 版本发布与回滚

### 7.1 发布前

1. 确认工作区干净。
2. fetch 所有相关 remote 和 tag。
3. 确认当前分支、upstream、默认分支和分支策略。
4. ahead/behind 不得显示本地落后或分叉。
5. 确认目标版本号未被使用：`git tag -l '<VERSION>'` 和 `git ls-remote --tags origin`。
6. 更新 `package.json`、锁文件和必要发布说明。
7. 安装锁定依赖。
8. 构建、类型检查、完整测试。
9. 检查 Windows/Ubuntu 差异；不能用单平台成功代替跨平台验证。
10. 扫描敏感信息，审查工作区 diff。

### 7.2 提交和发布

```bash
git add -- <VERSION_FILES> <RELEASE_NOTES>
git diff --cached --stat
git diff --cached
git commit -m "release: prepare <VERSION>"
git push
git tag -a <VERSION> -m "lark-channel-bridge <VERSION>"
git show --no-patch <VERSION>
git push origin <VERSION>
```

PowerShell 使用相同 Git 命令。

发布 tag 前必须确认 commit push 和 CI/验证结果；普通 push，不 force push。本 Runbook 文档任务不得创建正式 tag。

### 7.3 发布后与回滚

1. 在目标机器 fetch tag。
2. 检出目标 tag 或让稳定分支快进到发布 commit。
3. 构建、全局安装、检查命令版本。
4. 重启 Bridge，检查日志和端到端消息。
5. 记录版本、commit、测试结果、部署机器和时间。

回滚：

```bash
git fetch --tags origin
git switch -c rollback/<DATE>-<OLD_VERSION> <OLD_VERSION>
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
npm install --global .
lark-channel-bridge restart --profile <PROFILE>
```

Windows 将 `pnpm` 命令换为第 4 节的 Corepack 等价命令。回滚分支避免改写历史；验证后再通过正常 commit/PR/merge 流程修正稳定分支。

## 8. 全新 Ubuntu 机器部署

1. 安装 Git 和项目兼容的 Node.js（最低 `>=20.12.0`）。
2. 检查 `node --version`、`npm --version`、`corepack --version`。
3. 安装并登录 Codex CLI 或 Claude Code。
4. clone 仓库；使用 HTTPS 公共地址或已配置的 SSH，不把 Token 放在 URL。
5. 检出用户指定的稳定分支或 tag。
6. 安装、构建、类型检查和测试。
7. 全局安装 Bridge，检查路径和版本。
8. 通过首次运行向导安全创建独立 Profile 和应用凭据。
9. 如需用户 OAuth，仅在私聊中采用前台阻塞授权流程。
10. 前台验证后停止前台实例，再注册 systemd 用户服务。
11. 检查状态、日志和飞书端到端消息。

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/<OWNER>/lark-coding-agent-bridge.git
cd lark-coding-agent-bridge
git fetch --tags origin
git checkout <VERIFIED_TAG_OR_BRANCH>
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
npm install --global .
hash -r
lark-channel-bridge --version
lark-channel-bridge run --profile <PROFILE> --agent <codex|claude> --workspace <WORKSPACE>
```

首次前台验证成功后，按 `Ctrl-C` 停止，再从外部终端：

```bash
lark-channel-bridge start --profile <PROFILE> --agent <codex|claude>
lark-channel-bridge status --profile <PROFILE>
systemctl --user status lark-channel-bridge.bot.<PROFILE>.service --no-pager
```

应用凭据必须由人工安全输入或系统安全存储提供，不能从 Git 获取，不能复用另一台正在消费同一 bot 事件的 Bridge 应用。

## 9. 全新 Windows 机器部署

1. 安装 Git for Windows 和兼容 Node.js。
2. PowerShell 检查 PATH、npm、Corepack 和目标 agent。
3. clone 到 `D:\lark-coding-agent-bridge` 或用户确认的目录。
4. 检出已验证分支/tag。
5. 使用锁文件安装依赖，构建、类型检查、测试。
6. npm 全局安装并检查实际命令路径和版本。
7. 通过首次运行向导安全创建本机独立 `.lark-channel`、应用和 Profile。
8. 必要时在私聊中完成用户 OAuth。
9. 前台验证后停止前台实例，使用项目服务命令注册后台启动；若保留现有 Startup 方案，必须只保留一个启动入口。
10. 检查状态、日志、重启恢复和飞书端到端消息。

```powershell
Set-Location 'D:\'
git clone https://github.com/<OWNER>/lark-coding-agent-bridge.git
Set-Location 'D:\lark-coding-agent-bridge'
git fetch --tags origin
git checkout <VERIFIED_TAG_OR_BRANCH>
corepack --version
corepack pnpm install --frozen-lockfile
corepack pnpm run build:web
corepack pnpm exec tsup
corepack pnpm exec tsc --noEmit
corepack pnpm exec vitest run
npm install --global .
Get-Command lark-channel-bridge | Format-List Source,Path,CommandType
lark-channel-bridge --version
lark-channel-bridge run --profile <PROFILE> --agent <codex|claude> --workspace <WORKSPACE>
```

平台差异：

- PowerShell、CMD 和 Git Bash 的 quoting 不同；文档命令默认 PowerShell。
- 执行策略可能阻止 `.ps1` shim；先诊断 `Get-ExecutionPolicy -List`，不要未经授权降低全局策略。
- PATH 更新后需打开新终端或重新解析命令。
- 部分测试依赖 Bash `sh`；缺少时记录为平台前置条件或使用 Git Bash，不能把失败隐藏。
- Startup 路径使用 `[Environment]::GetFolderPath('Startup')` 获取，不硬编码用户名。

## 10. 凭据与敏感文件操作规则

### 10.1 安全检查 remote

```bash
git remote -v | sed -E 's#(https?://)[^/@]+@#\1<redacted>@#g'
```

```powershell
git remote -v | ForEach-Object { $_ -replace '(https?://)[^/@]+@', '$1<redacted>@' }
```

- HTTPS 报 401、403、credential rejected：HTTPS 凭据或权限问题。
- SSH 报 `Permission denied (publickey)`：SSH key 未授权、agent 未加载或 remote 主机/账号不匹配。
- 不为排错输出 credential helper 内容、私钥或带 Token 的 URL。

### 10.2 必须保持本地

- `~/.lark-channel` / `$env:USERPROFILE\.lark-channel` 全部内容。
- `secrets.enc`、Profile 配置、sessions、session-meta、workspaces、lark-cli 目录。
- `robot.json`、SSH 私钥、OAuth token、二维码、附件缓存和日志。
- `.env*` 中的本地秘密。

### 10.3 提交前扫描

Ubuntu Bash：

```bash
git status --short
git diff --name-only
git diff --cached --name-only
git ls-files | rg -i '(^|/)(\.lark-channel|node_modules|logs?|sessions\.json|robot\.json|secrets\.enc)(/|$)|\.tmp-lark-auth-qr\.png$'
git diff --cached | rg -n 'Bearer [A-Za-z0-9._-]+|BEGIN (RSA |OPENSSH )?PRIVATE KEY|app[_ -]?secret|oauth[_ -]?token' || true
```

Windows PowerShell：

```powershell
git status --short
git diff --name-only
git diff --cached --name-only
git ls-files | Select-String -Pattern '\.lark-channel|node_modules|sessions\.json|robot\.json|secrets\.enc|\.tmp-lark-auth-qr\.png'
git diff --cached | Select-String -Pattern 'Bearer [A-Za-z0-9._-]+|BEGIN (RSA |OPENSSH )?PRIVATE KEY|app[_ -]?secret|oauth[_ -]?token'
```

关键字扫描会命中文档中的规则文字，必须人工判断；任何看似真实的值都停止提交。`.gitignore` 不能自动取消已经被 Git 跟踪的文件。

凭据泄露：停止 push；若已推送，立即报告并要求在对应系统轮换/撤销凭据，再由仓库管理员决定历史清理方案。不要擅自 force push 重写公共历史。

### 10.4 用户 OAuth 操作

只在用户与 bot 的 p2p 私聊中发起；群聊中不得发起 device flow。Bridge/Agent 应保持等待进程在前台存活：

```bash
lark-cli auth login --no-wait --json --recommend
lark-cli auth login --device-code <DEVICE_CODE>
```

第一条命令返回的 `verification_url` 原样发给用户，不转成 Markdown 链接，不输出其他凭据。第二条命令必须前台阻塞至用户完成或超时，不放入后台。成功后由 Agent 内部收敛当前 profile 的身份策略：

```bash
lark-cli config strict-mode off
lark-cli config default-as auto
```

不要把内部身份策略命令交给用户判断。若当前 profile 已有用户授权但身份策略拒绝 `--as user`，先内部执行策略收敛，再重试原命令。若 Bridge 报 context 未绑定，按 11.22 停止，不自行 bind。

## 11. 常见故障排查

### 11.1 有未提交修改，无法安全 pull

- 现象：`git status` 非空，pull/merge 可能覆盖文件。
- 可能原因：本地开发、生成文件或用户未完成工作。
- 只读诊断：`git status --short`、`git diff --stat`、`git diff`。
- 安全修复：先提交到独立分支，或让用户决定是否 stash；Agent 不擅自 stash/丢弃。
- 验证：工作区状态和保存位置明确后再 fetch/merge。
- 回滚：恢复保存分支或用户明确创建的 stash。

### 11.2 两台机器修改同一文件

- 现象：双方都有未推送修改或远端已变化。
- 原因：工作前未 fetch，任务边界重叠。
- 诊断：双方记录 HEAD、`git diff`、`git log --left-right HEAD...origin/<BRANCH>`。
- 安全修复：先保存各自分支，由人工决定整合顺序；不互相覆盖。
- 验证：整合后测试、diff 审查，两台 HEAD 一致。
- 回滚：保留双方原分支。

### 11.3 merge/rebase conflict

- 现象：Git 标记 unmerged paths。
- 原因：同一区域发生不兼容修改。
- 诊断：`git status`、`git diff --name-only --diff-filter=U`。
- 安全修复：理解双方意图后逐文件解决；不使用整边 checkout 覆盖。
- 验证：无冲突标记，测试和 diff 通过。
- 回滚：在未产生新工作时使用 `git merge --abort` 或 `git rebase --abort`；不 hard reset。

### 11.4 detached HEAD

- 现象：`git branch --show-current` 为空。
- 原因：检出 tag 或 commit。
- 诊断：`git rev-parse HEAD`、`git describe --tags --exact-match HEAD`、`git branch -a --contains HEAD`。
- 安全修复：只读验证可留在 detached；需要提交时创建 `git switch -c <SAFE_BRANCH>`，或切到确认的远端分支。
- 验证：`git symbolic-ref --short HEAD` 返回分支。
- 回滚：删除新分支前需确认提交已保留在其他引用；未经授权不删除。

### 11.5 push non-fast-forward

- 现象：push 被拒绝。
- 原因：远端分支有新提交。
- 诊断：fetch 后查看 ahead/behind 和双方 log。
- 安全修复：保存本地工作，正常 merge/rebase 需用户或分支策略授权；不 force push。
- 验证：整合测试后普通 push 成功。
- 回滚：保留整合前分支引用。

### 11.6 HTTPS 认证失败

- 现象：401/403、无法读取用户名或凭据被拒绝。
- 诊断：查看脱敏 remote、确认仓库权限和 credential helper 类型。
- 安全修复：让用户通过 GitHub 官方登录/credential manager 授权，或确认后改用已授权 SSH remote。
- 验证：`git fetch` 和普通 push 成功。
- 回滚：保留本地 commit；恢复原 remote URL 时不含 Token。

### 11.7 SSH Permission denied

- 现象：`Permission denied (publickey)`。
- 诊断：`ssh -T git@github.com`，只报告账号识别结果，不输出 key。
- 安全修复：用户在 GitHub 添加本机公钥或修正 remote；Agent 不读/输出私钥。
- 验证：SSH 测试识别正确账号，fetch/push 成功。
- 回滚：保留本地 commit和原 remote 记录。

### 11.8 pnpm 不在 PATH

- 现象：`pnpm: command not found` 或 `pnpm is not recognized`。
- 诊断：`corepack --version`、`corepack pnpm --version`、命令路径。
- 安全修复：优先 `corepack pnpm ...`；需要脚本内部调用 pnpm 时按 Node/Corepack 官方方式启用 shim，并重开终端。
- 验证：`pnpm --version` 与 packageManager 声明一致。
- 回滚：不改项目文件；恢复 PATH 前记录原值。

### 11.9 Corepack 可用但项目脚本找不到 pnpm

- 现象：`corepack pnpm run build` 内部报 `pnpm is not recognized`。
- 原因：npm script 中再次直接调用 `pnpm`。
- 诊断：检查 `package.json` scripts。
- 安全修复：Windows 使用 `corepack pnpm run build:web`、`corepack pnpm exec tsup` 等分解命令；或安全启用 Corepack shim。
- 验证：web build 和 tsup 均成功。
- 回滚：无需修改源码。

### 11.10 pnpm 依赖复制后膨胀

- 现象：文件数和磁盘占用异常，原生模块不兼容。
- 原因：链接被复制工具展开或跨平台复制。
- 诊断：确认 node_modules 来源和目标平台。
- 安全修复：验证目标后删除目标机器的 `node_modules`，使用锁文件重装。
- 验证：构建、类型检查和测试。
- 回滚：依赖可重建；不要删除源码和私有数据。

### 11.11 Windows 缺少 `sh`

- 现象：测试或脚本报找不到 `sh`。
- 诊断：`Get-Command sh -ErrorAction SilentlyContinue`，定位具体测试是否声明 Unix 前置条件。
- 安全修复：使用 Git Bash 或使测试按平台跳过/模拟；不得把真实功能失败简单忽略。
- 验证：重跑受影响测试并记录平台。
- 回滚：撤销未经验证的 PATH 改动。

### 11.12 平台相关测试失败

- 现象：单一 OS 失败，其他平台通过。
- 诊断：保存用例名、断言、OS、Node/pnpm 版本；查看路径、权限位、shell 和原生二进制差异。
- 安全修复：修正平台语义或测试模拟，不用 blanket skip 隐藏真实功能。
- 验证：目标平台重跑，必要时三平台 CI。
- 回滚：回到上一已验证 commit。

### 11.13 源码、全局安装和运行版本不一致

- 现象：Git tag 新，但 `--version` 或 `/status` 仍旧。
- 诊断：`git rev-parse HEAD`、`npm ls -g`、命令路径、`lark-channel-bridge ps`。
- 安全修复：重新构建和全局安装，确认命令路径，再重启正确 Profile。
- 验证：三处版本一致，端到端消息正常。
- 回滚：重新安装上一已验证 tag。

### 11.14 全局安装后仍运行旧版本

- 现象：CLI 是新版本，进程仍旧。
- 原因：旧 Node 进程未重启或启动项指向另一命令。
- 诊断：进程命令行、`Get-Command`/`command -v`、服务 unit/launcher。
- 安全修复：从外部终端重启指定 Profile，清理重复启动入口需用户确认。
- 验证：`ps`、`/status`、日志和消息。
- 回滚：恢复上一安装版本并重启。

### 11.15 Profile 配置异常

- 现象：Profile 找不到、agent/cwd/app 不符。
- 诊断：`profile list`、`status --profile`、低敏日志；不直接输出 secret 文件。
- 安全修复：优先项目 `migrate`、`profile`、`/config` 流程；删除/重建前先 stop/unregister 并取得授权。
- 验证：Profile、服务和 bot 身份正确。
- 回滚：使用脱敏 export/项目归档机制；不把 secret export 提交。

### 11.16 Bridge 后台启动失败

- 现象：status inactive/failed。
- 诊断：服务状态、daemon stderr、命令路径、Node 路径、配置目录权限。
- 安全修复：修正明确原因；systemd unit 变化后 daemon-reload；不要盲目重装私有数据。
- 验证：服务 active、日志无持续错误、消息可达。
- 回滚：恢复上一可用全局版本或启动配置。

### 11.17 Windows Startup 未运行

- 现象：登录后无 Bridge 进程。
- 诊断：Startup 目录、`launcher.cmd` 路径、任务计划程序、日志、重复入口。
- 安全修复：使用项目官方 `start`，或在确认后修复唯一 Startup 快捷方式。
- 验证：注销/登录或手动启动后只有一个实例。
- 回滚：恢复原 Startup 项；不删除 Profile。

### 11.18 Ubuntu systemd 未运行

- 现象：用户服务 inactive/failed。
- 诊断：`systemctl --user status`、`journalctl --user -u`、`loginctl show-user`。
- 安全修复：`daemon-reload` 后由项目 `start/restart` 管理；无人登录常驻需求需确认 linger 策略。
- 验证：重启/重新登录后服务恢复并能收消息。
- 回滚：恢复上一 unit/全局安装版本。

### 11.19 OAuth 授权超时

- 现象：device flow 超时或进程被回收。
- 诊断：确认在 p2p、前台 wait 进程仍存活、链接未过期。
- 安全修复：p2p 中重新发起两阶段授权，原样展示 verification URL，并让 wait 前台阻塞；群聊禁止发起。
- 验证：授权完成后 status 显示 user-ready，低风险用户 API 成功。
- 回滚：保持 bot-only；撤销不需要的授权由用户在平台完成。

### 11.20 飞书 scope 或权限不足

- 现象：API 返回 permission/scope 错误。
- 诊断：记录 API、错误码和缺少的 scope，不输出 token。
- 安全修复：在开放平台申请最小必要权限并发布应用版本。
- 验证：相同低风险 API 成功。
- 回滚：撤回不需要的 scope。

### 11.21 Agent 能回复但不能通过 lark-cli 操作飞书

- 现象：普通回复可用，lark-cli API 失败。
- 诊断：`/status` 的 lark-cli 摘要、preflight/doctor、profile-local lark-cli 目录权限。
- 安全修复：重启当前 Profile；仍失败时检查 App Secret 有效性和 lark-cli 版本支持，不自行 bind。
- 验证：应用身份和授权用户身份的低风险操作按策略成功。
- 回滚：保持 bot-only，撤销错误身份策略变更。

### 11.22 lark-channel context 未绑定

- 现象：`lark-channel context detected but lark-cli is not bound to it`。
- 诊断：只记录错误和当前 Profile；不读取 config.json 中的凭据。
- 安全修复：停止当前操作，要求重启 Bridge 或运行 doctor/preflight。
- 验证：普通 lark-cli 在 Bridge 注入环境中自动进入正确 profile，命令成功。
- 回滚：不切换普通 profile，不 unset Bridge 环境变量，不自行 bind。

## 12. 验证与成功标准

每次关键流程至少记录：

- Git：本地 HEAD 与远端跟踪分支 commit 一致，ahead/behind `0 0`。
- 构建：`dist/cli.js`、`dist/index.js`、`dist/robot-cli.js` 和生成 UI 存在，构建退出码 0。
- 类型检查：退出码 0。
- 测试：总数、通过数、失败数、失败用例和环境；不只写“基本通过”。
- 全局安装：命令路径和 `lark-channel-bridge --version` 正确。
- 运行：目标 Profile 只有一个 Bridge 实例，服务 active。
- 日志：无持续重复错误；单次预期测试 warning 不等于运行故障。
- 飞书：消息进入 Agent、只回复一次、lark-cli 可执行授权范围内 API。
- 恢复：重启或重新登录后仍能运行。

### 12.1 2026-08-28 Windows 记录（用户提供）

- 源码目录：`D:\lark-coding-agent-bridge`。
- D 盘源码构建成功。
- TypeScript 类型检查通过。
- 完整测试：700 项，695 通过、5 失败。
- 失败涉及 Windows 缺少 `sh`、Codex 测试二进制兼容性和当前 Bridge 环境变量。
- 全局运行：npm 全局 Bridge `0.8.0`。
- 结论：构建可用，但测试不是全绿；相关差异仍需后续修复或明确平台预期。

### 12.2 2026-08-28 Ubuntu 记录（本机实测）

- 源码：`/home/wujie/Chance/lark-coding-agent-bridge`。
- HEAD/tag：`5e2aabb9bc9fd251ca5c5851a7f75b14f791a844` / `v0.8.0`。
- `pnpm build`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：700 项，698 通过、2 失败。
- 失败用例：
  - `tests/integration/cli/secrets-profile.test.ts` 的 active-first secret 解析断言。
  - `tests/unit/cli/preflight.test.ts` 的首次 bind 环境变量断言。
- 两项失败均发生在当前 Bridge 注入 `LARK_CHANNEL*` / profile-local lark-cli 环境中；未 unset 环境变量绕过。
- 全局安装和运行版本：`0.8.0`。
- Profile：`codex`，systemd 用户服务 active。
- 结论：构建与类型检查通过，测试不是全绿；干净 CI 与 Bridge 内嵌环境必须分别记录。

## 13. 快速操作清单

### 开始工作前

- [ ] 进入正确仓库。
- [ ] 查看 status、分支、HEAD、upstream。
- [ ] 确认不是 detached HEAD。
- [ ] fetch。
- [ ] 判断 ahead/behind；有修改或分叉先停。
- [ ] 阅读本 Runbook 和本次任务边界。

### 提交前

- [ ] 查看 status、diff、相关测试结果。
- [ ] 扫描敏感文件和凭据特征。
- [ ] 精确暂存相关文件。
- [ ] 查看 staged stat 和完整 staged diff。
- [ ] 确认无冲突标记、无无关文件。
- [ ] 必要时同步更新 Runbook。

### 推送后

- [ ] fetch。
- [ ] ahead/behind 为 `0 0`。
- [ ] 远端包含新 commit。
- [ ] 记录 remote、分支和 commit。
- [ ] 另一台机器安全快进并核对 HEAD。

### 发布前

- [ ] 工作区干净且不落后远端。
- [ ] 版本号/tag 未被使用。
- [ ] 锁定依赖、构建、类型检查、完整测试。
- [ ] 平台差异和敏感信息已审查。
- [ ] commit 已 push 且验证通过。

### 发布后

- [ ] tag 已普通 push。
- [ ] 全局安装版本正确。
- [ ] 正确 Profile 已重启。
- [ ] 状态、日志、端到端消息通过。
- [ ] 记录结果和回滚目标。

### 新机器部署后

- [ ] 命令路径、版本和源码 commit 已记录。
- [ ] 独立应用、Profile 和私有目录已创建。
- [ ] 凭据未进入 Git/聊天/日志。
- [ ] 只有一个后台启动入口和一个实例。
- [ ] 重启恢复和飞书 API 验证通过。

### 故障排查

- [ ] 先只读采集，不改配置。
- [ ] 明确源码/全局安装/运行版本。
- [ ] 明确 OS、shell、Node、pnpm 和 Profile。
- [ ] 保留用户修改和本地 commit。
- [ ] 不输出秘密、不 force push、不 hard reset。
- [ ] 修复后复现原验证步骤并更新本文。

## 14. 文档维护规则

以下变化必须更新本文：

- 源码目录、默认分支、remote 或分支策略变化。
- Node.js、Corepack、pnpm、锁文件或安装方式变化。
- 构建、测试、全局安装、启动、发布或回滚命令变化。
- Profile、后台服务、Startup/systemd 或开机启动方式变化。
- `.lark-channel` 结构、凭据或 OAuth 配置流程变化。
- Git 认证、CI/CD、tag 或 Release 流程变化。
- 新增机器、操作系统或部署环境。
- 实际操作发现步骤错误、遗漏或过时。
- 新增典型故障和已经验证的解决方法。
- 官方流程或安全约束变化。

以后 Agent 执行同步、部署、升级或发布时必须：

1. 先阅读本文。
2. 对照实际环境验证目录和命令。
3. 发现不一致时不静默绕过。
4. 完成本次安全诊断和已授权操作。
5. 同时修正本文。
6. 标明步骤在 Windows、Ubuntu 或双平台的验证状态。
7. 未验证内容写“待验证”，不把推测写成事实。
8. 检查文档工作区 diff 和 staged diff。
9. 通过正常 commit/push 提交文档更新。
10. 最终报告说明文档更新、实测结果和仍待验证项。

更新本文时不要复制聊天记录。把经验整理为适用场景、前置条件、步骤、验证、失败表现、安全修复、回滚、平台差异和安全注意事项。头部的最后更新日期、验证日期、版本、commit 和平台状态必须同步维护。
