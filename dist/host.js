// src/host.ts
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

// src/tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var TASKBOARD_COMMANDS = [
  "project_list",
  "project_get",
  "project_map",
  "issue_list",
  "issue_get",
  "issue_create",
  "issue_update",
  "issue_move",
  "comment_list",
  "comment_add",
  "relation_add",
  "service_start",
  "service_stop"
];
var TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled"
];
var TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"];
var RELATION_TYPES = ["parent", "blocks", "blocked_by", "related"];
var READ_COMMANDS = /* @__PURE__ */ new Set([
  "project_list",
  "project_get",
  "issue_list",
  "issue_get",
  "comment_list"
]);
async function apiCall(origin, method, pathname, body, signal) {
  let response;
  try {
    response = await fetch(`${origin}${pathname}`, {
      method,
      headers: body === void 0 ? void 0 : { "content-type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal
    });
  } catch (error) {
    throw new Error(
      `taskboard service unreachable at ${origin} (${method} ${pathname}): ${error.message}`
    );
  }
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const parsed = json;
    const code = parsed?.error?.code ?? "UNKNOWN";
    const message = parsed?.error?.message ?? (text ? text.slice(0, 200) : "(no body)");
    throw new Error(`taskboard ${code} (HTTP ${response.status}) on ${method} ${pathname}: ${message}`);
  }
  return json;
}
function resolveSessionThreadId(args, exec) {
  if (typeof args.threadId === "string" && args.threadId.length > 0) return args.threadId;
  const agentSessionId = exec.agent?.id;
  if (typeof agentSessionId === "string" && agentSessionId.length > 0) return agentSessionId;
  const envSessionId = process.env.DSH_SESSION_ID;
  if (typeof envSessionId === "string" && envSessionId.trim().length > 0) return envSessionId.trim();
  return void 0;
}
function requireSessionThreadId(args, exec) {
  const threadId = resolveSessionThreadId(args, exec);
  if (threadId === void 0) {
    throw new Error(
      'taskboard write requires session attribution: pass "threadId", or run inside a DSH agent session, or set DSH_SESSION_ID'
    );
  }
  return threadId;
}
async function resolveVersion(origin, issueId, explicitVersion, signal) {
  if (explicitVersion !== void 0) return explicitVersion;
  const result = await apiCall(origin, "GET", `/api/tasks/${encodeURIComponent(issueId)}`, void 0, signal);
  const version = result?.task?.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new Error(`taskboard service returned no valid version for issue '${issueId}'`);
  }
  return version;
}
function taskSummaryLine(task) {
  if (!task || typeof task !== "object") return "(no task)";
  const identifier = typeof task.identifier === "string" ? task.identifier : String(task.id ?? "?");
  const status = typeof task.status === "string" ? task.status : "?";
  const version = typeof task.version === "number" ? task.version : "?";
  const title = typeof task.title === "string" ? ` "${task.title}"` : "";
  return `${identifier} [${status}] v${version}${title}`;
}
function summarize(command, args, result) {
  switch (command) {
    case "project_list":
      return `${result?.projects?.length ?? 0} project(s)`;
    case "project_get":
      return result?.project ? `${result.project.id} "${result.project.name}"` : "(no project)";
    case "project_map":
      return `${result?.projectId ?? args.projectId} -> ${result?.workspacePath ?? args.workspacePath}`;
    case "issue_list":
      return `${result?.tasks?.length ?? 0} issue(s)`;
    case "issue_get":
    case "issue_create":
    case "issue_update":
    case "issue_move":
      return taskSummaryLine(result?.task);
    case "comment_list":
      return `${result?.comments?.length ?? 0} comment(s)`;
    case "comment_add":
      return `comment added (${String(result?.comment?.id ?? "?").slice(0, 8)})`;
    case "relation_add":
      return `${taskSummaryLine(result?.task)} --${args.relationType}--> ${taskSummaryLine(result?.relatedTask)}`;
    case "service_start":
      return `taskboard service ${result?.status ?? "started"} on port ${result?.port ?? "?"}`;
    case "service_stop":
      return `taskboard service ${result?.status ?? "stopped"} (port ${result?.port ?? "?"})`;
    default:
      return command;
  }
}
function createTaskboardTool(service) {
  return defineTool({
    name: "taskboard",
    description: `Manage the local Taskboard issue board: projects, issues, comments, and relations. Subcommands via "command": ${TASKBOARD_COMMANDS.join(", ")}. Writes are attributed to the current DSH session automatically (explicit "threadId" overrides). Issue writes use optimistic locking: omit "ifVersion" to reuse the latest version, or set it to detect conflicts (HTTP 409). Statuses: backlog (not approved for execution), todo, in_progress, in_review, blocked, done, canceled.`,
    parameters: {
      command: {
        type: "string",
        enum: TASKBOARD_COMMANDS,
        required: true,
        description: "Subcommand to run."
      },
      projectId: {
        type: "string",
        description: "Project id (project_get/project_map/issue_list/issue_create/issue_update)."
      },
      workspacePath: {
        type: "string",
        description: "project_map: absolute local path to map the project workspace to."
      },
      issueId: {
        type: "string",
        description: "Issue uuid or identifier such as L0DRILL-1 (issue_* / comment_* / relation_add)."
      },
      relatedIssueId: {
        type: "string",
        description: "relation_add: the related issue uuid or identifier."
      },
      relationType: {
        type: "string",
        enum: RELATION_TYPES,
        description: "relation_add: parent / blocks / blocked_by / related."
      },
      title: {
        type: "string",
        description: "issue_create/issue_update: issue title."
      },
      description: {
        type: "string",
        description: "issue_create/issue_update: markdown description."
      },
      status: {
        type: "string",
        enum: TASK_STATUSES,
        description: "issue_list filter or issue_create/issue_update/issue_move target status."
      },
      priority: {
        type: "string",
        enum: TASK_PRIORITIES,
        description: "issue_create/issue_update: none / urgent / high / medium / low."
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "issue_create/issue_update: label list."
      },
      archived: {
        type: "string",
        enum: ["true", "false", "all"],
        description: "issue_list: archived filter (default false)."
      },
      body: {
        type: "string",
        description: "comment_add: markdown comment body."
      },
      threadId: {
        type: "string",
        description: "Explicit session attribution for writes; defaults to the current DSH session id."
      },
      ifVersion: {
        type: "integer",
        description: "Optimistic-lock version for issue_update/issue_move/relation_add; omit to reuse the latest."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "Whether the command succeeded." },
          command: { type: "string", required: true, description: "Echo of the executed subcommand." },
          summary: { type: "string", required: true, description: "Short digest (identifier + status + version)." },
          result: { type: "json", required: true, description: "Canonical API response payload." }
        }
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `${value.summary}
${JSON.stringify(value.result, null, 2)}`
        }
      ]
    },
    timeoutMs: 3e4,
    isConcurrencySafe: (args) => READ_COMMANDS.has(args.command),
    async execute(args, exec) {
      const command = args.command;
      const origin = `http://127.0.0.1:${service.port}`;
      if (command === "service_start") {
        await service.start(true);
        const status = await service.probeHealth() ? "ready" : "starting";
        return { ok: true, command, summary: `service ${status} on port ${service.port}`, result: { status, port: service.port, origin } };
      }
      if (command === "service_stop") {
        const outcome = await service.stop();
        return { ok: true, command, summary: `service ${outcome.status} (port ${outcome.port})`, result: outcome };
      }
      await service.ensureReady();
      let result;
      switch (command) {
        case "project_list":
          result = await apiCall(origin, "GET", "/api/projects", void 0, exec.signal);
          break;
        case "project_get": {
          if (!args.projectId) throw new Error('project_get requires "projectId"');
          const list = await apiCall(origin, "GET", "/api/projects", void 0, exec.signal);
          const project = (list?.projects ?? []).find((p) => p?.id === args.projectId);
          if (!project) throw new Error(`taskboard project '${args.projectId}' not found`);
          result = { project };
          break;
        }
        case "project_map": {
          if (!args.projectId) throw new Error('project_map requires "projectId"');
          if (!args.workspacePath) throw new Error('project_map requires "workspacePath" (absolute path)');
          result = await apiCall(
            origin,
            "PUT",
            `/api/local/project-mappings/${encodeURIComponent(args.projectId)}`,
            { workspacePath: args.workspacePath },
            exec.signal
          );
          break;
        }
        case "issue_list": {
          const search = new URLSearchParams();
          if (args.projectId !== void 0) search.set("projectId", String(args.projectId));
          if (args.status !== void 0) search.set("status", String(args.status));
          if (args.archived !== void 0) search.set("archived", String(args.archived));
          const query = search.size > 0 ? `?${search}` : "";
          result = await apiCall(origin, "GET", `/api/tasks${query}`, void 0, exec.signal);
          break;
        }
        case "issue_get": {
          if (!args.issueId) throw new Error('issue_get requires "issueId"');
          result = await apiCall(origin, "GET", `/api/tasks/${encodeURIComponent(args.issueId)}`, void 0, exec.signal);
          break;
        }
        case "issue_create": {
          if (!args.projectId) throw new Error('issue_create requires "projectId"');
          if (!args.title) throw new Error('issue_create requires "title"');
          const body = {
            projectId: args.projectId,
            title: args.title,
            threadId: requireSessionThreadId(args, exec)
          };
          if (args.description !== void 0) body.description = args.description;
          if (args.status !== void 0) body.status = args.status;
          if (args.priority !== void 0) body.priority = args.priority;
          if (args.labels !== void 0) body.labels = args.labels;
          result = await apiCall(origin, "POST", "/api/tasks", body, exec.signal);
          break;
        }
        case "issue_update": {
          if (!args.issueId) throw new Error('issue_update requires "issueId"');
          const body = {
            version: await resolveVersion(origin, args.issueId, args.ifVersion, exec.signal),
            threadId: requireSessionThreadId(args, exec)
          };
          for (const field of ["projectId", "title", "description", "status", "priority", "labels"]) {
            if (args[field] !== void 0) body[field] = args[field];
          }
          result = await apiCall(origin, "PATCH", `/api/tasks/${encodeURIComponent(args.issueId)}`, body, exec.signal);
          break;
        }
        case "issue_move": {
          if (!args.issueId) throw new Error('issue_move requires "issueId"');
          if (!args.status) throw new Error('issue_move requires "status"');
          result = await apiCall(
            origin,
            "POST",
            `/api/tasks/${encodeURIComponent(args.issueId)}/move`,
            {
              status: args.status,
              version: await resolveVersion(origin, args.issueId, args.ifVersion, exec.signal),
              threadId: requireSessionThreadId(args, exec)
            },
            exec.signal
          );
          break;
        }
        case "comment_list": {
          if (!args.issueId) throw new Error('comment_list requires "issueId"');
          result = await apiCall(origin, "GET", `/api/tasks/${encodeURIComponent(args.issueId)}/comments`, void 0, exec.signal);
          break;
        }
        case "comment_add": {
          if (!args.issueId) throw new Error('comment_add requires "issueId"');
          if (!args.body) throw new Error('comment_add requires "body"');
          result = await apiCall(
            origin,
            "POST",
            `/api/tasks/${encodeURIComponent(args.issueId)}/comments`,
            { body: args.body, threadId: requireSessionThreadId(args, exec) },
            exec.signal
          );
          break;
        }
        case "relation_add": {
          if (!args.issueId) throw new Error('relation_add requires "issueId"');
          if (!args.relatedIssueId) throw new Error('relation_add requires "relatedIssueId"');
          if (!args.relationType) throw new Error('relation_add requires "relationType"');
          const version = await resolveVersion(origin, args.issueId, args.ifVersion, exec.signal);
          result = await apiCall(
            origin,
            "POST",
            `/api/tasks/${encodeURIComponent(args.issueId)}/relations/${encodeURIComponent(args.relationType)}/${encodeURIComponent(args.relatedIssueId)}`,
            { version, threadId: requireSessionThreadId(args, exec) },
            exec.signal
          );
          break;
        }
        default:
          throw new Error(`taskboard: unknown command '${String(command)}'`);
      }
      return { ok: true, command, summary: summarize(command, args, result), result };
    }
  });
}

