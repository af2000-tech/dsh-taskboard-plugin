// dsh-taskboard-plugin — Client 半边（R3：conversation.view 主区视图；R4：sidebar.footer.action 侧栏快捷入口）。
// 画面：dsh-client-ui-conversation 的 conversation.view 插槽（kind: list, scope: session；trajectory 同款接入）
// 注册铺满主区（conversation 列）的看板视图；入口不占会话页签——页签按钮由 DOM 层隐藏（宿主 viewTabs
// 无隐藏选项），激活走程序化点击同一条 ui-conversation actions.setView 路径，切回用可见的 对话/轨迹 页签。
// 入口：dsh-client-ui-sidebar 的 sidebar.footer.action 插槽（kind: list, scope: root）——
// SidebarRoot 底部 footArea 先渲染 footer.action 再渲染 settings，占用者天然位于 Settings 按钮正上方
// （cordis-panel 同款接入）；宿主经 renderSlot 只传 { wide: boolean }（true=展开侧栏，false=56px 收起轨道）。
// ADR-12 嵌入路径 A（iframe 直连 http://127.0.0.1:<port>/，M4 已证 SSE 在线）。
// 构建产物为 window.__ModuleLoader__.load({ id, factory: (require) => ... }) 包装（scripts/build.mjs）。
// react 为 peer external：esbuild CJS 输出把下面的 import 转为 require("react")，由宿主 ModuleLoader 注入。
import { createElement, useEffect, useState } from "react";

/** 客户端 cordis 服务依赖（服务名）：slots=视图页签/侧栏入口注册；sessions=「在对话中打开」（taskboard:open-thread → ctx.sessions.open，in-box workflow-run 同款）；layout=收起轨道图标钮先展开侧栏（ctx.layout.toggleSidebar，ui-sidebar 自身折叠钮同款调用）。 */
export const inject = ["slots", "sessions", "layout"];

/** ADR-12 约定默认端口（host 配置未覆盖时的回退值）。 */
const DEFAULT_PORT = 47823;

/** host 半边注册的同源 port 通道（见 host.ts apply；exact 路由，GUI 自身 origin）。 */
const PORT_CHANNEL_URL = "/plugins/taskboard/config.json";

/** host 状态通道判定：这两种状态才值得挂 iframe（盲探会被端口上的任意 200 占用者骗过）。 */
function hostStatusServes(status: unknown): boolean {
  return status === "ready" || status === "adopted";
}

/** 解析实际端口与 host 监督器状态：同源 config.json 优先，失败回退约定默认（状态未知）。 */
async function resolveChannel(signal: AbortSignal): Promise<{ port: number; status: unknown }> {
  try {
    const response = await fetch(PORT_CHANNEL_URL, { signal });
    if (!response.ok) return { port: DEFAULT_PORT, status: undefined };
    const data: unknown = await response.json();
    const channel = data as { port?: unknown; status?: unknown } | null;
    const port = channel?.port;
    if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) {
      return { port, status: channel?.status };
    }
    return { port: DEFAULT_PORT, status: channel?.status };
  } catch {
    return { port: DEFAULT_PORT, status: undefined };
  }
}

/** 探测 taskboard 服务存活：no-cors 盲探（跨源无 CORS 头可读；opaque 响应足以判活）。 */
async function probeHealth(origin: string, signal: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
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

type ViewPhase = "resolving" | "loading" | "ready" | "down";

/** 主题 token 引用（全部带 fallback，theme-tokens.md §3 纪律）。 */
const tokens = {
  bgBase: "var(--dsw-alias-bg-base, #fff)",
  borderL2: "var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
  labelPrimary: "var(--dsw-alias-label-primary, inherit)",
  labelSecondary: "var(--dsw-alias-label-secondary, inherit)",
};

/**
 * 通道解析 + 健康探测共用核心（会话页签视图与侧栏内嵌面板同一路径）：
 * 挂载 → 同源解析端口 → /health 双闸探测；retry 供降级屏「重试」按钮重跑整个流程；
 * markReady 供 iframe onLoad 熄灭加载覆盖层。卸载时 effect 清理中止在途探测。
 */
function useTaskboardChannel() {
  const [phase, setPhase] = useState<ViewPhase>("resolving");
  const [origin, setOrigin] = useState(`http://127.0.0.1:${DEFAULT_PORT}`);
  const [hostStatus, setHostStatus] = useState<unknown>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setPhase("resolving");
    setHostStatus(undefined);
    const attempt = async () => {
      const channel = await resolveChannel(controller.signal);
      const resolvedOrigin = `http://127.0.0.1:${channel.port}`;
      if (cancelled) return;
      setOrigin(resolvedOrigin);
      setHostStatus(channel.status);
      // 双闸：host 监督器状态（权威）+ no-cors 盲探（兜底刚崩溃的窄窗）。
      const healthy = hostStatusServes(channel.status)
        && await probeHealth(resolvedOrigin, controller.signal);
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
      const healthy = hostStatusServes(channel.status)
        && await probeHealth(resolvedOrigin, controller.signal);
      setPhase(healthy ? "loading" : "down");
    })().catch(() => setPhase("down"));
  };

  return { phase, origin, hostStatus, retry, markReady: () => setPhase("ready") };
}

