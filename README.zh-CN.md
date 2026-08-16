# dsh-taskboard-plugin

[English](README.md) | 简体中文

面向 DeepSeek Harness（DSH）的 issue 看板 —— Settings 上方的侧栏快捷入口（点击在主区整页打开）、会话主区视图、agent 工具与托管式本地服务，集于一个自包含插件之中。

自 `0.2.0` 起，该包已完全自包含：Taskboard 应用（一个零依赖、纯 Node 的 issue 看板服务，自带预构建的 Web UI）以内置（vendored）方式收纳在包内的 `app/` 之下。安装了这个插件，就完成了全部所需的安装。

## 功能特性

- **托管式环回服务** —— 插件将内置的 Taskboard 服务器作为仅绑定 `127.0.0.1` 的本地子进程加以监管：spawn 启动 + `/health` 等待（就绪超时 30 秒）、日志转发、崩溃后按指数退避重启（以 `restartBackoffMs` 为基数，上限 30 秒；连续失败 5 次后放弃 —— 重试需经 `service_start`），以及在插件 dispose 时对整棵进程树执行 tree-kill（Windows 上用 `taskkill /T`，POSIX 上按进程组 kill）。如果端口已被一个健康的 Taskboard 实例占用，插件会**接管（adopt）**该实例而不是再启动第二个，并且在停止/销毁时绝不会杀死被接管的实例（接管要求满足 Taskboard 的 `/health` JSON 契约 —— 一个只会返回 200 的普通应答者不会被接管）。子进程环境是一个显式允许列表（allowlist）外加 `TASKBOARD_*` 契约变量 —— 绝不整体继承 `process.env`。
- **`taskboard` agent 工具** —— 通过单一 `command` 参数提供 13 个子命令：
  - 读取：`project_list`、`project_get`、`issue_list`、`issue_get`、`comment_list`
  - 写入：`project_map`、`issue_create`、`issue_update`、`issue_move`、`comment_add`、`relation_add`
  - 生命周期：`service_start`、`service_stop`

  写入操作会自动归属到当前 DSH 会话（显式 `threadId` 参数优先，其次是 agent 会话 id，再次是 `DSH_SESSION_ID`；三者皆缺失 → 写入被拒绝）。`project_map` 将项目绑定到本地工作区路径（属于变更操作，与其他写入一样按会话归属）。Issue 写入采用乐观锁：省略 `ifVersion` 即复用最新版本；HTTP 409 `VERSION_CONFLICT` 会原样上抛，以便 agent 重新读取后重试一次。Issue 状态：`backlog`（未批准执行）、`todo`、`in_progress`、`in_review`、`blocked`、`done`、`canceled`。
- **侧栏快捷入口** —— 左侧栏底部、Settings 按钮正上方有一条独立的 **Taskboard** 快捷方式（图标+文字），走官方 `sidebar.footer.action` 插槽（与内置面板占用者同一接缝；外壳向占用者传递 `wide` 标志）。点击即把当前会话切到看板主区视图（画面铺满右侧 conversation 列，与下方主区视图同一渲染）；收起为 56px 轨道时为纯图标按钮，点击先展开侧栏再切换。没有已打开的会话时，点击会先新建一个会话再展示。入口自身不含任何面板。点击侧栏会话列表中的会话行总是落到对话视图（若该会话停在看板视图，会自动切回对话；轨迹视图不受影响）。
- **会话主区视图** —— 看板画面走官方 `conversation.view` 插槽（与内置"轨迹"视图同一接缝），以 iframe 直连 `http://127.0.0.1:<port>/` 铺满整个会话主区。按需求，入口不再以页签形式出现在会话头部【对话】【轨迹】之后——页签按钮在 DOM 层隐藏（宿主页签环无官方隐藏选项），但注册保留：侧栏快捷方式的点击即程序化点击该隐藏页签（与用户手点同一条 `actions.setView` 激活路径），切回用可见的【对话】/【轨迹】页签。外壳遵循 DSH 主题 token（带回退值）；iframe 内部的主题则是 Taskboard 应用自带的。当服务未运行时，视图会降级为“服务未运行（service not running）”界面，并提供**重试（Retry）**与**在系统浏览器中打开（Open in system browser）**（裸环回 URL，不含凭据）。

  <!-- screenshot here -->
- **端口/状态通道** —— 客户端从注册在 GUI Web 服务器上的同源路由解析实际端口与监管器状态：`GET /plugins/taskboard/config.json` → `{ ok, port, status }`（状态：`ready / adopted / starting / restarting / stopped / failed / disposed`）。若该路由不可用，视图会回退到约定默认端口 `47823`。
- **运行时 skill 注册** —— 插件在加载时向 DSH skill 注册表注册一个 `taskboard` skill，并在禁用时将其撤下。它向 agent 传授工具侧的用法（认领纪律、`backlog` = 未批准、409 仅重试一次、按会话归属）。同名的用户级 skill 文件会按名字遮蔽这一运行时注册。

## 安装

主要方式 —— 从 GitHub 安装，然后重启 GUI：

