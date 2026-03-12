# Codezilla Backlog

> Single source of truth for what's built, what's next, and what's planned.

**Stack:** Tauri v2 (Rust backend) + React (TypeScript) + xterm.js + portable-pty. macOS first.

**Architecture:** [plan/architecture.md](plan/architecture.md)
**v1 Implementation Plans:** [plan/](plan/)

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

### Icebox (deprioritised)

| # | Item | Notes |
|---|------|-------|
| — | Multi-pane terminals (iTerm2-style splits) | Multiple threads already cover this |
| — | Full-text search across files (Cmd+Shift+F) | AI threads handle this; revisit later |
| — | Move/reattach project: Codezilla-managed directory move that updates all internal paths (config, installations, scheduled jobs, transcript bindings). Also "reattach" for projects that were moved externally. | Moving a project directory today breaks Claude session logs, scheduled jobs, and skill installation records |
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

## Tech Debt: Activity Detection Architecture

An audit of the Claude thread activity detection system identified three structural issues worth investigating further. No action needed now — flagged for a future cleanup pass.

| # | Item | Notes |
|---|------|-------|
| TD-1 | **Three independent "is working" sources** — `ptyActive` (PTY layer), `isThreadLikelyWorking` (composite predicate), and `getThreadSubtitle`'s own working-override logic can each independently conclude "working" via different paths and don't always agree. Untangling these would reduce fragility but requires care to avoid reintroducing fixed edge cases. | Medium complexity |
| TD-2 | **`interruptHintUntil` timeout and `terminalTailHasActivityHint` tail scan are partially overlapping** — both exist to suppress false-idle Activity events when the star spinner is visible. The timeout is forward-looking (persists 12s after last sighting); the tail scan is real-time (checks current buffer). They cover different failure modes but together add complexity. Worth evaluating whether they can be unified. | Low-medium complexity |
| TD-3 | **`thinking)` false-positive risk** — the `/\bthinking\)/` pattern used to detect Claude's thinking spinner could match user code or program output containing the same string. Currently narrow enough to be low-risk, but worth tightening to require the full progress line context (e.g. require the timer pattern on the same line). | Low complexity |

---

## v0.3: Scheduled Jobs

Cron-backed recurring jobs per project. Create a job (Claude, Codex, or shell), pick a schedule, and Codezilla writes the crontab entry. Jobs run whether or not the app is open. Logs viewable in-app.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 0.3-1 | Data model + store: `ScheduledJob` type, store actions, persistence to `codezilla-config.json` | Pending | [spec](specs/scheduled-jobs.md) |
| 0.3-2 | Rust cron commands: `write_cron_entry`, `remove_cron_entry` (crontab manipulation), cron command wrapper with per-run log files and structured footer | Pending | [spec](specs/scheduled-jobs.md) |
| 0.3-3 | Rust log commands: `list_job_runs` (directory listing + footer parsing), `read_job_log` (file contents) | Pending | [spec](specs/scheduled-jobs.md) |
| 0.3-4 | Job creation UI: "Scheduled Job" option in `+` menu, type toggle buttons, command input, composable schedule picker | Pending | [spec](specs/scheduled-jobs.md) |
| 0.3-5 | Job list in left panel: jobs per project with clock icon, schedule summary, enable/disable + last-run-failed indicators | Pending | [spec](specs/scheduled-jobs.md) |
| 0.3-6 | Job detail panel: header with edit/run-now, run history list (timestamp, duration, pass/fail), log viewer with "Open File" | Pending | [spec](specs/scheduled-jobs.md) |
| 0.3-7 | Startup sync: reconcile config vs crontab on launch, prune old log files (keep last 50 per job) | Pending | [spec](specs/scheduled-jobs.md) |

---

## v3: Remote & AI

Remote access via iOS companion and MCP server. AI-powered session understanding and conversational control.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 3.1 | iOS companion app (WebSocket server, chat interface, terminal view, voice input) | Pending | [spec](specs/ios-companion.md) |
| 3.2 | MCP server (HTTP/SSE tools, stream interpretation layer, semantic state, cross-session orchestration) | Pending | [spec](specs/mcp-server.md) |
| 3.3 | Git operations panel (stage, commit, push without typing) | Pending | — |
| 3.4 | Task completion notifications (push notifications on iOS) | Pending | — |
| 3.5 | Bookmarked files per project | Pending | — |

---

## v3.5: Git Worktree Workflows

First-class support for running parallel Claude Code sessions in isolated git worktrees. Leverages Claude Code's native `--worktree` flag; Codezilla provides UI structure, lifecycle management, and auto-detection of worktrees created from within its terminals.