/**
 * 看板帧渲染核心（不含外壳工具栏）：phase=ready/loading → iframe 直连（ADR-12 路径 A），
 * 加载覆盖层在 iframe onLoad 后消失；其余 → 降级屏（提示 + [重试] + [在系统浏览器打开]）。
 * frameTitle 必须按挂载面区分：会话页签固定 "Taskboard"——postMessage 桥按
 * iframe[title="Taskboard"] 属性精确选择，只允许命中会话页签帧；侧栏内嵌面板用
 * "Taskboard Sidebar"，属性精确匹配不会命中它，桥的语义保持不变。
 */
function BoardFrame(props: {
  phase: ViewPhase;
  origin: string;
  hostStatus: unknown;
  retry: () => void;
  markReady: () => void;
  frameTitle: string;
}) {
  const { phase, origin, hostStatus, retry, markReady, frameTitle } = props;
  if (phase === "ready" || phase === "loading") {
    return createElement(
      "div",
      { style: { position: "relative", flex: 1, minHeight: 0 } },
      createElement("iframe", {
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
          display: "block",
        },
      }),
      phase === "loading"
        ? createElement(
            "div",
            {
              style: {
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                fontSize: 13,
                color: tokens.labelSecondary,
                background: tokens.bgBase,
              },
            },
            "Taskboard 加载中…",
          )
        : null,
    );
  }
  return createElement(
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
        color: tokens.labelSecondary,
      },
      "data-taskboard-degraded": true,
    },
    createElement(
      "div",
      null,
      phase === "resolving"
        ? "正在连接 Taskboard 服务…"
        : `Taskboard 服务未启动${typeof hostStatus === "string" ? `（host 状态: ${hostStatus}）` : ""}`,
    ),
    createElement(
      "div",
      { style: { display: "flex", gap: 8 } },
      createElement(
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
            color: tokens.labelPrimary,
          },
        },
        "重试",
      ),
      createElement(
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
            color: tokens.labelPrimary,
          },
        },
        "在系统浏览器打开",
      ),
    ),
  );
}

/**
 * 看板主区视图（conversation.view 占用者，官方 trajectory 同款接入）：
 * 顶部工具栏（↗ 在系统浏览器打开）+ BoardFrame（通道解析 → 探测 → iframe 直连 / 降级屏），
 * 外壳行为与 DOM 与拆分前完全一致。主题仅外壳跟随 DSH token——iframe 内部为 taskboard
 * 自有 UI，不跨源同步主题（已裁定）。
 */
function TaskboardView() {
  const board = useTaskboardChannel();
  return createElement(
    "div",
    {
      "data-taskboard-view": true,
      style: {
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: tokens.bgBase,
        color: tokens.labelPrimary,
      },
    },
    createElement(
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
          flex: "none",
        },
      },
      createElement(
        "button",
        {
          onClick: () => window.open(board.origin, "_blank", "noopener"),
          title: "在系统浏览器打开",
          style: {
            cursor: "pointer",
            border: "none",
            background: "transparent",
            color: tokens.labelSecondary,
            fontSize: 12,
            padding: "4px 8px",
            borderRadius: 6,
          },
        },
        "↗ 在系统浏览器打开",
      ),
    ),
    createElement(BoardFrame, { ...board, frameTitle: "Taskboard" }),
  );
}

