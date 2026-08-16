// dsh-taskboard-plugin — Host 半边（T5.2/T5.6 实现；骨架 T5.1 预搭）。
// 契约 C5：静态 bundle 的 Host 半边 = 普通 ESM cordis 插件，导出 name/inject/Config/apply。
// 参照实证：docs/dsh-inbox-reference.md §2（dsh-tool-todo）；API 面 docs/api-notes.md。
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import z from "@deepseek-ai/schemastery";

import { createTaskboardTool, type TaskboardServiceLike } from "./tools";

export const name = "taskboard";

/** Host 侧依赖的 cordis 服务：tools（注册 taskboard 工具）。 */
export const inject = ["tools"];

/**
 * 配置面（T5.6）。默认值必须与 cordis.patch.yml 的行 config 保持一致
 * （dsh-inbox-reference.md §2.1.1 推论：profile patch 整行替换语义）。
 */
export const Config = z.object({
  /** Taskboard 服务 HTTP 端口（服务强制绑定 127.0.0.1）。 */
  port: z.number().default(47823).description("Taskboard service port (loopback only)"),
  /** SQLite 数据目录；空 = $DSH_HOME/taskboard/data（无 DSH_HOME 时 ~/.dsh/taskboard/data）。 */
  dataDir: z.string().default("").description("SQLite data directory; empty = $DSH_HOME/taskboard/data"),
  /** 启用插件时自动拉起服务进程；false 时首个工具调用或 service_start 再拉起。 */
  autoStart: z.boolean().default(true).description("Start the managed service automatically"),
  /** 子进程崩溃后的重启退避基数（毫秒，指数退避封顶 30s，连败 5 次放弃）。 */
  restartBackoffMs: z.number().default(3000).description("Crash restart backoff base in ms"),
  /** taskboard 应用根目录（server/index.mjs 所在仓库）；空 = 包内 vendored 应用（dist/ 的 ../app）。 */
  appRoot: z.string().default("").description("Taskboard app root; empty = vendored app inside the package"),
});

export interface TaskboardConfig {
  port: number;
  dataDir: string;
  autoStart: boolean;
  restartBackoffMs: number;
  appRoot: string;
}

/** 本插件用到的日志面（cordis LoggerService 结构兼容）。 */
export interface ServiceLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface ServiceOptions {
  port: number;
  serverEntry: string;
  dataDir: string;
  restartBackoffMs: number;
  logger: ServiceLogger;
}

const READY_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_PROBE_TIMEOUT_MS = 1_500;
const KILL_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_BACKOFF_MS = 30_000;

/**
 * 子进程 env 白名单（T7.3 B1/B3）：不整包继承 process.env——DSH 凭据类变量
 * （credentials/settings 相关）不得泄漏进子进程。Windows 基础（SYSTEMROOT 等）
 * 为 node 运行必需；DSH_SESSION_ID 为 T5.5 会话透传契约；DSH_HOME 供诊断路径。
 * 上游 server 不读其他宿主变量（TASKBOARD_* 之外仅按需 PATH）。
 */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "DSH_HOME",
  "DSH_SESSION_ID",
] as const;

/** 构造子进程最小 env：白名单变量 + TASKBOARD_* 契约 + NODE_ENV=production（B2）。 */
function buildChildEnv(port: number, dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    TASKBOARD_PORT: String(port),
    TASKBOARD_HOST: "127.0.0.1",
    TASKBOARD_DATA_DIR: dataDir,
  };
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** taskboard 子进程监督器：拉起 / 就绪等待 / 收养 / 崩溃重启 / 树杀清理。 */
export class TaskboardService implements TaskboardServiceLike {
  readonly port: number;
  private readonly serverEntry: string;
  private readonly dataDir: string;
  private readonly restartBackoffMs: number;
  private readonly logger: ServiceLogger;
  private child: ChildProcess | null = null;
  private adopted = false;
  private disposed = false;
  private manualStop = false;
  private ready = false;
  private consecutiveFailures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;
  private stderrTail = "";
  /** EADDRINUSE 让位等终态失败的原因（config.json 状态通道透传给 client 半边诊断）。 */
  private failedReason: string | null = null;