// src/host.ts
var name = "taskboard";
var inject = ["tools"];
var Config = z.object({
  /** Taskboard 服务 HTTP 端口（服务强制绑定 127.0.0.1）。 */
  port: z.number().default(47823).description("Taskboard service port (loopback only)"),
  /** SQLite 数据目录；空 = $DSH_HOME/taskboard/data（无 DSH_HOME 时 ~/.dsh/taskboard/data）。 */
  dataDir: z.string().default("").description("SQLite data directory; empty = $DSH_HOME/taskboard/data"),
  /** 启用插件时自动拉起服务进程；false 时首个工具调用或 service_start 再拉起。 */
  autoStart: z.boolean().default(true).description("Start the managed service automatically"),
  /** 子进程崩溃后的重启退避基数（毫秒，指数退避封顶 30s，连败 5 次放弃）。 */
  restartBackoffMs: z.number().default(3e3).description("Crash restart backoff base in ms"),
  /** taskboard 应用根目录（server/index.mjs 所在仓库）；空 = 包内 vendored 应用（dist/ 的 ../app）。 */
  appRoot: z.string().default("").description("Taskboard app root; empty = vendored app inside the package")
});
var READY_TIMEOUT_MS = 3e4;
var HEALTH_POLL_INTERVAL_MS = 250;
var HEALTH_PROBE_TIMEOUT_MS = 1500;
var KILL_TIMEOUT_MS = 5e3;
var MAX_CONSECUTIVE_FAILURES = 5;
var MAX_BACKOFF_MS = 3e4;
var CHILD_ENV_ALLOWLIST = [
  "PATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "DSH_HOME",
  "DSH_SESSION_ID"
];
function buildChildEnv(port, dataDir) {
  const env = {
    NODE_ENV: "production",
    TASKBOARD_PORT: String(port),
    TASKBOARD_HOST: "127.0.0.1",
    TASKBOARD_DATA_DIR: dataDir
  };
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== void 0) env[key] = value;
  }
  return env;
}
var TaskboardService = class {
  port;
  serverEntry;
  dataDir;
  restartBackoffMs;
  logger;
  child = null;
  adopted = false;
  disposed = false;
  manualStop = false;
  ready = false;
  consecutiveFailures = 0;
  restartTimer = null;
  starting = null;
  stderrTail = "";
  /** EADDRINUSE 让位等终态失败的原因（config.json 状态通道透传给 client 半边诊断）。 */
  failedReason = null;
  constructor(options) {
    this.port = options.port;
    this.serverEntry = options.serverEntry;
    this.dataDir = options.dataDir;
    this.restartBackoffMs = Math.max(0, options.restartBackoffMs);
    this.logger = options.logger;
  }
  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }
  /**
   * 监督器状态快照（M6 config.json 状态通道）：ready/adopted=可服务，
   * starting/restarting=过渡，stopped=手动停，failed=终态失败，disposed=已清理。
   * client 半边据此判定降级视图——盲探 /health 会被端口上的任意 HTTP 占用者骗过。
   */
  get status() {
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
  async probeHealth() {
    try {
      const response = await fetch(`${this.origin}/health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.status === "ok";
    } catch {
      return false;
    }
  }
  async start(explicit = false) {
    if (this.disposed) throw new Error("taskboard service supervisor is disposed");
    if (explicit) {
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
  async ensureReady() {
    if (this.disposed) throw new Error("taskboard service supervisor is disposed");
    if (this.manualStop) {
      throw new Error('taskboard service is stopped; call the taskboard tool with command "service_start" to start it');
    }
    if (!(this.adopted || this.child)) {
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error('taskboard service gave up after repeated crashes; call the taskboard tool with command "service_start" to retry');
      }
      await this.start(true);
      return;
    }
    await this.start();
    if (!await this.probeHealth()) {
      throw new Error(`taskboard service at ${this.origin} is not healthy (probe failed)`);
    }
  }
  async stop() {
    this.manualStop = true;
    this.#clearRestartTimer();
    if (this.adopted) {
      this.logger.info(`taskboard: instance on port ${this.port} was adopted, not ours to stop \u2014 leaving it running`);
      return { status: "adopted-left-running", port: this.port };
    }
    if (this.child) {
      await this.#killTree(this.child);
      return { status: "stopped", port: this.port };
    }
    return { status: "already-stopped", port: this.port };
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.#clearRestartTimer();
    if (this.adopted) {
      this.logger.info(`taskboard: adopted instance on port ${this.port} left running on dispose`);
      return;
    }
    if (this.child) await this.#killTree(this.child);
  }
  async #doStart() {
    try {
      await access(this.serverEntry);
    } catch {
      throw new Error(
        `Taskboard server entry not found: ${this.serverEntry}. The plugin package is missing its bundled app/ \u2014 reinstall it. (Or set the plugin "appRoot" config to an external taskboard app root.)`
      );
    }
    if (await this.probeHealth()) {
      this.adopted = true;
      this.consecutiveFailures = 0;
      this.failedReason = null;
      this.logger.info(
        `taskboard: adopted an existing healthy service on port ${this.port} (no subprocess spawned; it is left running on dispose)`
      );
      return;
    }
    const child = spawn(process.execPath, [this.serverEntry], {
      env: buildChildEnv(this.port, this.dataDir),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
      // POSIX 进程组便于树杀；Windows 走 taskkill /T
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
        this.logger.warn(`taskboard: service exited unexpectedly (code=${code} signal=${signal}); scheduling restart`);
        this.#scheduleRestart();
      }
    });
    try {
      await this.#waitReady(child, () => exitedEarly);
      this.ready = true;
      this.consecutiveFailures = 0;
      this.failedReason = null;
      this.logger.info(`taskboard: service ready at ${this.origin} (data: ${this.dataDir})`);
    } catch (error) {
      if (this.stderrTail.includes("EADDRINUSE")) {
        if (await this.probeHealth()) {
          this.adopted = true;
          this.consecutiveFailures = 0;
          this.logger.info(
            `taskboard: spawn hit EADDRINUSE but a healthy service answered on port ${this.port} \u2014 adopted it`
          );
          return;
        }
        this.#clearRestartTimer();
        this.manualStop = true;
        this.failedReason = `port ${this.port} occupied by a non-taskboard process`;
        throw new Error(
          `Port ${this.port} is occupied by a non-taskboard process (EADDRINUSE, /health probe failed). Change the plugin "port" config or stop that process.`
        );
      }
      if (this.child === child) await this.#killTree(child);
      if (!this.disposed && !this.manualStop) this.#scheduleRestart();
      throw error;
    }
  }
  async #waitReady(child, exited) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited() || child.exitCode !== null) {
        const tail = this.stderrTail.trim().slice(-500);
        throw new Error(`taskboard: service exited before becoming healthy${tail ? `; stderr tail: ${tail}` : ""}`);
      }
      if (await this.probeHealth()) return;
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
    throw new Error(`taskboard: service did not become healthy within ${READY_TIMEOUT_MS / 1e3}s at ${this.origin}`);
  }
  #scheduleRestart() {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.logger.error(
        `taskboard: service failed ${this.consecutiveFailures} times in a row \u2014 giving up automatic restarts (use the taskboard tool command "service_start" or reload the plugin to retry)`
      );
      return;
    }
    const delay = Math.min(this.restartBackoffMs * 2 ** (this.consecutiveFailures - 1), MAX_BACKOFF_MS);
    this.logger.info(`taskboard: restarting in ${delay}ms (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch((error) => {
        this.logger.error(`taskboard: restart attempt failed: ${error.message}`);
      });
    }, delay);
  }
  #clearRestartTimer() {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
  #pipeLogs(child) {
    const forward = (channel, level) => {
      if (!channel) return;
      channel.setEncoding("utf8");
      channel.on("data", (chunk) => {
        if (level === "warn") this.stderrTail = (this.stderrTail + chunk).slice(-4096);
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim().length > 0) this.logger[level](`taskboard: ${line}`);
        }
      });
    };
    forward(child.stdout, "info");
    forward(child.stderr, "warn");
  }
  async #killTree(child) {
    const pid = child.pid;
    if (pid !== void 0) {
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
          killer.once("error", () => resolve());
          killer.once("close", () => resolve());
        });
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
          }
        }
      }
    }
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
        resolve();
      }, KILL_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
};
function defaultDataDir() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "taskboard", "data");
}
function defaultAppRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
}
var TASKBOARD_SKILL_CONTENT = `# Taskboard (dsh plugin tool face)

Use the **taskboard tool** for every project, issue, relation, and comment operation
on the local Taskboard. Read the JSON output it returns. Use the exact issue id or
identifier the tool returned; never assume, derive, or rewrite an identifier prefix.

Subcommands: reads \`project_list / project_get / project_map / issue_list /
issue_get / comment_list\`; writes \`issue_create / issue_update / issue_move /
comment_add / relation_add\`; lifecycle \`service_start / service_stop\`.

## Quick capture (\u6DFB\u52A0\u5230\u4EFB\u52A1\u770B\u677F)

When the user says \u300C\u5C06/\u628A <\u5185\u5BB9> \u6DFB\u52A0\u5230\u4EFB\u52A1\u770B\u677F\u300D\u300C\u8BB0\u5230\u770B\u677F\u4E0A\u300D\u300C\u52A0\u5230\u4EFB\u52A1\u677F/\u770B\u677F\u300D
(add/note/put \u2026 onto the task board) and asks for no execution workflow, treat it
as quick capture \u2014 the issue must land in the waiting-to-claim column, i.e.
\`status: "todo"\`:

1. Distill the content into a concise title, keeping the user's wording; do not
   expand scope or start work.
2. Avoid duplicates: \`issue_list\` the target project for an existing open issue
   with the same meaning; if found, append the new context to its description
   (\`issue_update\`) instead of creating another.
3. Create with the tool: \`issue_create { projectId, title, description,
   status: "todo" }\` (session attribution is automatic).
4. Reply with the returned identifier (e.g. LOCAL-4) and confirm it landed in
   \u7B49\u5F85\u8BA4\u9886. Claiming and execution still follow the rules below.

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
function apply(ctx, config) {
  const logger = ctx.logger;
  const dataDir = config.dataDir.trim() || defaultDataDir();
  const appRoot = config.appRoot.trim() || defaultAppRoot();
  const service = new TaskboardService({
    port: config.port,
    serverEntry: path.join(appRoot, "server", "index.mjs"),
    dataDir,
    restartBackoffMs: config.restartBackoffMs,
    logger
  });
  ctx.effect(() => {
    if (config.autoStart) {
      service.start().catch((error) => {
        logger.error(`taskboard: ${error?.message ?? String(error)}`);
      });
    } else {
      logger.info("taskboard: autoStart disabled \u2014 service starts on first tool use or via the service_start command");
    }
    return () => {
      void service.dispose();
    };
  }, "taskboard: managed service");
  ctx.tools.register(createTaskboardTool(service));
  ctx.inject(["webServer"], (webCtx) => {
    return webCtx.webServer.register({
      kind: "exact",
      path: "/plugins/taskboard/config.json",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = JSON.stringify({ ok: true, port: config.port, status: service.status });
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(req.method === "HEAD" ? void 0 : body);
      }
    });
  });
  ctx.inject(["webServer"], (webCtx) => {
    return webCtx.webServer.register({
      kind: "exact",
      path: "/plugins/taskboard/bind-task",
      handler: async (req, res) => {
        const fail = (status, error) => {
          res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error }));
        };
        if (req.method !== "POST") {
          fail(405, "method not allowed");
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const { taskId, threadId } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
          const { task } = await current.json();
          const patched = await fetch(`${origin}/api/tasks/${encodeURIComponent(taskId)}/move`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: task?.version, status: task?.status, threadId })
          });
          const patchedBody = await patched.text();
          res.writeHead(patched.ok ? 200 : 502, { "content-type": "application/json; charset=utf-8" });
          res.end(patched.ok ? patchedBody : JSON.stringify({ ok: false, error: `PATCH task ${patched.status}` }));
        } catch (error) {
          fail(500, String(error?.message ?? error));
        }
      }
    });
  });
  ctx.inject(["skills"], (skillCtx) => {
    return skillCtx.skills.register({
      name: "taskboard",
      description: "Manage Taskboard issues via the dsh taskboard tool (project/issue/comment/relation subcommands plus service lifecycle). Use for issue ids, status sync, or comments on the local Taskboard \u2014 not for unrelated product docs. Also the quick-capture entry: when the user asks to add/note content onto the task board (\u5C06/\u628A\u2026\u6DFB\u52A0\u5230\u4EFB\u52A1\u770B\u677F\u3001\u8BB0\u5230\u770B\u677F\u4E0A\u3001\u52A0\u5230\u4EFB\u52A1\u677F/\u770B\u677F), create a todo issue that lands in the \u7B49\u5F85\u8BA4\u9886 column.",
      whenToUse: "Working with the local Taskboard board: claiming or moving issues, comments, relations, project mapping, or starting/stopping the managed service. Quick capture when the user says \u5C06/\u628A <\u5185\u5BB9> \u6DFB\u52A0\u5230\u4EFB\u52A1\u770B\u677F / \u8BB0\u5230\u770B\u677F\u4E0A / \u52A0\u5230\u4EFB\u52A1\u677F.",
      source: { kind: "opaque", description: "dsh-taskboard-plugin runtime registration" },
      content: TASKBOARD_SKILL_CONTENT
    });
  });
}
export {
  Config,
  TaskboardService,
  apply,
  inject,
  name
};
//# sourceMappingURL=host.js.map