/** 内联三列看板图标（dsh-client-ui-primitives 不在本 bundle 的 external 面里，故自绘；currentColor 跟随宿主 token 颜色）。 */
function KanbanIcon(props: { size: number }) {
  return createElement(
    "svg",
    {
      width: props.size,
      height: props.size,
      viewBox: "0 0 16 16",
      fill: "none",
      "aria-hidden": true,
      style: { flex: "none", display: "block" },
    },
    createElement("rect", { x: 1.75, y: 2, width: 3.5, height: 12, rx: 1, fill: "currentColor" }),
    createElement("rect", { x: 6.25, y: 2, width: 3.5, height: 8, rx: 1, fill: "currentColor" }),
    createElement("rect", { x: 10.75, y: 2, width: 3.5, height: 10, rx: 1, fill: "currentColor" }),
  );
}

/**
 * 找到会话头部的 Taskboard 视图页签按钮（conversation.view 占用者；已被 observer display:none，
 * 但仍在 DOM 且程序化 .click() 照常派发 React 合成事件）。按自身注册的固定 label 文本匹配，
 * 与侧栏快捷行（非 role=tab）不冲突。
 */
function findTaskboardTabButton(): HTMLButtonElement | null {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
  return tabs.find((button) => button.textContent?.trim() === "Taskboard") ?? null;
}

/**
 * 打开看板主区视图：点击（隐藏的）会话页签——与用户手点完全同一条 ui-conversation 激活路径
 * （actions.setView("taskboard")，视图状态随会话 store 持久化）。无页签（尚无打开的会话）时先新建
 * 会话再轮询等其头部渲染出来点击（与 taskboard:create-thread 桥的 create→open 同款链路）。
 */
function openTaskboardView(ctx: any) {
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
      // 新建会话失败则静默放弃（下次点击重试）。
    }
  })();
}

/**
 * 侧栏底部快捷入口（sidebar.footer.action 占用者，渲染于 Settings 按钮正上方；cordis-panel 同款）：
 * 纯快捷方式（图标+文字），自身不含任何面板——点击经 onOpen 把当前会话切到看板主区视图
 * （画面铺满右侧 conversation 列，与会话页签同款渲染）。
 * · wide=true（展开侧栏）：紧凑行按钮（看板图标 + Taskboard 文字）；
 * · wide=false（56px 收起轨道）：仅图标圆钮——点击先 onExpandRail()（注册处闭包
 *   ctx.layout.toggleSidebar 展开侧栏）再 onOpen() 切换视图。
 */
function TaskboardSidebarEntry(props: { wide?: boolean; onOpen: () => void; onExpandRail: () => void }) {
  if (props.wide === false) {
    return createElement(
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
          flex: "none",
        },
      },
      createElement(KanbanIcon, { size: 18 }),
    );
  }
  return createElement(
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
        textAlign: "left",
      },
    },
    createElement(KanbanIcon, { size: 14 }),
    createElement("span", { style: { flex: 1, minWidth: 0 } }, "Taskboard"),
  );
}

/** 宿主 → iframe 的 ack 通道（thread-prepared / thread-create-error，App.tsx receiveHostMessage 既有协议）。 */
function postToTaskboardFrame(message: Record<string, unknown>) {
  const frame = document.querySelector('iframe[title="Taskboard"]') as HTMLIFrameElement | null;
  frame?.contentWindow?.postMessage(message, "*");
}

/**
 * 注册形状：ctx.slots.inject(name, factory)（slot-notes §6 权威形状）——
 * 声明方重挂载/重建声明时按声明 epoch 自动重注册。
 */
