## v0.5.0 — Haven Backlog View

Codezilla can show a project's Haven backlog in the app.

**New**

- **Backlog view** — linked projects get a Backlog row in the sidebar. It opens four tabs: In flight, Blocked, Backlog (by epic), Done.
- **Updates live** — changes made from any terminal appear within a second.
- **Dependency links** — click through what an item waits on and what it unblocks, with a back trail.
- **Search and hover** — search filters the current tab; hover highlights an item's epic.
- **Link a repo from the project page** — repos linked with `haven link` are detected. Unlinked repos show a Link to Haven button.
- **Read-only** — the view shows what Haven holds. No edits yet.

**Fixes**

- Codex usage now loads when Codezilla is started from the Dock.
- Skills & Plugins Manager removed.

## v0.4.9 — Heed and Usage Follow-Ups

Small fixes from the 0.4.8 review, shipped together.

- **Cleaner Heed updates** — leftover staging folders from an interrupted Heed update are tidied on the next launch, and a failed Heed install now says which binary it tried and why.
- **Lighter Codex usage checks** — refreshing Codex usage no longer starts a second helper process each time.
- **Old usage cache removed** — the cache file left behind by earlier versions is cleaned up automatically.

## v0.4.8 — Heed Installs as a Login Item

Heed, the background activity tracker Codezilla relies on, is now installed as a proper macOS app, and the usage charts are more dependable.

- **Heed appears as "Heed" in Login Items** — the background activity tracker now shows up under its own name and icon in System Settings › General › Login Items & Extensions. Existing installs are migrated automatically the first time Codezilla launches; macOS may show a one-time "Heed can run in the background" notice.
- **Requires macOS 13 Ventura or later** — the new background-service mechanism is not available on older versions of macOS.
- **Reliable usage charts** — Claude and Codex usage refreshes on a schedule based on how busy your terminals are, keeps the last good reading when a refresh fails (and tells you), and Codex figures no longer go stale between turns.

## v0.4.7 — Temp and Haven File Links

Files created by an AI outside the repository can now be opened directly from terminal output.

- **Temp files open normally** — links to files in `/tmp` and the per-user macOS temp directory now support Preview, Open, Reveal in Finder, and Cmd/Ctrl-click Quick Look without needing to be indexed in the project.
- **Haven attachments are clickable** — files stored under `~/.haven` get the same terminal-link actions, including in-app previews for text, Markdown, and images.
- **External output stays read-only in Codezilla** — temp files and Haven artifacts do not gain repository editing or Git-diff controls, and paths outside the approved locations remain blocked.

## v0.4.6 — Activity Tracking Follows Background Sessions

Threads that moved into a background session kept showing as idle while they were still working. This release fixes that, and stops those sessions going missing when a thread is resumed.

- **Threads no longer sit on "Idle" while they're working** — when Claude moves a session into the background, or restarts it in place, it continues the conversation under a new session behind the scenes. Codezilla kept watching the old one, so a thread that was actively working showed as idle indefinitely. It now follows the session that is actually running.
- **Resuming a moved thread reopens the right conversation** — a thread whose session had moved would reopen the older, pre-move transcript, leaving hours of recent work unreachable. Resuming now returns to the conversation you were last looking at.

## v0.4.5 — Clipboard Fix

Copying stopped working entirely on the latest macOS. This release fixes it.

- **Copying works again** — after updating to macOS 26.6, "Copy as prose", "Copy Path", "Copy Session ID" and "Copy Resume Command" all silently stopped putting anything on the clipboard. All of them work again, and are no longer affected by macOS updates.
- **"Copy as prose" no longer claims false success** — the button used to flash "Copied!" even when nothing had been copied. It now shows when a copy has failed.

## v0.4.4 — File Tracking and Worktree Label Fixes

- **Builds no longer thrash file tracking** — compiling a project (a Rust build, a big JS build) used to flood the file watcher with thousands of build-output changes, triggering repeated full rescans for the length of the build. Build directories are now ignored consistently, so Codezilla stays quiet and responsive while builds run.
- **Agent worktrees get stable names** — Claude and Codex worktrees without a branch now show a meaningful, stable identity in the sidebar (source, folder, and commit) instead of a bare directory name, with the full path and state shown on hover.

## v0.4.3 — Live Worktree Stats and Raw Markdown Editing

