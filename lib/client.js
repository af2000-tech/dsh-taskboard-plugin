window.__ModuleLoader__.load({
	id: "dsh-taskboard-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name in all)
		    __defProp(target, name, { get: all[name], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
		
		// src/client/index.ts
		var index_exports = {};
		__export(index_exports, {
		  apply: () => apply,
		  inject: () => inject
		});
		module.exports = __toCommonJS(index_exports);
		var import_react = require("react");
		var inject = ["slots", "sessions", "layout"];
		var DEFAULT_PORT = 47823;
		var PORT_CHANNEL_URL = "/plugins/taskboard/config.json";
		function hostStatusServes(status) {
		  return status === "ready" || status === "adopted";
		}
		async function resolveChannel(signal) {
		  try {
		    const response = await fetch(PORT_CHANNEL_URL, { signal });
		    if (!response.ok) return { port: DEFAULT_PORT, status: void 0 };
		    const data = await response.json();
		    const channel = data;
		    const port = channel?.port;
		    if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) {
		      return { port, status: channel?.status };
		    }
		    return { port: DEFAULT_PORT, status: channel?.status };
		  } catch {
		    return { port: DEFAULT_PORT, status: void 0 };
		  }
		}
		async function probeHealth(origin, signal) {
		  const controller = new AbortController();
		  const timer = setTimeout(() => controller.abort(), 3e3);
		  const onOuterAbort = () => controller.abort();
		  signal.addEventListener("abort", onOuterAbort, { once: true });
		  try {
		    await fetch(`${origin}/health`, { mode: "no-cors", signal: controller.signal });
		    return true;
		  } catch {
		    return false;
		  } finally {
		    clearTimeout(timer);
		    signal.removeEventListener("abort", onOuterAbort);
		  }
		}
		var tokens = {
		  bgBase: "var(--dsw-alias-bg-base, #fff)",
		  borderL2: "var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
		  labelPrimary: "var(--dsw-alias-label-primary, inherit)",
		  labelSecondary: "var(--dsw-alias-label-secondary, inherit)"
		};
		function useTaskboardChannel() {
		  const [phase, setPhase] = (0, import_react.useState)("resolving");
		  const [origin, setOrigin] = (0, import_react.useState)(`http://127.0.0.1:${DEFAULT_PORT}`);
		  const [hostStatus, setHostStatus] = (0, import_react.useState)(void 0);
		  (0, import_react.useEffect)(() => {
		    const controller = new AbortController();
		    let cancelled = false;
		    setPhase("resolving");
		    setHostStatus(void 0);
		    const attempt = async () => {
		      const channel = await resolveChannel(controller.signal);
		      const resolvedOrigin = `http://127.0.0.1:${channel.port}`;
		      if (cancelled) return;
		      setOrigin(resolvedOrigin);
		      setHostStatus(channel.status);
		      const healthy = hostStatusServes(channel.status) && await probeHealth(resolvedOrigin, controller.signal);
		      if (cancelled) return;
		      setPhase(healthy ? "loading" : "down");
		    };
		    attempt().catch(() => {
		      if (!cancelled) setPhase("down");
		    });
		    return () => {
		      cancelled = true;
		      controller.abort();
		    };
		  }, []);
		  const retry = () => {
		    setPhase("resolving");
		    void (async () => {
		      const controller = new AbortController();
		      const channel = await resolveChannel(controller.signal);
		      const resolvedOrigin = `http://127.0.0.1:${channel.port}`;
		      setOrigin(resolvedOrigin);
		      setHostStatus(channel.status);
		      const healthy = hostStatusServes(channel.status) && await probeHealth(resolvedOrigin, controller.signal);
		      setPhase(healthy ? "loading" : "down");
		    })().catch(() => setPhase("down"));
		  };
		  return { phase, origin, hostStatus, retry, markReady: () => setPhase("ready") };
		}
		function BoardFrame(props) {
		  const { phase, origin, hostStatus, retry, markReady, frameTitle } = props;
		  if (phase === "ready" || phase === "loading") {
		    return (0, import_react.createElement)(
		      "div",
		      { style: { position: "relative", flex: 1, minHeight: 0 } },
		      (0, import_react.createElement)("iframe", {
		        src: `${origin}/`,
		        title: frameTitle,
		        // 跨源 iframe 的剪贴板写授权：无此声明时 Chrome 拒绝 navigator.clipboard.writeText
		        // （execCommand 兜底也会被静默吞掉），看板内「复制 ID/复制链接」会报「无法写入剪贴板」。
		        allow: "clipboard-write",
		        onLoad: markReady,
		        style: {
		          width: "100%",
		          height: "100%",
		          border: "none",
		          background: "#fff",
		          display: "block"
		        }
		      }),
		      phase === "loading" ? (0, import_react.createElement)(
		        "div",
		        {
		          style: {
		            position: "absolute",
		            inset: 0,
		            display: "grid",
		            placeItems: "center",
		            fontSize: 13,
		            color: tokens.labelSecondary,
		            background: tokens.bgBase
		          }
		        },
		        "Taskboard \u52A0\u8F7D\u4E2D\u2026"
		      ) : null
		    );
		  }
		  return (0, import_react.createElement)(
		    "div",
		    {
		      style: {
		        flex: 1,
		        display: "flex",
		        flexDirection: "column",
		        alignItems: "center",
		        justifyContent: "center",
		        gap: 12,
		        fontSize: 13,
		        color: tokens.labelSecondary
		      },
		      "data-taskboard-degraded": true
		    },
		    (0, import_react.createElement)(
		      "div",
		      null,
		      phase === "resolving" ? "\u6B63\u5728\u8FDE\u63A5 Taskboard \u670D\u52A1\u2026" : `Taskboard \u670D\u52A1\u672A\u542F\u52A8${typeof hostStatus === "string" ? `\uFF08host \u72B6\u6001: ${hostStatus}\uFF09` : ""}`
		    ),
		    (0, import_react.createElement)(
		      "div",
		      { style: { display: "flex", gap: 8 } },
		      (0, import_react.createElement)(
		        "button",
		        {
		          onClick: retry,
		          style: {
		            cursor: "pointer",
		            padding: "6px 14px",
		            fontSize: 13,
		            borderRadius: 8,
		            border: `1px solid ${tokens.borderL2}`,
		            background: "transparent",
		            color: tokens.labelPrimary
		          }
		        },
		        "\u91CD\u8BD5"
		      ),
		      (0, import_react.createElement)(
		        "button",
		        {
		          onClick: () => window.open(origin, "_blank", "noopener"),
		          style: {
		            cursor: "pointer",
		            padding: "6px 14px",
		            fontSize: 13,
		            borderRadius: 8,
		            border: `1px solid ${tokens.borderL2}`,
		            background: "transparent",
		            color: tokens.labelPrimary
		          }
		        },
		        "\u5728\u7CFB\u7EDF\u6D4F\u89C8\u5668\u6253\u5F00"
		      )
		    )
		  );
		}
		function TaskboardView() {
		  const board = useTaskboardChannel();
		  return (0, import_react.createElement)(
		    "div",
		    {
		      "data-taskboard-view": true,
		      style: {
		        height: "100%",
		        minHeight: 0,
		        display: "flex",
		        flexDirection: "column",
		        background: tokens.bgBase,
		        color: tokens.labelPrimary
		      }
		    },
		    (0, import_react.createElement)(
		      "div",
		      {
		        style: {
		          display: "flex",
		          justifyContent: "flex-end",
		          alignItems: "center",
		          gap: 4,
		          padding: "4px 10px",
		          borderBottom: `1px solid ${tokens.borderL2}`,
		          fontSize: 12,
		          flex: "none"
		        }
		      },
		      (0, import_react.createElement)(
		        "button",
		        {
		          onClick: () => window.open(board.origin, "_blank", "noopener"),
		          title: "\u5728\u7CFB\u7EDF\u6D4F\u89C8\u5668\u6253\u5F00",
		          style: {
		            cursor: "pointer",
		            border: "none",
		            background: "transparent",
		            color: tokens.labelSecondary,
		            fontSize: 12,
		            padding: "4px 8px",
		            borderRadius: 6
		          }
		        },
		        "\u2197 \u5728\u7CFB\u7EDF\u6D4F\u89C8\u5668\u6253\u5F00"
		      )
		    ),
		    (0, import_react.createElement)(BoardFrame, { ...board, frameTitle: "Taskboard" })
		  );
		}
		function KanbanIcon(props) {
		  return (0, import_react.createElement)(
		    "svg",
		    {
		      width: props.size,
		      height: props.size,
		      viewBox: "0 0 16 16",
		      fill: "none",
		      "aria-hidden": true,
		      style: { flex: "none", display: "block" }
		    },
		    (0, import_react.createElement)("rect", { x: 1.75, y: 2, width: 3.5, height: 12, rx: 1, fill: "currentColor" }),
		    (0, import_react.createElement)("rect", { x: 6.25, y: 2, width: 3.5, height: 8, rx: 1, fill: "currentColor" }),
		    (0, import_react.createElement)("rect", { x: 10.75, y: 2, width: 3.5, height: 10, rx: 1, fill: "currentColor" })
		  );
		}
		function findTaskboardTabButton() {
		  const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
		  return tabs.find((button) => button.textContent?.trim() === "Taskboard") ?? null;
		}
		function openTaskboardView(ctx) {
		  const tab = findTaskboardTabButton();
		  if (tab !== null) {
		    tab.click();
		    return;
		  }
		  void (async () => {
		    try {
		      const threadId = await ctx.sessions.create({});
		      ctx.sessions.open(threadId);
		      for (let attempt = 0; attempt < 30; attempt += 1) {
		        await new Promise((resolve) => setTimeout(resolve, 100));
		        const pending = findTaskboardTabButton();
		        if (pending !== null) {
		          pending.click();
		          return;
		        }
		      }
		    } catch {
		    }
		  })();
		}
		function TaskboardSidebarEntry(props) {
		  if (props.wide === false) {
		    return (0, import_react.createElement)(
		      "button",
		      {
		        // 复用 ui-sidebar 自有 iconButton 样式（28x28，收起态由其 CSS 放大到 36x36，含 hover 底色）；
		        // 该类名是其 CSS module 构建产物名，跨宿主版本不保证稳定，故内联等值样式兜底（本分支只在收起轨道渲染，恒为 36x36）。
		        className: "hHd-Xa_iconButton",
		        onClick: () => {
		          props.onExpandRail();
		          props.onOpen();
		        },
		        title: "Taskboard",
		        "aria-label": "Taskboard",
		        style: {
		          cursor: "pointer",
		          width: 36,
		          height: 36,
		          border: "none",
		          background: "transparent",
		          borderRadius: "50%",
		          display: "inline-flex",
		          alignItems: "center",
		          justifyContent: "center",
		          padding: 0,
		          color: tokens.labelSecondary,
		          flex: "none"
		        }
		      },
		      (0, import_react.createElement)(KanbanIcon, { size: 18 })
		    );
		  }
		  return (0, import_react.createElement)(
		    "button",
		    {
		      onClick: () => props.onOpen(),
		      style: {
		        width: "100%",
		        boxSizing: "border-box",
		        display: "flex",
		        alignItems: "center",
		        gap: 6,
		        padding: "5px 8px",
		        cursor: "pointer",
		        border: "none",
		        background: "transparent",
		        color: tokens.labelPrimary,
		        fontSize: 12,
		        borderRadius: 6,
		        textAlign: "left"
		      }
		    },
		    (0, import_react.createElement)(KanbanIcon, { size: 14 }),
		    (0, import_react.createElement)("span", { style: { flex: 1, minWidth: 0 } }, "Taskboard")
		  );
		}
		function postToTaskboardFrame(message) {
		  const frame = document.querySelector('iframe[title="Taskboard"]');
		  frame?.contentWindow?.postMessage(message, "*");
		}
		function apply(ctx) {
		  ctx.effect(() => {
		    const onMessage = (event) => {
		      const data = event.data;
		      if (!data || typeof data.type !== "string") return;
		      if (data.type === "taskboard:open-thread") {
		        const threadId = typeof data.payload?.threadId === "string" ? data.payload.threadId.trim() : "";
		        if (!threadId) return;
		        ctx.sessions.open(threadId);
		        return;
		      }
		      if (data.type === "taskboard:create-thread") {
		        const taskId = typeof data.payload?.taskId === "string" ? data.payload.taskId : "";
		        if (!taskId) return;
		        const workspacePath = typeof data.payload?.workspacePath === "string" ? data.payload.workspacePath.trim() : "";
		        void (async () => {
		          try {
		            const threadId = await ctx.sessions.create(workspacePath ? { cwd: workspacePath } : {});
		            const bind = await fetch("/plugins/taskboard/bind-task", {
		              method: "POST",
		              headers: { "content-type": "application/json" },
		              body: JSON.stringify({ taskId, threadId })
		            });
		            if (!bind.ok) throw new Error(`bind-task ${bind.status}`);
		            postToTaskboardFrame({ type: "taskboard:thread-prepared", payload: { taskId, threadId } });
		            ctx.sessions.open(threadId);
		          } catch (error) {
		            postToTaskboardFrame({
		              type: "taskboard:thread-create-error",
		              payload: { taskId, error: String(error?.message ?? error) }
		            });
		          }
		        })();
		      }
		    };
		    window.addEventListener("message", onMessage);
		    return () => {
		      window.removeEventListener("message", onMessage);
		    };
		  }, "taskboard: open-thread bridge");
		  ctx.slots.inject(
		    "conversation.view",
		    () => ctx.slots.register(
		      { name: "conversation.view", id: "taskboard", order: 20, label: () => "Taskboard" },
		      TaskboardView
		    )
		  );
		  ctx.effect(() => {
		    const resetIfBoardActive = () => {
		      const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
		      const board = tabs.find((button) => button.textContent?.trim() === "Taskboard");
		      if (board === void 0 || board.getAttribute("aria-selected") !== "true") return;
		      const chat = tabs.find(
		        (button) => button !== board && button.textContent?.trim() !== "Taskboard"
		      );
		      chat?.click();
		    };
		    const onClick = (event) => {
		      const target = event.target;
		      if (target === null) return;
		      const row = target.closest('[role="treeitem"][aria-selected]');
		      if (row === null) return;
		      if (target.closest("button") !== null) return;
		      window.setTimeout(resetIfBoardActive, 60);
		      window.setTimeout(resetIfBoardActive, 250);
		    };
		    document.addEventListener("click", onClick, true);
		    return () => document.removeEventListener("click", onClick, true);
		  }, "taskboard: session row click resets board view");
		  ctx.effect(() => {
		    const hide = () => {
		      document.querySelectorAll('button[role="tab"]').forEach((button) => {
		        if (button.textContent?.trim() === "Taskboard") button.style.display = "none";
		      });
		    };
		    hide();
		    const observer = new MutationObserver(hide);
		    observer.observe(document.body, { childList: true, subtree: true });
		    return () => observer.disconnect();
		  }, "taskboard: hide conversation view tab");
		  ctx.slots.inject(
		    "sidebar.footer.action",
		    () => ctx.slots.register(
		      { name: "sidebar.footer.action", id: "taskboard", order: 10, label: () => "Taskboard" },
		      (props) => (0, import_react.createElement)(TaskboardSidebarEntry, {
		        wide: props?.wide,
		        onOpen: () => openTaskboardView(ctx),
		        onExpandRail: () => ctx.layout.toggleSidebar()
		      })
		    )
		  );
		}
		
		return module.exports;
	}
});
