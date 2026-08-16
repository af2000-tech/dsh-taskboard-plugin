# dsh-taskboard-plugin

English | [简体中文](README.zh-CN.md)

Issue kanban for DeepSeek Harness (DSH) — a sidebar shortcut above Settings that opens the board in the main area, an agent tool, and a managed local service, in one self-contained plugin.

As of `0.2.0` the package is fully self-contained: the Taskboard application (a zero-dependency, pure-Node issue-board service with its prebuilt web UI) is vendored inside the package under `app/`. Installing the plugin is all there is to install.

## Features

- **Managed loopback service** — the plugin supervises the vendored Taskboard server as a local subprocess bound to `127.0.0.1` only: spawn + `/health` wait (30s ready timeout), log forwarding, crash restart with exponential backoff (`restartBackoffMs` base, capped at 30s; gives up after 5 consecutive failures — `service_start` retries), and tree-kill of the whole process tree on plugin dispose (`taskkill /T` on Windows, process-group kill on POSIX). If a healthy Taskboard instance already owns the port, the plugin **adopts** it instead of spawning a second one and never kills adopted instances on stop/dispose (adoption requires Taskboard's `/health` JSON contract — a plain 200 responder is not adopted). The child environment is an explicit allowlist plus the `TASKBOARD_*` contract — never a full `process.env` inheritance.
- **`taskboard` agent tool** — 13 subcommands via a single `command` parameter:
  - reads: `project_list`, `project_get`, `issue_list`, `issue_get`, `comment_list`
  - writes: `project_map`, `issue_create`, `issue_update`, `issue_move`, `comment_add`, `relation_add`
  - lifecycle: `service_start`, `service_stop`

  Writes are attributed to the current DSH session automatically (explicit `threadId` parameter wins, then the agent session id, then `DSH_SESSION_ID`; all three missing → the write is rejected). `project_map` binds a project to a local workspace path (a mutation, session-attributed like other writes). Issue writes use optimistic locking: omit `ifVersion` to reuse the latest version; an HTTP 409 `VERSION_CONFLICT` is surfaced verbatim so the agent can re-read and retry once. Issue statuses: `backlog` (not approved for execution), `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled`.
- **Sidebar shortcut** — a standalone **Taskboard** shortcut (icon + text) sits in the left sidebar's footer directly above the Settings button, via the official `sidebar.footer.action` slot (the same seam the built-in panel occupant uses; the shell hands occupants a `wide` flag). Clicking it switches the current session to the board view (the board fills the right-hand conversation column, same rendering as the main view below); in the collapsed 56px rail it is an icon-only button that expands the sidebar and then switches. With no open session, clicking creates one first. The shortcut itself contains no panel. Clicking a session row in the sidebar list always lands in the chat view (a session left on the board view is switched back automatically; the Trajectory view is unaffected).
- **Main-area view** — the board renders via the official `conversation.view` slot (the same seam the built-in Trajectory view uses) as an iframe direct-connecting to `http://127.0.0.1:<port>/`, filling the whole conversation area. Per requirement, the entry no longer appears as a tab after Chat / Trajectory in the conversation header — the tab button is hidden at the DOM level (the host tab ring has no official hide option) while the registration stays: the sidebar shortcut programmatically clicks that hidden tab (the exact same `actions.setView` activation path as a manual click), and switching back uses the visible Chat / Trajectory tabs. The shell follows DSH theme tokens (with fallbacks); the iframe's internal theme is the Taskboard app's own. When the service is down, the view degrades to a "service not running" screen with **Retry** and **Open in system browser** (bare loopback URL, no credentials).

  <!-- screenshot here -->
- **Port/status channel** — the client half resolves the actual port and supervisor status from a same-origin route registered on the GUI web server: `GET /plugins/taskboard/config.json` → `{ ok, port, status }` (statuses: `ready / adopted / starting / restarting / stopped / failed / disposed`). If the route is unavailable, the view falls back to the conventional default port `47823`.
- **Runtime skill registration** — the plugin registers a `taskboard` skill into the DSH skill registry at load and withdraws it on disable. It teaches agents the tool face (claim discipline, `backlog` = not approved, 409 retry-once, session attribution). A user-level skill file with the same name would shadow the runtime registration by name.

## Install

Primary path — install from GitHub, then restart the GUI:

```bash
dsh plugin --profile <name> add github:af2000-tech/dsh-taskboard-plugin
dsh --profile <name>   # (re)start the GUI
```

The plugin graph is composed when the GUI boots: installing into a profile whose GUI is already running takes effect only after a GUI restart (verified contract). This repository commits its build artifacts (`dist/`, `lib/`), so installs need **no build scripts and no build permission** — nothing runs at install time.

The package is self-contained: no external taskboard checkout, no extra downloads. Data lands in `~/.dsh/taskboard/data` by default (respects `$DSH_HOME`).

Alternative — tarball:

```bash
npm pack                                    # → dsh-taskboard-plugin-0.2.0.tgz
dsh plugin --profile <name> add file:<path-to-tgz>
```

Re-adding the same version is a no-op; run `dsh plugin --profile <name> remove dsh-taskboard-plugin` first when force-reinstalling a rebuilt tarball.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `port` | `47823` | Taskboard service port (loopback only — always `127.0.0.1`) |
| `dataDir` | `""` | SQLite data directory; empty = `$DSH_HOME/taskboard/data` (`~/.dsh/taskboard/data` without `DSH_HOME`) |
| `autoStart` | `true` | Start the service when the plugin loads; `false` defers to the first tool call or `service_start` |
| `restartBackoffMs` | `3000` | Crash-restart backoff base in ms (exponential, capped at 30s; gives up after 5 consecutive failures) |
| `appRoot` | `""` | Empty = the vendored app inside this package (normal path). Set to an external Taskboard app root (a checkout containing `server/index.mjs`) to run against it — an escape hatch, not the normal path |

> **Whole-row restatement warning (cordis patch semantics):** an entry in the profile's `cordis.patch.yml` that targets `id: taskboard` **replaces the entire config row** — it does not deep-merge with the bundle layer's config. When you override even one key (e.g. only `port`), restate every key you care about: omitted keys fall back to the schema defaults above, not to the bundle-layer values.

## Architecture

Dual-half cordis plugin:

- **Host half** (`dist/host.js`, ESM, peers external) — the `TaskboardService` supervisor, the `taskboard` tool registration, the same-origin status route, and the runtime skill registration (web server / skills services are injected lazily, so headless profiles load the plugin fine).
- **Client half** (`lib/client.js`) — one surface plus one entry point: the `conversation.view` main-area view (the official seam the built-in Trajectory view uses; full-size board iframe) and the `sidebar.footer.action` shortcut rendered directly above Settings (its click programmatically activates the hidden tab, switching the current session to the board view; with no session it creates one first). The conversation header's Taskboard tab button is hidden at the DOM level (the entry point lives solely in the sidebar); switching back uses the visible Chat / Trajectory tabs. The service origin is resolved exclusively from the port channel; the view degrades to the retry / open-in-browser screen when the supervisor is not `ready`/`adopted`.
- **Contract between the halves** — the single same-origin JSON route (`config.json`) plus the conventional default port `47823`; no cross-origin config access, no extra web-exposed surface. (The host also proxies one same-origin helper route, `POST /plugins/taskboard/bind-task`, used by the board UI to bind an issue to a conversation thread.)

Dependencies: the vendored app has zero npm dependencies (pure Node; it serves its prebuilt web UI from `app/dist/web/`). The host half uses only Node built-ins (`child_process`, `fs`, `os`, `path`, `url`); all plugin peer dependencies are provided by the DSH host at runtime — nothing is installed alongside the plugin.

## Development

```bash
npm install
npm run build        # esbuild → dist/host.js + lib/client.js
npm run typecheck    # tsc --noEmit (strict)
npm run vendor       # re-sync the vendored app/ from a local checkout of the upstream Taskboard app
```

`npm run vendor` mirror-syncs `server/`, `shared/`, `cli/`, `skills/`, `dist/web/`, `LICENSE`, and `PRIVACY.md` from a sibling checkout of the upstream app into `app/` (the source location is resolved inside `scripts/vendor-app.mjs`). After changing `src/`, rebuild and commit `dist/` + `lib/` — published installs must never need build scripts.

## Credits & Acknowledgements

The vendored app under `app/` is a fork of **[dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)** by [@chuspeeism](https://github.com/chuspeeism), renamed **Taskboard**. Heartfelt thanks to the original author for building such a polished board application and open-sourcing it — all credit for the board application's design and implementation belongs to the original author. 🙏

## License

Apache-2.0.