**Spec:** [specs/git-worktrees.md](specs/git-worktrees.md) · **Reference:** [agent-view comparison](agent-view-comparison.md)

| # | Item | Status | Ref |
|---|------|--------|-----|
| 3.5-1 | Data model + left panel grouping: `worktreeName` on Thread, worktree sections in sidebar | Pending | [spec](specs/git-worktrees.md) |
| 3.5-2 | Worktree creation flow: `[+ New Worktree]` button, spawn with `-w` + `--session-id` | Pending | [spec](specs/git-worktrees.md) |
| 3.5-3 | Spawn logic: include `-w` flag in launch/resume commands for worktree threads | Pending | [spec](specs/git-worktrees.md) |
| 3.5-4 | fs-watcher auto-detection: watch `.claude/worktrees/` for directory creation/removal | Pending | [spec](specs/git-worktrees.md) |
| 3.5-5 | Process inspection + thread association: Rust command to walk PTY child processes, match `--worktree` args, auto-assign `worktreeName` | Pending | [spec](specs/git-worktrees.md) |
| 3.5-6 | Worktree-scoped file tree: re-root file tree based on active thread's worktree | Pending | [spec](specs/git-worktrees.md) |
| 3.5-7 | Section header metadata: branch name, commits ahead, dirty indicator | Pending | [spec](specs/git-worktrees.md) |
| 3.5-8 | Actions menu: push branch, discard worktree (merge actions deferred) | Pending | [spec](specs/git-worktrees.md) |

---

## v3.6: Credential Management

Encrypted local credential store with automatic session injection. Solves scattered API keys, MCP config hardcoding, and new machine restore pain for individual developers.

**Spec:** [specs/credential-management.md](specs/credential-management.md)

| # | Item | Status | Ref |
|---|------|--------|-----|
| 3.6-1 | Encrypted credentials file: JSON encrypted with AES-256-GCM + Argon2, user-defined file location (iCloud/Dropbox/etc.), master password stored in OS Keychain | Pending | [spec](specs/credential-management.md) |
| 3.6-2 | First launch flow: choose file location, create master password, store in Keychain | Pending | [spec](specs/credential-management.md) |
| 3.6-3 | Session injection: at PTY spawn, silently decrypt and inject global + project-scoped credentials into session environment | Pending | [spec](specs/credential-management.md) |
| 3.6-4 | Credentials UI panel: add/edit/delete global and project-scoped credentials | Pending | [spec](specs/credential-management.md) |
| 3.6-5 | New machine restore: point at existing file, enter master password once, Keychain populated | Pending | [spec](specs/credential-management.md) |
| 3.6-6 | MCP install integration: check credential store when installing MCP servers, prompt for missing keys, write configs with `${VAR}` references only | Pending | [spec](specs/credential-management.md) |

---

## v4: Project Intelligence Panel

A unified panel surfacing everything relevant to the active project — backlog, specs, vision docs, config. Backed by the `backlog-manager` CLI tool (`~/Local_Projects/backlog-manager-2`), consumed as a Rust library.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 4.1 | `backlog-manager` library integration — link Rust crate, read active project's SQLite db | Pending | — |
| 4.2 | Backlog tab — items grouped by status, inline status updates, priority display | Pending | — |
| 4.3 | Specs tab — browse `docs/specs/*.md` files for active project, rendered markdown, click to open in Quick Look | Pending | — |
| 4.4 | Vision docs tab — strategy/roadmap docs stored via `backlog-manager vision` | Pending | — |
| 4.5 | CLAUDE.md viewer — project instructions always one click away | Pending | — |
| 4.6 | Status bar chip — compact `↑2 ready · 1 in progress` count in project header | Pending | — |
| 4.7 | Skills & Plugins Manager: detect, install, and manage skills/agents/commands/plugins from git repos. Personal registry with update tracking, project and global install targets, plugin decomposition. | Pending | [spec](specs/skills-plugins-manager.md) |
| 4.8 | Optional sync to hosted backend (team/cross-device access via `backlog-manager` web app) | Pending | — |

---

## v5: Cross-Platform

Windows and Linux support. Separate stream to avoid blocking macOS feature work.

| # | Item | Status | Ref |
|---|------|--------|-----|
| 5.1 | Windows support (PTY, menus, paths, installer) | Pending | — |
| 5.2 | Linux support (PTY, menus, paths, .deb/.AppImage) | Pending | — |
| 5.3 | Windows code signing | Pending | — |

---

