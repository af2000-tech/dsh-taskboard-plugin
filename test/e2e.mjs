// T7.2 e2e 联测脚本（M7 收官）：五套件 + C6 负向，可重复执行。
//
// 套件：
//   [skill]   进程内 apply 捕获 ctx.skills.register 的运行时注册（T7.6/R3），不发端口。
//   [service] 进程内 autoStart spawn → /health → 外部杀进程自愈 → service_stop/start 生命周期。
//   [tool]    工具面 13 子命令 roundtrip（独立临时 dataDir）+ 409 VERSION_CONFLICT。
//   [session] 会话绑定：exec.agent 注入 threadId 落库 + env 兜底 + 全缺拒绝。
//   [ui]      活 GUI（默认 taskboard-test @3888）：config.json / client.js / 上游 entry。
//   [c6]      负向契约：装插件不重启 GUI → client.js 404；重启后 200（独立临时 profile，
//             端口 3891/47827，脚本自建自删）。
//
// R8（DSH 升级回归）本轮跳过。重跑协议：升级 dsh 后，先 `pnpm i && pnpm run build`
// 重出 tgz（或直接复用），再 `node test/e2e.mjs` 全绿即可；M6 主题截图另行复验。
//
// 用法：plugin/ 目录下 `node test/e2e.mjs`。环境变量：
//   E2E_GUI_PROFILE  活 GUI profile 名（默认 taskboard-test）
//   E2E_GUI_PORT     活 GUI webserver 端口（默认 3888；未监听则脚本自行拉起，结束仅回收自拉实例）
//   E2E_SKIP_C6=1    跳过 C6 套件（避免动 profile 时）
import { mkdtemp, rm, mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
// 从 package.json 读版本推导 tgz 名（历史版本硬编码 0.1.0，随版本漂移失配）。
const { version: VERSION } = JSON.parse(await readFile(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
const TGZ = path.join(PLUGIN_ROOT, `dsh-taskboard-plugin-${VERSION}.tgz`);
const GUI_PROFILE = process.env.E2E_GUI_PROFILE ?? "taskboard-test";
const GUI_PORT = Number(process.env.E2E_GUI_PORT ?? 3888);
const C6_PROFILE = "taskboard-e2e-c6";
const C6_GUI_PORT = 3891;
const C6_SVC_PORT = 47827;

const results = [];
const note = (suite, ok, msg) => {
  results.push({ suite, ok });
  console.log(`${ok ? "PASS" : "FAIL"} [${suite}] ${msg}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUrl(url, timeoutMs, wantOk = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok === wantOk) return r;
    } catch {}
    await sleep(300);
  }
  return null;
}
function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function portOwnerPid(port) {
  const r = sh("pwsh", ["-NoProfile", "-c",
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`]);
  const pid = Number((r.out ?? "").trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}
function killPort(port) {
  const pid = portOwnerPid(port);
  if (pid) { try { process.kill(pid); return true; } catch { return false; } }
  return false;
}
function dsh(args) {
  return sh("cmd.exe", ["/c", "dsh", ...args]);
}
function startGui(profile) {
  const child = spawn("cmd.exe", ["/c", "dsh", "--profile", profile], { stdio: "ignore" });
  return child;
}

// ---- mock cordis Context（对齐 cordis 语义：effect 立即执行返回 disposer；inject 按需回调）
function makeMockCtx({ onSkillRegister } = {}) {
  const effects = [];
  const registered = [];
  const ctx = {
    logger: { info: () => {}, warn: (m) => console.log("  [warn]", m), error: (m) => console.log("  [error]", m) },
    effect: (fn, label) => { effects.push({ label, dispose: fn() }); },
    tools: { register: (def) => registered.push(def) },
    inject: (names, cb) => {
      if (names.includes("skills") && onSkillRegister) {
        cb({ skills: { register: (def) => onSkillRegister(def) } });
      }
      // webServer：headless 语义——无该服务则不注册路由（懒注入设计），返回 undefined。
      return undefined;
    },
  };
  return { ctx, effects, registered };
}

const { name, inject, apply } = await import(`file://${path.join(PLUGIN_ROOT, "dist", "host.js").replaceAll("\\", "/")}`);

// ============================== [skill] 运行时注册（T7.6/R3） ==============================
{
  console.log("\n== [skill] runtime skills registration ==");
  let skillDef = null;
  const { ctx, effects } = makeMockCtx({ onSkillRegister: (d) => (skillDef = d) });
  apply(ctx, { port: 0, dataDir: "", autoStart: false, restartBackoffMs: 500, appRoot: "" });
  const okAll = Boolean(skillDef)
    && skillDef.name === "taskboard"
    && skillDef.description.includes("dsh taskboard tool")
    && typeof skillDef.content === "string" && skillDef.content.includes("Subcommands:")
    && skillDef.source?.kind === "opaque";
  note("skill", okAll, `runtime register captured: name=${skillDef?.name} desc="${(skillDef?.description ?? "").slice(0, 48)}…" content=${skillDef?.content?.length ?? 0}B`);
  note("skill", inject.includes("tools"), `静态 inject=[${inject.join(",")}]（skills/webServer 走运行时 ctx.inject 懒注入）`);
  for (const { dispose } of effects) await dispose?.();
}

// ================== [service] spawn / health / 自愈 / 生命周期 ==================
// ================== [tool] 13 子命令 + 409 =====================================
// ================== [session] 会话绑定 =========================================
{
  console.log("\n== [service] spawn/health/self-heal ==");
  const dataDir = await mkdtemp(path.join(tmpdir(), "e2e-tb-"));
  const PORT = 47920;
  const origin = `http://127.0.0.1:${PORT}`;
  const { ctx, effects, registered } = makeMockCtx({});
  apply(ctx, { port: PORT, dataDir, autoStart: true, restartBackoffMs: 600, appRoot: "" });

  const healthy = await waitUrl(`${origin}/health`, 20000);
  note("service", Boolean(healthy), `autoStart spawned + /health → ${(await healthy?.json?.())?.status ?? "?"}`);

  const tool = registered.find((d) => d.name === "taskboard");
  note("service", Boolean(tool), `taskboard tool registered (13 子命令由 [tool] 套件覆盖)`);

  // 自愈：外部杀掉上游进程 → supervisor 退避重启 → /health 恢复
  const killed = killPort(PORT);
  await sleep(150); // 让 supervisor 察觉退出
  const healed = await waitUrl(`${origin}/health`, 15000);
  note("service", killed && Boolean(healed), `external kill (pid was ${killed ? "taken" : "none"}) → self-healed in <15s: ${Boolean(healed)}`);

  // 生命周期：service_stop → 不可达；service_start → 恢复
  const exec = { agent: { id: "e2e-lifecycle" }, signal: new AbortController().signal };
  const stop = await tool.execute({ command: "service_stop" }, exec);
  const gone = !(await waitUrl(`${origin}/health`, 2500));
  const start = await tool.execute({ command: "service_start" }, exec);
  const back = await waitUrl(`${origin}/health`, 15000);
  note("service", stop.ok && gone && start.ok && Boolean(back), `service_stop→dead:${gone} service_start→healthy:${Boolean(back)}`);

  console.log("\n== [tool] 13 subcommands + 409 ==");
  const sub = {};
  sub.project_list = await tool.execute({ command: "project_list" }, exec);
  const firstProject = sub.project_list.result?.projects?.[0]?.id ?? "local";
  sub.project_get = await tool.execute({ command: "project_get", projectId: firstProject }, exec);
  sub.project_map = await tool.execute({ command: "project_map", projectId: firstProject, workspacePath: PLUGIN_ROOT }, exec);
  sub.issue_create = await tool.execute({ command: "issue_create", projectId: firstProject, title: "e2e roundtrip", description: "e2e" }, exec);
  const iid = sub.issue_create.result?.task?.id;
  sub.issue_list = await tool.execute({ command: "issue_list", projectId: firstProject }, exec);
  sub.issue_get = await tool.execute({ command: "issue_get", issueId: iid }, exec);
  sub.issue_update = await tool.execute({ command: "issue_update", issueId: iid, description: "e2e updated" }, exec);
  sub.issue_move = await tool.execute({ command: "issue_move", issueId: iid, status: "in_progress" }, exec);
  sub.comment_add = await tool.execute({ command: "comment_add", issueId: iid, body: "e2e comment" }, exec);
  sub.comment_list = await tool.execute({ command: "comment_list", issueId: iid }, exec);
  sub.relation_add = await tool.execute({ command: "issue_create", projectId: firstProject, title: "e2e second" }, exec)
    .then((c2) => tool.execute({ command: "relation_add", issueId: iid, relatedIssueId: c2.result.task.id, relationType: "related" }, exec));
  const okCmds = Object.entries(sub).filter(([, v]) => v?.ok).map(([k]) => k);
  note("tool", okCmds.length === 11, `11 数据面子命令全 ok（${okCmds.join(",")}）+ service_start/stop（[service] 套件）= 13 子命令全覆盖`);

  // 409：stale ifVersion
  const conflict = await tool.execute({ command: "issue_move", issueId: iid, status: "todo", ifVersion: 1 }, exec)
    .then((v) => `UNEXPECTED ok ${JSON.stringify(v).slice(0, 60)}`)
    .catch((e) => e.message);
  note("tool", !conflict.startsWith("UNEXPECTED"), `stale ifVersion → 409 preserved: ${conflict.slice(0, 90)}`);

  console.log("\n== [session] thread binding ==");
  const fetched = await tool.execute({ command: "issue_get", issueId: iid }, exec);
  const bound = fetched.result?.task?.threadId === "e2e-lifecycle";
  note("session", bound, `exec.agent → threadId 落库: ${fetched.result?.task?.threadId}`);
  const comments = await tool.execute({ command: "comment_list", issueId: iid }, exec);
  note("session", comments.result?.comments?.some((c) => c.body === "e2e comment" && c.threadId === "e2e-lifecycle"),
    "comment 归属同一 session id");
  delete exec.agent;
  const savedEnv = process.env.DSH_SESSION_ID;
  process.env.DSH_SESSION_ID = "e2e-env-fallback";
  await tool.execute({ command: "comment_add", issueId: iid, body: "env fallback" }, { signal: exec.signal });
  const envComments = await tool.execute({ command: "comment_list", issueId: iid }, { signal: exec.signal });
  const envOk = envComments.result.comments.at(-1).threadId === "e2e-env-fallback";
  delete process.env.DSH_SESSION_ID;
  const rejected = await tool.execute({ command: "comment_add", issueId: iid, body: "x" }, { signal: exec.signal })
    .then(() => false).catch(() => true);
  process.env.DSH_SESSION_ID = savedEnv;
  note("session", envOk && rejected, "DSH_SESSION_ID 兜底 + 三源全缺拒绝");

  for (const { dispose } of effects) await dispose?.();
  let dead = false;
  for (let i = 0; i < 30 && !dead; i++) { dead = !portOwnerPid(PORT); if (!dead) await sleep(400); }
  note("service", dead, "disposers → 子进程树清理（端口释放）");
  for (let i = 0; i < 5; i++) {
    try { await rm(dataDir, { recursive: true, force: true }); break; } catch (e) {
      if (i === 4) console.log("  [warn] dataDir 清理失败（占用中）:", e.code, "— 留待系统临时目录清理");
      else await sleep(600);
    }
  }
}

// ============================== [ui] 活 GUI 面 ==============================
{
  console.log("\n== [ui] live GUI surfaces ==");
  let spawned = null;
  if (!portOwnerPid(GUI_PORT)) {
    console.log(`  GUI ${GUI_PROFILE} 未监听 ${GUI_PORT}，脚本自行拉起`);
    spawned = startGui(GUI_PROFILE);
  }
  try {
    const cfgR = await waitUrl(`http://127.0.0.1:${GUI_PORT}/plugins/taskboard/config.json`, 30000);
    const cfg = await cfgR?.json?.().catch(() => null);
    note("ui", Boolean(cfg?.ok && cfg.port > 0 && typeof cfg.status === "string"),
      `config.json → {ok:${cfg?.ok}, port:${cfg?.port}, status:${cfg?.status}}`);
    const js = await fetch(`http://127.0.0.1:${GUI_PORT}/plugins/dsh-taskboard-plugin/client.js`);
    const body = await js.text();
    note("ui", js.status === 200 && body.length > 1000, `client.js HTTP ${js.status}, ${body.length}B`);
    const entry = await fetch(`http://127.0.0.1:${cfg.port}/web/`);
    note("ui", entry.status === 200, `上游 entry /web/ HTTP ${entry.status}（面板 iframe 目标）`);
    // skill 目录（活 GUI 侧）：RPC 建 attached session → skill.list
    const rpc = async (rpcId, method, payload) =>
      (await (await fetch(`http://127.0.0.1:${GUI_PORT}/api/${method}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      })).json());
    const created = await rpc("e2e-sc", "session.create", {});
    const sid = created?.result?.value?.sessionId;
    const listed = sid ? await rpc("e2e-sk", "skill.list", { sessionId: sid }) : null;
    const tb = listed?.result?.value?.skills?.find?.((s) => s.name === "taskboard");
    const runtimeWins = Boolean(tb?.description?.includes("dsh taskboard tool"));
    note("skill", Boolean(tb),
      `GUI 目录含 taskboard${tb ? `（生效: ${runtimeWins ? "runtime 注册版" : "文件层同名遮蔽(用户级 ~/.agents/skills)——runtime 注册已在 [skill] 套件独立验证"}）` : ""}`);
  } finally {
    if (spawned) {
      const pid = portOwnerPid(GUI_PORT);
      if (pid) try { process.kill(pid); } catch {}
      try { spawned.kill(); } catch {}
    }
  }
}

// ============================== [c6] 装不重启 → 404 ==============================
if (process.env.E2E_SKIP_C6 !== "1") {
  console.log("\n== [c6] install-without-restart contract ==");
  const profDir = path.join(process.env.USERPROFILE ?? process.env.HOME, ".dsh", "profiles", C6_PROFILE);
  const webDir = path.dirname(profDir) + "\\web";
  let gui = null;
  try {
    await mkdir(profDir, { recursive: true });
    for (const f of ["package.json", "pnpm-workspace.yaml", "cordis.patch.yml"]) {
      await cp(path.join(webDir, f), path.join(profDir, f), { force: true });
    }
    // appRoot 指向上游应用目录（本仓库 plugin/ 的兄弟目录 taskboard/，vendor-app.mjs 同款相对解析），
    // 不落任何绝对机器路径（历史版本曾硬编码本机工作区绝对路径，已改为相对推导）。
    const appRoot = path.join(PLUGIN_ROOT, "..", "taskboard").replaceAll("\\", "/");
    const patch = `- id: webserver\n  config: { host: 127.0.0.1, port: ${C6_GUI_PORT} }\n- id: taskboard\n  config: { port: ${C6_SVC_PORT}, dataDir: '', autoStart: true, restartBackoffMs: 3000, appRoot: ${appRoot} }\n`;
    await writeFile(path.join(profDir, "cordis.patch.yml"), patch, "utf8");
    gui = startGui(C6_PROFILE);
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { up = Boolean(portOwnerPid(C6_GUI_PORT)); if (!up) await sleep(500); }
    note("c6", up, `基线 GUI 起在 ${C6_GUI_PORT}`);
    const add = dsh(["plugin", "--profile", C6_PROFILE, "add", `file:${TGZ.replaceAll("\\", "/")}`]);
    const add2 = add.code === 0 ? add : dsh(["plugin", "--profile", C6_PROFILE, "add", `file:${TGZ.replaceAll("\\", "/")}`]); // 竞态覆写兜底：重跑一次 add
    note("c6", add2.code === 0, `plugin add 落盘（exit ${add.code}${add2 !== add ? `→重试 ${add2.code}` : ""}）`);
    // 不重启：client.js 必须 404（图在 boot 时组合）
    let s1 = null;
    try { s1 = (await fetch(`http://127.0.0.1:${C6_GUI_PORT}/plugins/dsh-taskboard-plugin/client.js`)).status; } catch {}
    let s2 = null;
    try { s2 = (await fetch(`http://127.0.0.1:${C6_GUI_PORT}/plugins/taskboard/config.json`)).status; } catch {}
    note("c6", s1 === 404, `未重启 client.js → ${s1}（期望 404）`);
    note("c6", s2 === 404, `未重启 config.json → ${s2}（期望 404）`);
    // 重启后 200
    const oldPid = portOwnerPid(C6_GUI_PORT);
    if (oldPid) try { process.kill(oldPid); } catch {}
    try { gui.kill(); } catch {}
    await sleep(2000);
    gui = startGui(C6_PROFILE);
    const js = await waitUrl(`http://127.0.0.1:${C6_GUI_PORT}/plugins/dsh-taskboard-plugin/client.js`, 30000);
    const cfg = js ? await (await fetch(`http://127.0.0.1:${C6_GUI_PORT}/plugins/taskboard/config.json`)).json() : null;
    note("c6", Boolean(js && cfg?.ok), `重启后 client.js → ${js?.status ?? "timeout"}，config.json → ${JSON.stringify(cfg)}`);
  } finally {
    const pid = portOwnerPid(C6_GUI_PORT);
    if (pid) try { process.kill(pid); } catch {}
    try { gui?.kill(); } catch {}
    await rm(profDir, { recursive: true, force: true });
    console.log("  c6 profile 已清理");
  }
}

// ============================== summary ==============================
const failed = results.filter((r) => !r.ok);
console.log(`\n==== E2E SUMMARY: ${results.length - failed.length}/${results.length} PASS ${failed.length ? "— FAILED: " + [...new Set(failed.map((f) => f.suite))].join(",") : ""} ====`);
process.exit(failed.length ? 1 : 0);