export function apply(ctx: any) {
  // 「在对话中打开」双协议桥（iframe → 宿主 postMessage，上游既有通道，DSH 前无宿主监听）：
  // · taskboard:open-thread {threadId}——打开已绑定会话：ctx.sessions.open（目标会话默认落在 chat 视图）。
  // · taskboard:create-thread {taskId, workspacePath,…}——新建 DSH 会话（sessions.create({cwd})，
  //   connectWorkspace 同款、返回 session id）→ PATCH taskboard API 把 threadId 绑到议题
  //   （与工具面 issue_create 的 bare threadId 绑定同一路径）→ 回 thread-prepared ack → 打开。
  ctx.effect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        payload?: { threadId?: unknown; taskId?: unknown; workspacePath?: unknown };
      } | null;
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
        const workspacePath = typeof data.payload?.workspacePath === "string"
          ? data.payload.workspacePath.trim()
          : "";
        void (async () => {
          try {
            const threadId = await ctx.sessions.create(workspacePath ? { cwd: workspacePath } : {});
            const bind = await fetch("/plugins/taskboard/bind-task", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ taskId, threadId }),
            });
            if (!bind.ok) throw new Error(`bind-task ${bind.status}`);
            postToTaskboardFrame({ type: "taskboard:thread-prepared", payload: { taskId, threadId } });
            ctx.sessions.open(threadId);
          } catch (error) {
            postToTaskboardFrame({
              type: "taskboard:thread-create-error",
              payload: { taskId, error: String((error as Error)?.message ?? error) },
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
  // 官方主区视图（trajectory 同款）：conversation.view 注册保留——看板画面仍由 ui-conversation 的
  // 视图机器整页渲染（铺满 conversation 列）；但按需求入口不再以页签形式出现（下方 observer 隐藏），
  // 激活走侧栏快捷方式的程序化点击，切回用可见的 对话/轨迹 页签。
  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      { name: "conversation.view", id: "taskboard", order: 20, label: () => "Taskboard" },
      TaskboardView,
    ),
  );
  // 会话行点击落回对话视图：ui-workspace 的会话行/搜索结果行为 [role="treeitem"][aria-selected]
  // （文件夹行是 aria-expanded，天然排除）。点击已选中的会话行对宿主是 no-op——若该会话停在
  // 看板视图，画面毫无反应（用户实测卡点）；切到别的会话时也可能落在其记忆的看板视图上。
  // 语义对齐用户心智：会话列表点进去就是聊天，看板只从侧栏快捷方式进——点击行后若当前
  // 激活视图仍是看板，程序化点回第一个可见页签（对话，order 0；轨迹视图不受影响）。
  // 双时段复核（60ms/250ms）：切会话后头部页签异步重挂，早查可能读到旧会话 DOM。
  ctx.effect(() => {
    const resetIfBoardActive = () => {
      const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
      const board = tabs.find((button) => button.textContent?.trim() === "Taskboard");
      if (board === undefined || board.getAttribute("aria-selected") !== "true") return;
      const chat = tabs.find(
        (button) => button !== board && button.textContent?.trim() !== "Taskboard",
      );
      chat?.click();
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      const row = target.closest<HTMLElement>('[role="treeitem"][aria-selected]');
      if (row === null) return;
      // 行内按钮（… 菜单等）不视为打开会话，交给宿主自身处理。
      if (target.closest("button") !== null) return;
      window.setTimeout(resetIfBoardActive, 60);
      window.setTimeout(resetIfBoardActive, 250);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, "taskboard: session row click resets board view");
  // 页签隐藏：宿主 viewTabs() 会把 conversation.view 全部占用者列进页签环、无官方隐藏选项——
  // DOM 层把文本为 "Taskboard" 的 role=tab 按钮 display:none（React 不管理该按钮的 inline style，
  // 重挂载/切会话由 observer 兜底重隐）。隐藏不影响程序化 .click()（事件照常派发到 React 根）。
  ctx.effect(() => {
    const hide = () => {
      document.querySelectorAll<HTMLButtonElement>('button[role="tab"]').forEach((button) => {
        if (button.textContent?.trim() === "Taskboard") button.style.display = "none";
      });
    };
    hide();
    const observer = new MutationObserver(hide);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, "taskboard: hide conversation view tab");
  // 侧栏底部快捷入口（ui-sidebar 的 sidebar.footer.action 插槽，cordis-panel 同款；kind: list, scope: root）：
  // SidebarRoot 的 footArea 先渲染 footer.action 再渲染 settings，本入口自然位于 Settings 按钮上方。
  // 纯快捷方式（图标+文字）：点击把当前会话切到看板主区视图；收起轨道图标点击先展开侧栏再切换。
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      { name: "sidebar.footer.action", id: "taskboard", order: 10, label: () => "Taskboard" },
      (props: { wide?: boolean }) =>
        createElement(TaskboardSidebarEntry, {
          wide: props?.wide,
          onOpen: () => openTaskboardView(ctx),
          onExpandRail: () => ctx.layout.toggleSidebar(),
        }),
    ),
  );
}
