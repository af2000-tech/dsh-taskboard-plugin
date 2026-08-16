// dsh-taskboard-plugin — 工具面（T5.4/T5.5）。
// 单工具 `taskboard` 子命令式设计：command 枚举 + 扁平参数（参数面按 docs/api-notes.md §4/§6）。
// 会话归属（T5.5）：写操作 threadId 注入顺序 = 显式参数 > exec.agent.id（DSH session id）> env DSH_SESSION_ID。
// 乐观锁（api-notes §2）：issue_update/issue_move/relation_add 缺 ifVersion 时先 GET 当前 version 再提交（读-改-写封装）。
import { defineTool } from "@deepseek-ai/dsh-tools";

/** 子命令全集。project/issue/comment/relation 按 API 路由面；service_* 服务生命周期（autoStart=false 时的手动通道）。 */
export const TASKBOARD_COMMANDS = [
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
  "service_stop",
] as const;

export type TaskboardCommand = (typeof TASKBOARD_COMMANDS)[number];

const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;

const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

const RELATION_TYPES = ["parent", "blocks", "blocked_by", "related"] as const;

const READ_COMMANDS = new Set<TaskboardCommand>([
  "project_list",
  "project_get",
  "issue_list",
  "issue_get",
  "comment_list",
]);

/** 工具面依赖的宿主服务句柄（由 host.ts 的 TaskboardService 实现）。 */
export interface TaskboardServiceLike {
  readonly port: number;
  /** 探测 /health（不启动服务）。 */
  probeHealth(): Promise<boolean>;
  /** 确保服务可用：按需懒启动；显式停止/放弃后报可操作错误。 */
  ensureReady(): Promise<void>;
  /** 启动（explicit=true 重置崩溃计数，用于手动/懒启动）。 */
  start(explicit?: boolean): Promise<void>;
  /** 停止自有子进程；收养实例只标记不杀。 */
  stop(): Promise<{ status: string; port: number }>;
}

/** 服务端错误响应（app.mjs）：{ error: { code, message } }。 */
interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

async function apiCall(
  origin: string,
  method: string,
  pathname: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${origin}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new Error(
      `taskboard service unreachable at ${origin} (${method} ${pathname}): ${(error as Error).message}`,
    );
  }
  const text = await response.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const parsed = json as ApiErrorBody | null;
    const code = parsed?.error?.code ?? "UNKNOWN";
    const message = parsed?.error?.message ?? (text ? text.slice(0, 200) : "(no body)");
    // 保留服务端语义（含 409 VERSION_CONFLICT 等冲突码）供 agent 重读重试。
    throw new Error(`taskboard ${code} (HTTP ${response.status}) on ${method} ${pathname}: ${message}`);
  }
  return json;
}

/** threadId 注入顺序：显式参数 > exec.agent.id > DSH_SESSION_ID（api-notes §2 三要素之一）。 */
function resolveSessionThreadId(args: { threadId?: string }, exec: { agent?: { id: unknown } }): string | undefined {
  if (typeof args.threadId === "string" && args.threadId.length > 0) return args.threadId;
  const agentSessionId = exec.agent?.id;
  if (typeof agentSessionId === "string" && agentSessionId.length > 0) return agentSessionId;
  const envSessionId = process.env.DSH_SESSION_ID;
  if (typeof envSessionId === "string" && envSessionId.trim().length > 0) return envSessionId.trim();
  return undefined;
}

function requireSessionThreadId(args: { threadId?: string }, exec: { agent?: { id: unknown } }): string {
  const threadId = resolveSessionThreadId(args, exec);
  if (threadId === undefined) {
    throw new Error(
      "taskboard write requires session attribution: pass \"threadId\", or run inside a DSH agent session, or set DSH_SESSION_ID",
    );
  }
  return threadId;
}