Worktree change counts now update live wherever the work happens, the usage chart stays fresh without tripping rate limits, and Markdown editing switches to a raw-source editor with a cleaner rendered view.

**New Features**

- **Raw Markdown editing** — the Markdown editor is now a syntax-highlighted source editor that follows the app's light/dark appearance, with a pinned Rendered / Markdown / Diff switcher and lossless movement between views. Front matter renders as a tidy metadata card, and every Markdown file type is editable, not just `.md`.
- **Insert into terminal** — right-click any file and insert its path straight into the active thread's terminal.

**Fixes**

- **Worktree change counts update live everywhere** — every worktree's +/− now refreshes the moment files change, whichever environment is selected, including Codex and manually created worktrees. An agent's edits show up within a second, new worktrees appear as soon as they're used, and counts no longer freeze on a stale mid-burst value.
- **Snappier, lighter git refreshes** — file changes in one worktree no longer trigger git work for all the others, and heavy agent sessions cause far less background churn.
- **Usage chart stays fresh without hitting rate limits** — the chart refreshes right after a Claude turn finishes, slows right down when you're idle, respects the endpoint's back-off instructions, and running two copies of the app no longer doubles the traffic. When the numbers are genuinely behind, the row now says "as of Xm" instead of pretending to be current.
- **File search finds ignored files** — real-but-gitignored files (a local `.env`, a raw image, a locally excluded folder) now appear in search results.
- **Codex gauges show the right limit windows** — the 5-hour and weekly gauges now identify Codex's limit windows by their actual length, fixing a "5h resets in 5d" mix-up after OpenAI reshuffled how limits are reported. Codex usage also now admits its age when Codex hasn't run for a while, instead of posing as current.

## v0.4.2 — Markdown Editing and File Tree Fixes

This point release adds in-app Markdown editing and tightens a few rough edges around previews, terminal links, usage display, and local-only folders in the file tree.

**New Features**

- **Rich Markdown editing** — Markdown files can now be edited in Codezilla's preview panel with a Milkdown-powered editor.

**Fixes**

- **Markdown previews load local assets more reliably** — relative images and local references in Markdown previews resolve through Codezilla's asset handling instead of breaking or leaking file paths.
- **Ignored local folders stay visible in All files** — the All file tree now shows local workspace projections such as Haven's `Haven/` folder even when they are listed in `.git/info/exclude`, while still hiding `.git` and OS junk files.
- **More terminal paths are clickable** — file links now work for newly-created files and files hidden from Git by ignore rules.
- **Interrupted threads settle correctly** — stopping a running command with Ctrl+C no longer leaves the thread spinning as if it were still working.
- **Usage sidebar is quieter** — the 5-hour reset countdown text is removed from the compact usage row.
- **External links route through the shared opener** — links from terminals and the skills/plugins UI now use the same external-link path.

## v0.4.1 — Worktree Fixes

A follow-up to worktree support: thread-to-worktree tracking now works across projects, uncommitted-change counts stay steady, plus fixes to previews, terminal links, and Codex sessions.

**Fixes**

- **Threads follow their work across projects** — selecting a thread now jumps the panel to the worktree it last edited even when you're switching in from a different project, and the thread's uncommitted-work dot shows correctly. Previously it stayed on the main checkout.
- **Steadier change counts** — a worktree's uncommitted +/− counts no longer blank out for stretches while a thread is doing git-heavy work (such as creating a worktree); they hold their last value instead.
- **Selectable previews** — rendered Markdown and diff text in the file preview can now be selected and copied.
- **Smarter clickable paths** — terminal output recognises more file paths as clickable links, including partial paths and ones prefixed by a status letter or word (e.g. "M src/app.ts", "Reading src/…").
- **Resume Codex sessions after restart** — Codex threads can be resumed after restarting Codezilla; their usage figures also note when the numbers may be a turn behind.
- **Cleaner copy as prose** — copying as prose strips more quote-bar variants from the left edge of quoted text.

## v0.4.0 — Worktree Support

Codezilla now understands git worktrees. Switch between a project's worktrees, see what's changed in each, and tell at a glance which threads have uncommitted work — and where it lives.

**New Features**

