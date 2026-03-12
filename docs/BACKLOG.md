# Codezilla Backlog

> Single source of truth for what's built, what's next, and what's planned.

**Stack:** Tauri v2 (Rust backend) + React (TypeScript) + xterm.js + portable-pty. macOS first.

**Architecture:** [plan/architecture.md](plan/architecture.md)
**v1 Implementation Plans:** [plan/](plan/)
**Competitive Analysis:** [competitive-analysis.md](competitive-analysis.md)

---

## v1: Desktop App (Core)

The foundation. A terminal-first app where directories are first-class citizens, with file browsing and git status.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 1.1 | Spike: Tauri + xterm.js + portable-pty validation | **Done** | [phase-0](plan/phase-0-spike.md) |
| 1.2 | Scaffold: 3-panel layout + single terminal | **Done** | [phase-1](plan/phase-1-scaffold.md) |
| 1.3 | Projects + threads: multi-project, multi-thread, Claude/Codex/Shell types | **Done** | [phase-2](plan/phase-2-projects-threads.md) |
| 1.4 | File tree: directory browser, expand/collapse, fuzzy filter | **Done** | [phase-3](plan/phase-3-file-tree.md) |
| 1.5 | Git decorations + status bar | **Done** | [phase-4](plan/phase-4-git.md) |
| 1.6 | Quick Look: space-to-preview with floating overlay | **Done** | [phase-5](plan/phase-5-quick-look.md) |
| 1.7 | Persistence: project list, tree state, window position | **Done** | [phase-6](plan/phase-6-polish.md) |
| 1.8 | Polish: keyboard shortcuts, empty states, edge cases | **Done** | [phase-6](plan/phase-6-polish.md) |
| 1.9 | Clickable file paths + diff view in Quick Look | **Done** | [spec](specs/clickable-file-paths.md) |
| 1.10 | Unified text size: Cmd+/- to scale all panels, persist preference | **Done** | — |
| 1.11 | UI polish: folder icon before project names, maintain scroll position on fullscreen, improve new project button styling, window position persistence, show +/- diff totals in file preview header, white activity ellipsis for visibility | **Done** | [spec](specs/ui-polish.md) |

---

## v2: Session Intelligence

Session persistence, process lifecycle management, transcript awareness. Codezilla understands what's happening in its terminals, not just that they exist.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 2.1 | Session persistence & resume (threads, Claude/Codex/shell resume, exit handling, close protection) | **Done** | [spec](specs/session-persistence.md) |
| 2.2 | Transcript-powered UI (JSONL tailing → approval badges, thread status, cost/context indicators, activity subtitles, error badges, plan progress, completion notifications) | **Done** | [spec](specs/transcript-watching.md) |
| 2.3 | Reveal in Finder (button on Quick Look and file tree context menu) | **Done** | — |
| 2.4 | Richer file preview (images, markdown rendering, PDF) | **Done** | — |
| 2.5 | Drag & drop (reorder projects/threads, drag file to terminal for path) | **Done** | — |
| 2.6 | Themes & appearance (dark/light/system, 7 accent colors, text size menu, remember window position) | **Done** | — |
| 2.10 | Deterministic Codex transcript binding (backend binder, atomic claim, phased rollout replacing newest-file heuristic) | **Done** | [spec](specs/codex-deterministic-binding.md) |

---

## v0.1.1: QoL + Polish

Small release to test the auto-updater pipeline and ship quick wins.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 0.1.1-1 | Show current branch name next to git info in status bar | **Done** | — |
| 0.1.1-2 | Reveal in Finder (button on Quick Look and file tree context menu) | **Done** | — |
| 0.1.1-3 | Disable default webview context menu on sidebars | **Done** | — |
| 0.1.1-4 | Theme pop: accent-coloured outline + text on Add Project button, accent-coloured + buttons on each project | **Done** | — |

---

## v0.2: Session Intelligence II + Release Hardening

