# Privacy

Taskboard is a local-first application. The service runs on your own computer
and does not send Taskboard content or usage telemetry to the project
maintainers.

## Data stored on the computer

Taskboard stores its SQLite database, attachments, and connection config under
the configured data directory (`TASKBOARD_DATA_DIR`, default `.data/` inside
the project). The taskboard skill, when installed, lives under the current
user's `.agents/skills/taskboard` directory.

## Network activity

- The service binds to `127.0.0.1` by default and serves the web UI, the DSH
  panel, and `taskctl` on the same computer. LAN sharing requires the explicit
  `TASKBOARD_HOST=0.0.0.0` opt-in.
- Optional Jira integration, when configured by the user, contacts the
  user-specified Jira server.
- Project summaries and skill/MCP discovery spawn the locally installed agent
  CLI, which uses that CLI's own account and terms.
- Some workflow catalog icons can be loaded from their published websites.

Taskboard does not include advertising or a project-maintainer analytics
service.

## Removing data

Delete the data directory to remove all board content, attachments, and local
config. Uninstalling removes the program; the installed skill under
`.agents/skills/taskboard` can be deleted manually.