- **Worktree environment selector** — the right panel now has a Worktrees section listing the main checkout and every worktree, each with its uncommitted-change count. Selecting one re-roots the whole panel — file tree, git status, and file/diff/commit previews — to that worktree.
- **Uncommitted-work indicators** — sidebar threads now show a dot when they have uncommitted changes, attributed to the worktree (or main checkout) where the edits actually happened. They persist across restarts and show even on threads you haven't touched in a while.
- **Threads follow their work** — selecting a thread jumps the panel to the worktree it most recently edited, and an active thread's live edits keep the panel tracking along as it moves between worktrees.
- **Per-agent usage charts** — a new Usage Charts submenu in the View menu shows or hides the Claude and Codex usage charts independently. Hiding one stops polling it entirely; re-enabling reuses a recent snapshot or refetches.
- **Usage pace marker** — the 5-hour and weekly usage gauges now show a tick marking how far through each window you are, so usage reads against the clock.

**Fixes**

- Threads no longer get stuck showing "Working" forever after their session has ended — a thread whose process is gone now correctly reads as idle.
- Copy as prose no longer carries the vertical bar down the left edge of quoted text, so pasted blockquotes come through clean.

## v0.3.3 — Plan Usage Tracking

Keep an eye on your subscription limits without leaving Codezilla. A new Usage panel in the sidebar shows, at a glance, how close you are to your Claude and Codex plan limits.

**New Features**

- **Usage panel** — a new "Usage" section above your projects tracks your 5-hour and weekly plan usage for both Claude and Codex, with a countdown to when each window resets. Click a row for the full detail — both windows, your plan tier, and tokens used today. It updates on its own, and only shows the agents you actually have a subscription for.

## v0.3.2 — Further Performance Improvements

Further performance improvements: Codezilla now stays smooth even when a project's git repository is slow or unhealthy, recovers from rendering glitches on its own, and tells you when a repo needs attention.

**New Features**

- **Slow-repo warning** — if git in a project is repeatedly slow, Codezilla diagnoses why and shows a banner naming the build or dependency folders that shouldn't be under version control, with a one-click copy of the fix commands.

**Fixes**

- Working in a project with a slow git repository no longer makes the whole app stutter or freeze mid-scroll.
- Terminals now recover from rendering glitches on their own — blank or garbled characters and suddenly-sluggish scrolling fix themselves instead of persisting until a restart.
- Changes in build folders no longer trigger unnecessary background refreshes.

## v0.3.1 — Snappier Activity Tracking

A fast follow-up to v0.3.0: the new activity tracking is now light on its feet, so the app stays responsive no matter how many threads you're running.

**Fixes**

- Fixed the app becoming sluggish when several threads were open or actively working — stuttering activity spinners, laggy scrolling, and pauses when switching threads. Responsiveness no longer degrades as you add more threads, and switching between them is instant again.

## v0.3.0 — Smarter Activity Tracking

Activity tracking has been completely rebuilt — Codezilla now understands what each thread is doing far more accurately and reliably, and shows it at a glance, across both Claude and Codex.

**New Features**

- **Live activity detail** — each thread shows what it's doing right now: the current tool and the file or command it's working on (e.g. "Editing Terminal.tsx", "Running tests"), updated as it happens.
- **Reliable working / waiting / idle status** — Codezilla now tells the difference between a thread that's working, one that's waiting for you (a question or a permission prompt), and one that's finished — including threads in background tabs. No more spinners stuck on "Working", and no more missing when a thread needs your input.
- **Plan mode & task progress** — when a thread is planning or working through a task list, the sidebar reflects it, including how far along it is.

**Fixes**

- Fixed the terminal occasionally jumping while scrolling back through output.
- Status badges no longer appear on the thread you're already viewing — only on background threads that need attention.

## v0.2.2

- **Launch preset fixes** — Preset icons now use the same icon picker as projects, placeholder text adapts to the selected type, and Terminal presets can specify a command to run

## v0.2.1

- **File panel view modes** — Switch between All, Recent, and Changes views in the right panel to focus on the files that matter
- **Copy as prose** — A new button appears when you select terminal text, copying it as clean continuous prose with hard line wraps removed
- **Beta features toggle** — Codex threads, skills & plugins, and scheduled jobs are now behind opt-in flags in settings (off by default for new installs)
- Fixed idle threads incorrectly showing as active after timestamp resets
- Increased terminal scrollback buffer from 5,000 to 10,000 lines
- Clicking "↓ Latest" now focuses the terminal so you can start typing immediately