  constructor(options: ServiceOptions) {
    this.port = options.port;
    this.serverEntry = options.serverEntry;
    this.dataDir = options.dataDir;
    this.restartBackoffMs = Math.max(0, options.restartBackoffMs);
    this.logger = options.logger;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * 监督器状态快照（M6 config.json 状态通道）：ready/adopted=可服务，
   * starting/restarting=过渡，stopped=手动停，failed=终态失败，disposed=已清理。
   * client 半边据此判定降级视图——盲探 /health 会被端口上的任意 HTTP 占用者骗过。
   */
  get status(): string {
    if (this.disposed) return "disposed";
    if (this.adopted) return "adopted";
    if (this.starting !== null) return "starting";
    if (this.child) return this.ready ? "ready" : "starting";
    if (this.restartTimer !== null) return "restarting";
    if (this.failedReason !== null) return "failed";
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return "failed";
    if (this.manualStop) return "stopped";
    return "stopped";
  }

  async probeHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.origin}/health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
      if (!response.ok) return false;
      // 认 taskboard 的 /health 契约（JSON {status:"ok"}）：任意 200 占用者（如哑代理）不得触发收养。
      const body: unknown = await response.json().catch(() => null);
      return (body as { status?: unknown } | null)?.status === "ok";
    } catch {
      return false;
    }
  }

  async start(explicit = false): Promise<void> {
    if (this.disposed) throw new Error("taskboard service supervisor is disposed");
    if (explicit) {
      // 手动/懒启动给一轮全新的崩溃计数。
      this.consecutiveFailures = 0;
      this.manualStop = false;
    }
    if (this.adopted || this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.#doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async ensureReady(): Promise<void> {
    if (this.disposed) throw new Error("taskboard service supervisor is disposed");
    if (this.manualStop) {
      throw new Error('taskboard service is stopped; call the taskboard tool with command "service_start" to start it');
    }
    if (!(this.adopted || this.child)) {
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error('taskboard service gave up after repeated crashes; call the taskboard tool with command "service_start" to retry');
      }
      // 工具调用是显式动作：autoStart=false 时按需懒启动。
      await this.start(true);
      return;
    }
    await this.start();
    if (!(await this.probeHealth())) {
      throw new Error(`taskboard service at ${this.origin} is not healthy (probe failed)`);
    }
  }

  async stop(): Promise<{ status: string; port: number }> {
    this.manualStop = true;
    this.#clearRestartTimer();
    if (this.adopted) {
      this.logger.info(`taskboard: instance on port ${this.port} was adopted, not ours to stop — leaving it running`);
      return { status: "adopted-left-running", port: this.port };
    }
    if (this.child) {
      await this.#killTree(this.child);
      return { status: "stopped", port: this.port };
    }
    return { status: "already-stopped", port: this.port };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.#clearRestartTimer();
    if (this.adopted) {
      this.logger.info(`taskboard: adopted instance on port ${this.port} left running on dispose`);
      return;
    }
    if (this.child) await this.#killTree(this.child);
  }

  async #doStart(): Promise<void> {
    try {
      await access(this.serverEntry);
    } catch {
      throw new Error(
        `Taskboard server entry not found: ${this.serverEntry}. `
        + 'The plugin package is missing its bundled app/ — reinstall it. '
        + '(Or set the plugin "appRoot" config to an external taskboard app root.)',
      );
    }

    // 端口已有健康实例 → 收养模式：不 spawn，dispose 不杀（ADR-12 直连路径共享同一服务）。
    if (await this.probeHealth()) {
      this.adopted = true;
      this.consecutiveFailures = 0;
      this.failedReason = null;
      this.logger.info(
        `taskboard: adopted an existing healthy service on port ${this.port} (no subprocess spawned; it is left running on dispose)`,
      );
      return;
    }

    const child = spawn(process.execPath, [this.serverEntry], {
      env: buildChildEnv(this.port, this.dataDir),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", // POSIX 进程组便于树杀；Windows 走 taskkill /T
    });
    this.child = child;
    this.stderrTail = "";
    this.#pipeLogs(child);

    let exitedEarly = false;
    this.ready = false;
    child.once("exit", (code, signal) => {
      exitedEarly = true;
      this.child = null;
      const wasReady = this.ready;
      this.ready = false;
      if (this.disposed || this.manualStop) return;
      if (wasReady) {
        // 就绪后崩溃：监督器负责重启。
        this.logger.warn(`taskboard: service exited unexpectedly (code=${code} signal=${signal}); scheduling restart`);
        this.#scheduleRestart();
      }
      // 启动期退出：由 #doStart 的失败路径统一决定（EADDRINUSE 清晰报错 / 崩溃计数重启），
      // 避免与 waitReady 分析竞争（重启 timer 搭上垂死的 in-flight promise 会让连败计数断链）。
    });

    try {
      await this.#waitReady(child, () => exitedEarly);
      this.ready = true;
      this.consecutiveFailures = 0;
      this.failedReason = null;
      this.logger.info(`taskboard: service ready at ${this.origin} (data: ${this.dataDir})`);
    } catch (error) {
      // EADDRINUSE：端口被占。若占用者健康 → 收养；否则给清晰错误（不走 5 轮重试）。
      if (this.stderrTail.includes("EADDRINUSE")) {
        if (await this.probeHealth()) {
          this.adopted = true;
          this.consecutiveFailures = 0;
          this.logger.info(
            `taskboard: spawn hit EADDRINUSE but a healthy service answered on port ${this.port} — adopted it`,
          );
          return;
        }
        this.#clearRestartTimer();
        this.manualStop = true; // 阻止残余 exit 事件再排重启
        this.failedReason = `port ${this.port} occupied by a non-taskboard process`;
        throw new Error(
          `Port ${this.port} is occupied by a non-taskboard process (EADDRINUSE, /health probe failed). `
          + 'Change the plugin "port" config or stop that process.',
        );
      }
      // 启动期失败（超时/早退）：杀残余并计入连败（timer 里再 spawn 全新子进程）。
      if (this.child === child) await this.#killTree(child);
      if (!this.disposed && !this.manualStop) this.#scheduleRestart();
      throw error;
    }
  }

  async #waitReady(child: ChildProcess, exited: () => boolean): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited() || child.exitCode !== null) {
        const tail = this.stderrTail.trim().slice(-500);
        throw new Error(`taskboard: service exited before becoming healthy${tail ? `; stderr tail: ${tail}` : ""}`);
      }
      if (await this.probeHealth()) return;
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
    throw new Error(`taskboard: service did not become healthy within ${READY_TIMEOUT_MS / 1000}s at ${this.origin}`);
  }

  #scheduleRestart(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.logger.error(
        `taskboard: service failed ${this.consecutiveFailures} times in a row — giving up automatic restarts `
        + '(use the taskboard tool command "service_start" or reload the plugin to retry)',
      );
      return;
    }
    const delay = Math.min(this.restartBackoffMs * 2 ** (this.consecutiveFailures - 1), MAX_BACKOFF_MS);
    this.logger.info(`taskboard: restarting in ${delay}ms (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch((error: unknown) => {
        this.logger.error(`taskboard: restart attempt failed: ${(error as Error).message}`);
      });
    }, delay);
  }

  #clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  #pipeLogs(child: ChildProcess): void {
    const forward = (channel: NodeJS.ReadableStream | null, level: "info" | "warn") => {
      if (!channel) return;
      channel.setEncoding("utf8");
      channel.on("data", (chunk: string) => {
        if (level === "warn") this.stderrTail = (this.stderrTail + chunk).slice(-4096);
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim().length > 0) this.logger[level](`taskboard: ${line}`);
        }
      });
    };
    forward(child.stdout, "info");
    forward(child.stderr, "warn");
  }

  async #killTree(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (pid !== undefined) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
          killer.once("error", () => resolve());
          killer.once("close", () => resolve());
        });
      } else {
        try {
          process.kill(-pid, "SIGKILL"); // 进程组（spawn detached）
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    }
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, KILL_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** dataDir 默认：$DSH_HOME/taskboard/data（无 DSH_HOME 时 ~/.dsh/taskboard/data）。 */
function defaultDataDir(): string {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "taskboard", "data");
}

/** appRoot 默认：插件包（dist/）的 ../app — vendored 应用子集（server/shared/cli/skills/dist/web）。 */
function defaultAppRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
}

/**
 * 内置 taskboard skill（T7.6/R3）：教 agent 走本插件的 taskboard 工具面（而非
 * 仓库 CLI 版 skill 的 taskctl）。经 ctx.skills.register 运行时注册（runtime
 * provider，rank 250——压过 user/打包层同名 skill），插件停用即撤销；同名重复
 * 注册 warn + no-op（dsh-skill 实现层实证，安全）。语义对齐仓库
 * taskboard/skills/taskboard/SKILL.md 的工作流，但操作面换成工具子命令。
 */
const TASKBOARD_SKILL_CONTENT = `# Taskboard (dsh plugin tool face)

Use the **taskboard tool** for every project, issue, relation, and comment operation
on the local Taskboard. Read the JSON output it returns. Use the exact issue id or
identifier the tool returned; never assume, derive, or rewrite an identifier prefix.

Subcommands: reads \`project_list / project_get / project_map / issue_list /
issue_get / comment_list\`; writes \`issue_create / issue_update / issue_move /
comment_add / relation_add\`; lifecycle \`service_start / service_stop\`.

## Quick capture (添加到任务看板)

When the user says 「将/把 <内容> 添加到任务看板」「记到看板上」「加到任务板/看板」
(add/note/put … onto the task board) and asks for no execution workflow, treat it
as quick capture — the issue must land in the waiting-to-claim column, i.e.
\`status: "todo"\`:

1. Distill the content into a concise title, keeping the user's wording; do not
   expand scope or start work.
2. Avoid duplicates: \`issue_list\` the target project for an existing open issue
   with the same meaning; if found, append the new context to its description
   (\`issue_update\`) instead of creating another.
3. Create with the tool: \`issue_create { projectId, title, description,
   status: "todo" }\` (session attribution is automatic).
4. Reply with the returned identifier (e.g. LOCAL-4) and confirm it landed in
   等待认领. Claiming and execution still follow the rules below.

## Core workflow

1. For an existing issue, first run \`issue_get\` then \`comment_list\`. Read the
   description and latest comments before deciding whether to start. Treat comments
   as current requirements, including returned work. If they say to wait, not
   execute, or not start now, stop and report without changing the status.
2. Treat \`backlog\` as not approved for execution. Unless the user explicitly
   authorizes that issue, do not claim it, move it, or perform task work. If work
   may start, claim it before any other task work: move a claimable \`todo\` to
   \`in_progress\`. Never move an issue claimed by another session.
3. Optimistic locking: omit \`ifVersion\` to reuse the latest version, or pass the
   exact one. On a 409 \`VERSION_CONFLICT\`, re-read the issue (\`issue_get\` +
   \`comment_list\`) and retry once only if it is still claimable and unchanged.
   Otherwise stop and report. Never loop or take over another agent's claim.
4. For a new durable requirement, check existing issues (\`issue_list\`) before
   creating one (\`issue_create\`); update a matching issue instead of duplicating.
   Do not track trivial requests.
5. Writes are attributed to the current DSH session automatically; pass \`threadId\`
   explicitly only when addressing another session.
6. After the work, add a \`comment_add\` with changes, verification result, outcome,
   and remaining risks, then move the issue to \`in_review\`. Move to \`done\` only
   after the user explicitly accepts it; use \`blocked\` / \`canceled\` accordingly.

## Other operations

- Add only relations the work requires: \`parent\` for contained work, \`blocks\` /
  \`blocked_by\` for dependencies, \`related\` for close association.
- If the service is stopped, \`service_start\` starts it (\`autoStart: false\` setups);
  \`service_stop\` stops a plugin-owned instance.
- Do not use this skill for unrelated product docs or non-Taskboard tracking.
`;

/**
 * 插件入口（T5.2 服务监督 + T5.4 工具注册 + T5.6 配置）。
 * 入口 → apply → 子进程拉起 /health 就绪 → 工具面按 127.0.0.1:<port> 直连（ADR-12 路径 A）。
 */
export function apply(ctx: any, config: TaskboardConfig) {
  const logger: ServiceLogger = ctx.logger;
  const dataDir = config.dataDir.trim() || defaultDataDir();
  const appRoot = config.appRoot.trim() || defaultAppRoot();
  const service = new TaskboardService({
    port: config.port,
    serverEntry: path.join(appRoot, "server", "index.mjs"),
    dataDir,
    restartBackoffMs: config.restartBackoffMs,
    logger,
  });

  ctx.effect(() => {
    if (config.autoStart) {
      service.start().catch((error: unknown) => {
        logger.error(`taskboard: ${((error as Error)?.message ?? String(error))}`);
      });
    } else {
      logger.info("taskboard: autoStart disabled — service starts on first tool use or via the service_start command");
    }
    return () => {
      void service.dispose();
    };
  }, "taskboard: managed service");

  ctx.tools.register(createTaskboardTool(service));

  // T6.2/T6.3（M6）：给 client 半边的同源 port 通道。GUI 页面跨源读不到 host 配置，
  // 经 GUI 自身 webServer 暴露 exact 路由（exact 表先于 client-modules 的 /plugins
  // prefix 匹配，无冲突）；client fetch 此 JSON 拿实际端口，失败回退约定默认 47823
  // （ADR-12 C12）。懒注入：无 webServer 的 profile（如 headless）不注册、不影响加载。
  ctx.inject(["webServer"], (webCtx: any) => {
    return webCtx.webServer.register({
      kind: "exact",
      path: "/plugins/taskboard/config.json",
      handler: (req: any, res: any) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = JSON.stringify({ ok: true, port: config.port, status: service.status });
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
      },
    });
  });

  // 「在对话中打开」（新建会话）的绑定回写：client 半边（浏览器 3888 源）直连服务会跨源，
  // 由 host（Node，无 CORS）代理：POST {taskId, threadId} → GET 取 version → PATCH 落
  // bare threadId（与工具面 issue_create 同一绑定路径）。
  ctx.inject(["webServer"], (webCtx: any) => {
    return webCtx.webServer.register({
      kind: "exact",
      path: "/plugins/taskboard/bind-task",
      handler: async (req: any, res: any) => {
        const fail = (status: number, error: string) => {
          res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error }));
        };
        if (req.method !== "POST") {
          fail(405, "method not allowed");
          return;
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const { taskId, threadId } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            taskId?: string;
            threadId?: string;
          };
          if (typeof taskId !== "string" || !taskId.trim() || typeof threadId !== "string" || !threadId.trim()) {
            fail(400, "taskId and threadId are required");
            return;
          }
          const origin = `http://127.0.0.1:${config.port}`;
          const current = await fetch(`${origin}/api/tasks/${encodeURIComponent(taskId)}`);
          if (!current.ok) {
            fail(502, `GET task ${current.status}`);
            return;
          }
          const { task } = await current.json() as { task?: { version?: number; status?: string } };
          // bare threadId 的 PATCH 不计入服务端「任务字段」校验（app.mjs parseTaskPatch），
          // 走 /move + 当前 status：只写绑定不改状态（上游 moveTask 同一路径）。
          const patched = await fetch(`${origin}/api/tasks/${encodeURIComponent(taskId)}/move`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: task?.version, status: task?.status, threadId }),
          });
          const patchedBody = await patched.text();
          res.writeHead(patched.ok ? 200 : 502, { "content-type": "application/json; charset=utf-8" });
          res.end(patched.ok ? patchedBody : JSON.stringify({ ok: false, error: `PATCH task ${patched.status}` }));
        } catch (error) {
          fail(500, String((error as Error)?.message ?? error));
        }
      },
    });
  });

  // T7.6（M7）：运行时注册内置 taskboard skill（R3 收口）。懒注入：无 skills 服务的
  // profile 不注册、不影响插件加载；register 返回 disposer 随 fiber 撤销（停用即摘除）。
  ctx.inject(["skills"], (skillCtx: any) => {
    return skillCtx.skills.register({
      name: "taskboard",
      description:
        "Manage Taskboard issues via the dsh taskboard tool (project/issue/comment/relation subcommands plus service lifecycle). Use for issue ids, status sync, or comments on the local Taskboard — not for unrelated product docs. Also the quick-capture entry: when the user asks to add/note content onto the task board (将/把…添加到任务看板、记到看板上、加到任务板/看板), create a todo issue that lands in the 等待认领 column.",
      whenToUse:
        "Working with the local Taskboard board: claiming or moving issues, comments, relations, project mapping, or starting/stopping the managed service. Quick capture when the user says 将/把 <内容> 添加到任务看板 / 记到看板上 / 加到任务板.",
      source: { kind: "opaque", description: "dsh-taskboard-plugin runtime registration" },
      content: TASKBOARD_SKILL_CONTENT,
    });
  });
}