Smarter session awareness, improved thread lifecycle, and ship-readiness.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 0.2-1 | Fix "time since update" logic: measure from last PTY input, not thread selection — clicking a thread should not reset the idle timer | **Done** | — |
| 0.2-2 | Remove activity indicators from terminal (shell) threads — activity tracking only makes sense for AI threads (Claude/Codex) | **Done** | — |
| 0.2-3 | Release prep: squash commit history, review tracked files (exclude internal docs/testing artifacts), clean first push to GitHub | **Done** | — |
| 0.2-4 | macOS code signing & notarisation (Apple Developer ID) | Waiting on Apple | — |
| 0.2-5 | Auto-updater via `tauri-plugin-updater` (check GitHub Releases for new versions) | **Done** | — |
| 0.2-7 | Open in default app: "Open" action on file tree context menu (uses macOS `open`) | **Done** | — |
| 0.2-8 | Link detection: detect URLs in terminal output and open them in the default browser on click | **Done** | — |

---

## v0.3: Scheduled Jobs

launchd-backed recurring jobs per project. Create a job (Claude, Codex, or shell), pick a schedule, and Codezilla writes a launchd agent. Jobs run whether or not the app is open. Logs viewable in-app.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 0.3-1 | Data model + store: `ScheduledJob` type, store actions, persistence to `codezilla-config.json` | **Done** | [spec](specs/scheduled-jobs.md) |
| 0.3-2 | Rust launchd commands: `write_launchd_entry`, `remove_launchd_entry`, command wrapper with per-run log files and structured footer | **Done** | [spec](specs/scheduled-jobs.md) |
| 0.3-3 | Rust log commands: `list_job_runs` (directory listing + footer parsing), `read_job_log` (file contents), `reveal_log_in_finder`, `delete_job_logs`, `prune_job_logs` | **Done** | [spec](specs/scheduled-jobs.md) |
| 0.3-4 | Job creation UI: "Scheduled Job" option in `+` menu, type toggle buttons, command input, composable schedule picker (interval / daily / weekly) | **Done** | [spec](specs/scheduled-jobs.md) |
| 0.3-5 | Job list in left panel: jobs per project with clock icon, schedule summary, enable/disable + last-run-failed + running indicators | **Done** | [spec](specs/scheduled-jobs.md) |
| 0.3-6 | Job detail panel: header with edit/run-now/enable-disable/delete, run history list (timestamp, duration, pass/fail), expandable log viewer with "Open File" | **Done** | [spec](specs/scheduled-jobs.md) |
| 0.3-7 | Run Now: execute job immediately outside schedule, with background thread + log capture | **Done** | [spec](specs/scheduled-jobs.md) |

---

## v0.4: Worktrees + Awareness

The "parallel agent cockpit" release. Git worktree support makes Codezilla competitive with orchestrators (Superset, Agent Deck, CCManager all have this). Notifications and cost tracking complete the cockpit — you know what your agents are doing, what they need, and what they're costing you.

**Competitive context:** 8 verified competitors have worktrees. 5 have notifications. 5 have cost tracking. See [competitive-analysis.md](competitive-analysis.md).

| # | Item | Status | Ref |
|---|------|--------|-----|
| 0.4-1 | Data model + left panel grouping: `worktreeName` on Thread, worktree sections in sidebar | Pending | [spec](specs/git-worktrees.md) |
| 0.4-2 | Worktree creation flow: `[+ New Worktree]` button, spawn with `-w` + `--session-id` | Pending | [spec](specs/git-worktrees.md) |
| 0.4-3 | Spawn logic: include `-w` flag in launch/resume commands for worktree threads | Pending | [spec](specs/git-worktrees.md) |
| 0.4-4 | fs-watcher auto-detection: watch `.claude/worktrees/` for directory creation/removal | Pending | [spec](specs/git-worktrees.md) |
| 0.4-5 | Process inspection + thread association: Rust command to walk PTY child processes, match `--worktree` args, auto-assign `worktreeName` | Pending | [spec](specs/git-worktrees.md) |
| 0.4-6 | Worktree-scoped file tree: re-root file tree based on active thread's worktree | Pending | [spec](specs/git-worktrees.md) |
| 0.4-7 | Section header metadata: branch name, commits ahead, dirty indicator | Pending | [spec](specs/git-worktrees.md) |
| 0.4-8 | Actions menu: push branch, discard worktree (merge actions deferred) | Pending | [spec](specs/git-worktrees.md) |
| 0.4-9 | macOS notifications on thread state change: fire `NSUserNotification` when a thread transitions to `waiting_for_approval`, `error`, or `done`. Configurable per-project (on/off). Sound optional. | Pending | — |
| 0.4-10 | Cost/token accumulation in transcript parser: extend `TranscriptInfo` with `totalCostUsd`, `totalInputTokens`, `totalOutputTokens` — extracted from `result` events the parser already handles | Pending | — |
| 0.4-11 | Cost display: show per-thread cost in thread subtitle (e.g. "$0.42 · 12k tokens"), aggregate in status bar (e.g. "$2.80 today") | Pending | — |