/** 缺 ifVersion 时读当前 version（CLI 同款读-改-写封装，api-notes §2 要素 2）。 */
async function resolveVersion(
  origin: string,
  issueId: string,
  explicitVersion: number | undefined,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (explicitVersion !== undefined) return explicitVersion;
  const result = await apiCall(origin, "GET", `/api/tasks/${encodeURIComponent(issueId)}`, undefined, signal);
  const version = result?.task?.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new Error(`taskboard service returned no valid version for issue '${issueId}'`);
  }
  return version;
}

function taskSummaryLine(task: any): string {
  if (!task || typeof task !== "object") return "(no task)";
  const identifier = typeof task.identifier === "string" ? task.identifier : String(task.id ?? "?");
  const status = typeof task.status === "string" ? task.status : "?";
  const version = typeof task.version === "number" ? task.version : "?";
  const title = typeof task.title === "string" ? ` "${task.title}"` : "";
  return `${identifier} [${status}] v${version}${title}`;
}

function summarize(command: TaskboardCommand, args: Record<string, any>, result: any): string {
  switch (command) {
    case "project_list":
      return `${result?.projects?.length ?? 0} project(s)`;
    case "project_get":
      return result?.project
        ? `${result.project.id} "${result.project.name}"`
        : "(no project)";
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

/** 注册到 ctx.tools 的 taskboard 工具定义（host.ts 消费）。 */
export function createTaskboardTool(service: TaskboardServiceLike) {
  return defineTool({
    name: "taskboard",
    description:
      "Manage the local Taskboard issue board: projects, issues, comments, and relations. "
      + `Subcommands via "command": ${TASKBOARD_COMMANDS.join(", ")}. `
      + "Writes are attributed to the current DSH session automatically (explicit \"threadId\" overrides). "
      + "Issue writes use optimistic locking: omit \"ifVersion\" to reuse the latest version, or set it to detect conflicts (HTTP 409). "
      + "Statuses: backlog (not approved for execution), todo, in_progress, in_review, blocked, done, canceled.",
    parameters: {
      command: {
        type: "string",
        enum: TASKBOARD_COMMANDS,
        required: true,
        description: "Subcommand to run.",
      },
      projectId: {
        type: "string",
        description: "Project id (project_get/project_map/issue_list/issue_create/issue_update).",
      },
      workspacePath: {
        type: "string",
        description: "project_map: absolute local path to map the project workspace to.",
      },
      issueId: {
        type: "string",
        description: "Issue uuid or identifier such as L0DRILL-1 (issue_* / comment_* / relation_add).",
      },
      relatedIssueId: {
        type: "string",
        description: "relation_add: the related issue uuid or identifier.",
      },
      relationType: {
        type: "string",
        enum: RELATION_TYPES,
        description: "relation_add: parent / blocks / blocked_by / related.",
      },
      title: {
        type: "string",
        description: "issue_create/issue_update: issue title.",
      },
      description: {
        type: "string",
        description: "issue_create/issue_update: markdown description.",
      },
      status: {
        type: "string",
        enum: TASK_STATUSES,
        description: "issue_list filter or issue_create/issue_update/issue_move target status.",
      },
      priority: {
        type: "string",
        enum: TASK_PRIORITIES,
        description: "issue_create/issue_update: none / urgent / high / medium / low.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "issue_create/issue_update: label list.",
      },
      archived: {
        type: "string",
        enum: ["true", "false", "all"],
        description: "issue_list: archived filter (default false).",
      },
      body: {
        type: "string",
        description: "comment_add: markdown comment body.",
      },
      threadId: {
        type: "string",
        description: "Explicit session attribution for writes; defaults to the current DSH session id.",
      },
      ifVersion: {
        type: "integer",
        description: "Optimistic-lock version for issue_update/issue_move/relation_add; omit to reuse the latest.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "Whether the command succeeded." },
          command: { type: "string", required: true, description: "Echo of the executed subcommand." },
          summary: { type: "string", required: true, description: "Short digest (identifier + status + version)." },
          result: { type: "json", required: true, description: "Canonical API response payload." },
        },
      },
      render: (_args: unknown, value: { summary: string; result: unknown }) => [
        {
          type: "text",
          text: `${value.summary}\n${JSON.stringify(value.result, null, 2)}`,
        },
      ],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: (args: { command: TaskboardCommand }) => READ_COMMANDS.has(args.command),
    async execute(args: Record<string, any>, exec: any): Promise<{ ok: boolean; command: string; summary: string; result: any }> {
      const command = args.command as TaskboardCommand;
      const origin = `http://127.0.0.1:${service.port}`;

      if (command === "service_start") {
        await service.start(true);
        const status = (await service.probeHealth()) ? "ready" : "starting";
        return { ok: true, command, summary: `service ${status} on port ${service.port}`, result: { status, port: service.port, origin } };
      }
      if (command === "service_stop") {
        const outcome = await service.stop();
        return { ok: true, command, summary: `service ${outcome.status} (port ${outcome.port})`, result: outcome };
      }

      await service.ensureReady();

      let result: any;
      switch (command) {
        case "project_list":
          result = await apiCall(origin, "GET", "/api/projects", undefined, exec.signal);
          break;
        case "project_get": {
          if (!args.projectId) throw new Error('project_get requires "projectId"');
          const list = await apiCall(origin, "GET", "/api/projects", undefined, exec.signal);
          const project = (list?.projects ?? []).find((p: any) => p?.id === args.projectId);
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
            exec.signal,
          );
          break;
        }
        case "issue_list": {
          const search = new URLSearchParams();
          if (args.projectId !== undefined) search.set("projectId", String(args.projectId));
          if (args.status !== undefined) search.set("status", String(args.status));
          if (args.archived !== undefined) search.set("archived", String(args.archived));
          const query = search.size > 0 ? `?${search}` : "";
          result = await apiCall(origin, "GET", `/api/tasks${query}`, undefined, exec.signal);
          break;
        }
        case "issue_get": {
          if (!args.issueId) throw new Error('issue_get requires "issueId"');
          result = await apiCall(origin, "GET", `/api/tasks/${encodeURIComponent(args.issueId)}`, undefined, exec.signal);
          break;
        }
        case "issue_create": {
          if (!args.projectId) throw new Error('issue_create requires "projectId"');
          if (!args.title) throw new Error('issue_create requires "title"');
          const body: Record<string, unknown> = {
            projectId: args.projectId,
            title: args.title,
            threadId: requireSessionThreadId(args, exec),
          };
          if (args.description !== undefined) body.description = args.description;
          if (args.status !== undefined) body.status = args.status;
          if (args.priority !== undefined) body.priority = args.priority;
          if (args.labels !== undefined) body.labels = args.labels;
          result = await apiCall(origin, "POST", "/api/tasks", body, exec.signal);
          break;
        }
        case "issue_update": {
          if (!args.issueId) throw new Error('issue_update requires "issueId"');
          const body: Record<string, unknown> = {
            version: await resolveVersion(origin, args.issueId, args.ifVersion, exec.signal),
            threadId: requireSessionThreadId(args, exec),
          };
          for (const field of ["projectId", "title", "description", "status", "priority", "labels"] as const) {
            if (args[field] !== undefined) body[field] = args[field];
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
              threadId: requireSessionThreadId(args, exec),
            },
            exec.signal,
          );
          break;
        }
        case "comment_list": {
          if (!args.issueId) throw new Error('comment_list requires "issueId"');
          result = await apiCall(origin, "GET", `/api/tasks/${encodeURIComponent(args.issueId)}/comments`, undefined, exec.signal);
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
            exec.signal,
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
            exec.signal,
          );
          break;
        }
        default:
          throw new Error(`taskboard: unknown command '${String(command)}'`);
      }

      return { ok: true, command, summary: summarize(command, args, result), result };
    },
  });
}
