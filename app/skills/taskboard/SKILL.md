---
name: taskboard
description: Manage Taskboard issues with taskctl. Use for issue IDs, status sync, comments, relations, or attachments on the local Taskboard—not for unrelated product docs. Also the quick-capture entry: when the user asks to add/note content onto the task board (将/把…添加到任务看板、记到看板上、加到任务板/看板), create a todo issue that lands in the 等待认领 column.
---

# Taskboard

Use `taskctl` for every project, issue, relation, and comment operation. Consume its JSON output. Use the exact issue identifier returned by the taskboard or supplied in the prompt. Never assume, derive, or rewrite an identifier prefix.

Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Quick capture (添加到任务看板)

When the user says 「将/把 <内容> 添加到任务看板」「记到看板上」「加到任务板/看板」 (add/note/put … onto the task board) and asks for no execution workflow, treat it as quick capture — the issue must land in the waiting-to-claim column, i.e. status `todo`:

1. Distill the content into a concise title, keeping the user's wording; do not expand scope or start work.
2. Avoid duplicates: check `taskctl issue list` in the target project for an existing open issue with the same meaning; if found, append the new context to its description instead of creating another.
3. Resolve the project with `context current` (falls back to `local`), then create:

   ```bash
   taskctl issue create --project PROJECT_ID --title TITLE --status todo --description CONTEXT --thread-id SESSION_ID --json
   ```

4. Reply with the returned identifier (e.g. `LOCAL-4`) and confirm it landed in 等待认领. Claiming and execution still follow the rules below.

## Core workflow

1. For an existing issue, first run `issue get` and `comment list`. Read the description and latest comments before deciding whether to start. Treat comments as current requirements, including returned work. If they say to wait, not execute, or not start now, stop and report without changing the status.
2. Treat `backlog` as not approved for execution. Unless the user explicitly authorizes that issue, do not claim it, move it to another status, or perform task work; its assignee alone is not authorization. If work may start, claim it before reading code, downloading attachments, analyzing the implementation, or doing any other task work. Move a claimable `todo` to `in_progress` with its current `version`; do not continue until the move succeeds. If it is already `in_progress`, continue only when it is bound to the current session. Never move an issue claimed by another session.
3. If the move conflicts because the `version` is stale, run `issue get` and `comment list` again. Retry once with the latest `version` only when the issue is still a claimable `todo`, is not bound to another session, is not archived, and its description and latest comments are unchanged. If it was claimed, its status or requirements changed, it is archived, the service is unavailable, a permanent API error occurs, or the retry fails, stop and report. Never loop or take over another agent's claim.
4. For a new durable requirement, run `context current` and search existing project issues before creating one. Update a matching issue instead of creating a duplicate. Do not track trivial requests.
5. Execute only the requested work in the issue's branch or worktree when one is bound.
6. Verify the requested operation path. Add a comment with the changes, verification result, outcome, and remaining risks. Read the issue again, then move it to `in_review` with its current `version`.
7. Move an issue to `done` only after the user explicitly accepts it or asks to complete it. Use `blocked` when work cannot continue and `canceled` when it will not continue.

## Other operations

- Preserve existing issue scope when adding requirements or acceptance details.
- Add only relations that the work requires. Use parent for contained work, blocks or blocked_by for dependencies, and related for close association.
- Attribute every write to the current DSH session: pass the exact session id with `--thread-id` (explicit option beats any environment variable).
- Use the latest returned `version` with `--if-version` for concurrent updates. On conflict, read the issue again and reconcile before retrying.
- Download and inspect an inline `![alt](api/attachments/<id>/content)` image only when it is needed to understand the requirement.