---

## v0.5: MCP + Visibility

MCP server for testing and programmatic access. Usability improvements. Broader agent support.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 0.5-1 | MCP server (read-only): expose Codezilla state as MCP tools — `list_projects`, `list_threads`, `get_thread_status`, `get_transcript_info`, `get_cost_data`. Enables AI-driven e2e testing of transcript intelligence and status management. HTTP/SSE transport, runs on localhost | Pending | — |
| 0.5-2 | MCP-driven e2e test suite: use MCP server to programmatically verify status transitions (working → idle → done), badge accuracy, false-positive detection. Addresses flaky status management (TD-1, TD-2, TD-3) by making the status model testable | Pending | — |
| 0.5-3 | Open in Editor: "Open in [configured editor]" button on file tree context menu and Quick Look header. User configures editor in preferences. Implementation: `open -a "<editor>" <path>` | Pending | — |
| 0.5-4 | Full-text search across session transcripts: index JSONL transcript data, search by content across all sessions. Find "which session was working on the auth bug?" | Pending | — |
| 0.5-5 | Gemini CLI as 4th thread type: launch `gemini` CLI in PTY, basic session management. Transcript parsing adapter deferred — status detection via PTY activity initially. Skills & Plugins Manager labelled "Claude Code Skills & Plugins" in UI — Gemini threads get session management but no skills integration initially | Pending | — |
| 0.5-6 | CLAUDE.md viewer: project instructions always one click away, rendered markdown | Pending | — |
| 0.5-7 | Skills & Plugins Manager (v2): MCP server install (different config format + env var handling), enable/disable toggle for plugins, cascade removal on scope move (P→G should offer to remove redundant project installs), browse/search public catalog | Pending | [spec](specs/skills-plugins-manager.md) |

---

## v0.6: Polish + QoL

| # | Item | Status | Ref |
|---|------|--------|-----|
| 0.6-1 | MCP server (write tools): extend MCP server with `create_thread`, `write_to_terminal`, `select_project` tools. Enables AI agents to orchestrate Codezilla programmatically. Gated behind explicit user opt-in | Pending | — |
| 0.6-2 | Pinned thread pane: pin one thread visible in a small pane while working in another — lightweight alternative to full terminal splits. Addresses "glance at agent progress" need without grid complexity | Pending | — |
| 0.6-3 | Notification customisation: optional Pushover or ntfy.sh integration for mobile notifications (know when agents need you while away from desk). Replaces iOS companion app scope | Pending | — |
| 0.6-4 | Gemini CLI transcript adapter: parse Gemini session data for semantic status badges (extends 0.5-5 from PTY-only to full transcript intelligence) | Pending | — |
| 0.6-5 | Multi-agent skills investigation: research and design how skills/instructions work across agent types. Potential approaches: (a) alias/symlink CLAUDE.md → AGENTS.md / codex-instructions.md so project instructions propagate to all agents automatically, (b) abstract skill installation to detect agent type and install to the right location per agent, (c) accept separate management per agent for plugins (Claude plugins are Claude-only) but unify skills (markdown instruction files). Scope TBC — may result in a spec or may conclude current Claude-first approach is correct | Pending | — |

---