```bash
dsh plugin --profile <name> add github:af2000-tech/dsh-taskboard-plugin
dsh --profile <name>   # （重新）启动 GUI
```

插件图（plugin graph）在 GUI 启动时组装：向一个 GUI 已在运行的 profile 安装插件，只会在 GUI 重启之后生效（这是已验证的契约）。本仓库将构建产物（`dist/`、`lib/`）直接提交进仓库，因此安装**无需构建脚本、也无需构建权限** —— 安装时不运行任何东西。

该包自包含：不需要外部的 taskboard 检出，也没有额外下载。数据默认落在 `~/.dsh/taskboard/data`（尊重 `$DSH_HOME` 设置）。

备选方式 —— tarball：

```bash
npm pack                                    # → dsh-taskboard-plugin-0.2.0.tgz
dsh plugin --profile <name> add file:<path-to-tgz>
```

重复添加同一版本是空操作；强制重装重新打包的 tarball 时，请先运行 `dsh plugin --profile <name> remove dsh-taskboard-plugin`。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `port` | `47823` | Taskboard 服务端口（仅环回 —— 始终为 `127.0.0.1`） |
| `dataDir` | `""` | SQLite 数据目录；留空 = `$DSH_HOME/taskboard/data`（未设置 `DSH_HOME` 时为 `~/.dsh/taskboard/data`） |
| `autoStart` | `true` | 插件加载时即启动服务；`false` 表示推迟到首次工具调用或 `service_start` |
| `restartBackoffMs` | `3000` | 崩溃重启的退避基数，单位毫秒（指数增长，上限 30 秒；连续失败 5 次后放弃） |
| `appRoot` | `""` | 留空 = 本包内置的应用（常规路径）。可设置为外部 Taskboard 应用根目录（一个包含 `server/index.mjs` 的检出）以改用它运行 —— 这是逃生通道，不是常规路径 |

> **整行重述警告（cordis patch 语义）：** profile 的 `cordis.patch.yml` 中针对 `id: taskboard` 的条目会**替换整行配置** —— 它不会与 bundle 层的配置做深度合并。哪怕只覆盖一个键（例如只改 `port`），也请把你关心的每个键都重述一遍：被省略的键会回退到上表的 schema 默认值，而不是 bundle 层的取值。

## 架构

双半（dual-half）cordis 插件：

- **宿主端（host half）**（`dist/host.js`，ESM，peer 依赖外部化）—— `TaskboardService` 监管器、`taskboard` 工具注册、同源状态路由，以及运行时 skill 注册（web 服务器 / skills 等服务采用惰性注入，因此无头 profile 也能正常加载该插件）。
- **客户端（client half）**（`lib/client.js`）—— 一个画面 + 一个入口：`conversation.view` 主区视图（与内置“轨迹”视图同一官方接缝，看板 iframe 铺满主区）与渲染于 Settings 正上方的 `sidebar.footer.action` 快捷方式（点击程序化激活隐藏页签，把当前会话切到看板视图；无会话时先新建）。会话头部的 Taskboard 页签按钮在 DOM 层隐藏（入口唯一化为侧栏快捷方式）；切回用可见的 对话/轨迹 页签。服务源（origin）仅从端口通道解析；当监管器状态不为 `ready`/`adopted` 时，视图降级为重试 / 在系统浏览器中打开。
- **两半之间的契约** —— 单一同源 JSON 路由（`config.json`）加上约定默认端口 `47823`；不做跨源配置访问，也没有额外的 Web 暴露面。（宿主端还代理了一个同源辅助路由 `POST /plugins/taskboard/bind-task`，供看板 UI 将 issue 绑定到某个会话线程。）

依赖：内置应用零 npm 依赖（纯 Node；从 `app/dist/web/` 提供其预构建的 Web UI）。宿主端只使用 Node 内置模块（`child_process`、`fs`、`os`、`path`、`url`）；全部插件 peer 依赖在运行时由 DSH 宿主提供 —— 不会随插件安装任何东西。

## 开发

```bash
npm install
npm run build        # esbuild → dist/host.js + lib/client.js
npm run typecheck    # tsc --noEmit（严格模式）
npm run vendor       # 从上游 Taskboard 应用的本地检出重新同步内置的 app/
```

`npm run vendor` 会将上游应用同级检出中的 `server/`、`shared/`、`cli/`、`skills/`、`dist/web/`、`LICENSE` 与 `PRIVACY.md` 镜像同步到 `app/`（源位置在 `scripts/vendor-app.mjs` 内解析）。修改 `src/` 之后，请重新构建并提交 `dist/` + `lib/` —— 发布出去的安装绝不能依赖构建脚本。

## 致谢

`app/` 下内置的应用是 [@chuspeeism](https://github.com/chuspeeism) 的 **[dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)** 的一个 fork，更名为 **Taskboard**。由衷感谢原作者打磨出这样一款精致完善的看板应用并将其开源 —— 看板应用的设计与实现的全部功劳均属于原作者。🙏

## 许可证

Apache-2.0。