## Tech Debt: Activity Detection Architecture

An audit of the Claude thread activity detection system identified three structural issues worth investigating further. No action needed now — flagged for a future cleanup pass.

| # | Item | Notes |
|---|------|-------|
| TD-1 | **Three independent "is working" sources** — `ptyActive` (PTY layer), `isThreadLikelyWorking` (composite predicate), and `getThreadSubtitle`'s own working-override logic can each independently conclude "working" via different paths and don't always agree. Untangling these would reduce fragility but requires care to avoid reintroducing fixed edge cases. | Medium complexity |
| TD-2 | **`interruptHintUntil` timeout and `terminalTailHasActivityHint` tail scan are partially overlapping** — both exist to suppress false-idle Activity events when the star spinner is visible. The timeout is forward-looking (persists 12s after last sighting); the tail scan is real-time (checks current buffer). They cover different failure modes but together add complexity. Worth evaluating whether they can be unified. | Low-medium complexity |
| TD-3 | **`thinking)` false-positive risk** — the `/\bthinking\)/` pattern used to detect Claude's thinking spinner could match user code or program output containing the same string. Currently narrow enough to be low-risk, but worth tightening to require the full progress line context (e.g. require the timer pattern on the same line). | Low complexity |

---

## Cross-Platform

Windows and Linux support. Separate stream to avoid blocking macOS feature work.

| # | Item | Status | Ref |
|---|------|--------|-----|
| CP-1 | Windows support (PTY, menus, paths, installer) | Pending | — |
| CP-2 | Linux support (PTY, menus, paths, .deb/.AppImage) | Pending | — |
| CP-3 | Windows code signing | Pending | — |

---

## Icebox

Deprioritised or deferred items. Revisit based on user demand.

| # | Item | Notes |
|---|------|-------|
| — | iOS companion app (WebSocket server, chat interface, terminal view, voice input) | Replaced by Pushover/ntfy.sh integration (0.6-2). Mobile notifications solved without building a separate app. KanbanCode uses Pushover, Agent Deck uses Telegram/Slack bots — days of work, not months. Revisit only if users demand a full mobile terminal view. |
| — | MCP server — full orchestration scope (cross-session coordination, semantic state aggregation) | The orchestration use case is deferred — AI agents handle their own coordination. Read-only MCP (0.5-1) and write MCP (0.6-1) cover the practical use cases: testing, programmatic access, and e2e verification |
| — | Git operations panel (stage, commit, push without typing) | Nice-to-have but not differentiated — users can do this from the terminal |
| — | Bookmarked files per project | Low demand signal |
| — | Credential management (encrypted store, session injection, Keychain) | Most competitors don't bother — users manage their own keys. Revisit when MCP install integration becomes a real blocker |
| — | `backlog-manager` library integration (backlog tab, specs tab, vision docs, status bar chip) | Couples Codezilla to a separate project most users won't have installed. CLAUDE.md viewer (0.5-4) covers the universal use case |
| — | Hosted backend sync (team/cross-device access) | Premature — need user base first |
| — | Multi-pane terminals (iTerm2-style splits) | Pinned thread pane (0.6-1) addresses 80% of the need. Full splits add complexity without matching Codezilla's cockpit philosophy |
| — | Full-text search across files (Cmd+Shift+F) | AI threads handle this; revisit later |
| — | Move/reattach project | Moving a project directory today breaks Claude session logs, scheduled jobs, and skill installation records. Real pain point but complex fix — revisit when users report it |
| — | Conversation forking (branch a session to try different approach) | Agent Deck, KanbanCode have this. Evaluate demand after worktrees ship — worktrees may reduce the need since each worktree is effectively a fork |
| — | Docker sandboxing | Codezilla is a cockpit, not an orchestrator — let users choose their own sandboxing |
| — | Conductor/supervisor mode (AI monitoring other AI sessions) | Agent Deck has this. Clever but fragile and token-expensive. Let Claude Code's native subagents handle it |
| — | Code review system | ChatML has 3-tier review. But code review is the editor's job (Cursor, VS Code) |

---
