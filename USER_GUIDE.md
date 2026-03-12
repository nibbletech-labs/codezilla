# Codezilla User Guide

Codezilla is a desktop app for managing AI coding sessions alongside your project files. It gives you terminals for Claude Code, Codex, and plain shell — all in one window with an integrated file browser, Quick Look preview, scheduled jobs, and a skills & plugins manager.

---

## Layout

The app has three panels, a title bar, and a status bar:

```
+----------+---------------------+----------+
| Projects |      Terminal       |  Files   |
| & Threads|                     | & Tools  |
|          |                     |          |
|          |                     |          |
+----------+---------------------+----------+
|              Status Bar                    |
+--------------------------------------------+
```

- **Title bar** — app title and current git branch name (top-right)
- **Left panel** — your projects, threads, and scheduled jobs
- **Centre panel** — the active terminal session, job detail, or project view
- **Right panel** — file tree with git status, plus a skills & plugins strip
- **Status bar** — git diff summary and app version (bottom-left)

The right panel edge can be dragged to resize (150px–600px).

---

## Projects

Click the **+** button in the left panel header to add a project folder. Each project stores its own set of threads and scheduled jobs.

| Action | How |
|--------|-----|
| Add project | Click **+**, pick a folder |
| Switch project | Click its name |
| Remove project | Hover, click **x** |

If a project folder is moved or deleted, a warning icon appears and the name fades out.

---

## Threads

A thread is a terminal session tied to a project. There are three types:

| Type | What it runs |
|------|-------------|
| **Claude Code** | `claude` CLI with session persistence |
| **Codex** | `codex` CLI with resume support |
| **Terminal** | Interactive shell |

### Creating a thread

With a project selected, click the **+** button next to the project name and pick a thread type: Claude Code, Codex, or Terminal.

Or use the buttons that appear in the centre panel when no thread is active.

### Thread states

| State | Meaning |
|-------|---------|
| Running | Active process, terminal is live |
| Saved | Session persisted, no active process — click to resume |
| Exited | Process ended — click to restart or resume |

An animated ellipsis appears next to threads that are actively producing output.

### Managing threads

| Action | How |
|--------|-----|
| Switch thread | Click it in the left panel |
| Rename | Double-click the name, type, press Enter |
| Close | Hover, click **x** (running threads require a second click to confirm) |

### Session persistence

When you quit and reopen Codezilla, all your projects and threads are restored. Claude Code sessions resume with the same session ID, so conversation context is preserved. Codex threads resume via their thread ID.

---

## Terminal

Each thread runs in a full terminal emulator (xterm.js) with:

- 5,000-line scrollback
- ANSI colour and style support
- GPU-accelerated rendering
- Auto-resize when the panel changes size

Multiple terminals run in parallel — switching threads is instant.

### Clickable file paths

File paths in terminal output are detected automatically and become **Cmd+clickable** links. This works with paths from git diffs, compiler errors, Claude Code edits, linter output, and stack traces.

**Supported formats:**

| Format | Example |
|--------|---------|
| Relative path | `src/components/App.tsx` |
| Dotted path | `./utils/auth.ts` |
| With line number | `src/App.tsx:42` |
| With line and column | `src/App.tsx:42:10` |
| Git diff prefix | `a/src/App.tsx`, `b/src/App.tsx` |
| Quoted | `"src/App.tsx"`, `'src/App.tsx'` |

**How it works:**

1. Hover a file path — it underlines and the cursor changes to a pointer
2. **Cmd+click** (macOS) the path
3. The file highlights in the file tree (ancestors auto-expand)
4. Quick Look opens with the file content
5. If the path included `:42`, the preview scrolls to line 42 with a brief yellow highlight

Only paths that match actual files in your project are linked — no false positives on random text.

### Clickable URLs

URLs in terminal output (`http://` and `https://`) are automatically detected and clickable. Clicking a URL opens it in your default system browser.

---

## File Tree

The right panel shows your project's directory structure with real-time git status.

### Navigation

| Action | How |
|--------|-----|
| Select file | Click it |
| Open preview | Double-click, or select then press **Space** |
| Expand folder | Click the arrow, or select then press **Right** |
| Collapse folder | Click the arrow, or select then press **Left** |
| Clear selection | Click outside the tree |

### Keyboard navigation

| Key | Action |
|-----|--------|
| **Up / Down** | Move selection through visible files |
| **Right** | Expand folder, or move into first child if already expanded |
| **Left** | Collapse folder, or jump to parent directory |
| **Space** | Toggle Quick Look preview on/off |

When Quick Look is open, arrow keys navigate through files and the preview updates live — like Finder's Quick Look.

### Context menu

Right-click any file in the tree to access:

| Action | What it does |
|--------|-------------|
| **Open** | Opens the file in its default macOS application |
| **Reveal in Finder** | Shows the file in a Finder window |
| **Copy Path** | Copies the full file path to the clipboard |

### Filtering

Type in the filter box at the top of the file tree to fuzzy-search by filename or path. Press the **x** to clear.

### Hidden system files

macOS system files are automatically hidden from the file tree: `.DS_Store`, `._*` resource forks, `.Spotlight-V100`, `.Trashes`, `.fseventsd`, and `.TemporaryItems`. User dotfiles like `.gitignore` and `.env` remain visible.

### Git status indicators

Each file shows a coloured letter badge:

| Badge | Meaning | Colour |
|-------|---------|--------|
| **M** | Modified | Orange |
| **A** | Added | Green |
| **D** | Deleted | Red |
| **R** | Renamed | Green |
| **U** | Untracked | Green |
| **C** | Conflicted | Red |

Folders roll up the highest-priority status of their children.

The panel header shows a diff summary: **+X -Y** (additions/deletions) or a green checkmark when the working directory is clean.

---

## Quick Look (File Preview)

Quick Look is a modal overlay for previewing files without leaving the app.

### Opening Quick Look

| Method | What happens |
|--------|-------------|
| Double-click a file in the tree | Opens preview |
| Select a file, press **Space** | Opens preview |
| **Cmd+click** a path in the terminal | Opens preview (scrolls to line if specified) |

### Supported file types

**Text files** — Syntax-highlighted with line numbers. Supports JS, TS, JSX, TSX, Python, Rust, Go, C/C++, HTML, CSS, JSON, YAML, TOML, SQL, Markdown, Bash, and more.

**Images** — PNG, JPG, GIF, SVG, WebP, BMP, ICO, TIFF displayed inline.

**Binary files** — Video, audio, PDF, Office documents, and archives open in native macOS Quick Look.

### Header actions

The Quick Look header includes a **Reveal in Finder** button (Finder icon). Click it to show the currently previewed file in a Finder window.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| **Escape** | Close preview |
| **Space** | Close preview (same as toggle) |
| **Up / Down** | Navigate to previous/next file (preview updates live) |
| **Left / Right** | Collapse/expand folders while navigating |
| **D** | Toggle diff view |
| **S** | Toggle diff layout (unified / side-by-side) — only in diff view |

### Line numbers

All text files display a line number gutter on the left side. Line numbers are not selectable, so copying code won't include them.

### Scroll-to-line

When Quick Look is opened from a terminal link with a line number (e.g. Cmd+clicking `src/App.tsx:42`), the preview:

1. Scrolls to centre line 42 in view
2. Highlights it with a yellow background
3. The highlight fades out over 2 seconds

### Git status badge

The header shows a badge when the file has uncommitted changes:

| Badge | Colour | Meaning |
|-------|--------|---------|
| **New** | Green | Untracked file |
| **Modified** | Orange | Has unstaged changes |
| **Added** | Green | Staged for commit |
| **Deleted** | Red | File deleted |

### Diff view

Press **D** to switch from the file view to a diff view showing uncommitted changes (`git diff HEAD`).

- **Additions** highlighted in green
- **Deletions** highlighted in red
- Line numbers shown for both old and new versions
- Untracked files show the entire file as additions

Press **S** while in diff view to toggle between:

- **Unified** (default) — single column, additions and deletions interleaved
- **Side-by-side** — two columns showing before and after

The header updates to show available shortcuts:

- In file view: `D Diff`
- In diff view: `D File` `S Split` (or `S Unified`)

Press **D** again to return to the normal file view.

---

## Scheduled Jobs

Scheduled jobs let you run Claude Code prompts, Codex prompts, or shell commands on a recurring schedule. Jobs run in the background using macOS launchd, even when Codezilla is closed.

### Creating a job

1. Click the **+** button next to a project name in the left panel
2. Select **Scheduled Job** from the type picker
3. Fill in the creation form:
   - **Type** — Claude, Codex, or Terminal (shell)
   - **Name** — optional; auto-generated from the command if left blank
   - **Command** — the prompt or shell command to run
   - **Schedule** — pick one of three modes:

| Schedule mode | Example |
|---------------|---------|
| Every N minutes/hours | Every 30 minutes |
| Daily at a specific time | Daily at 09:00 |
| Weekly on a specific day and time | Monday at 14:00 |

4. Click **Create** to save, or **Create & Run** to save and execute immediately

### Viewing jobs

Jobs appear in a collapsible **Scheduled** section under each project in the left panel. Each job shows:

- A clock icon (accent colour when enabled, dimmed when disabled, red if the last run failed, spinning when running)
- The job name
- A human-readable schedule summary (e.g. "every 30 min", "daily 09:00")

Click a job to open its detail panel in the centre area.

### Job detail panel

The detail panel shows:

- **Header** — job name, enabled/disabled status badge, type, schedule, and command preview
- **Action buttons** — Edit, Run Now, Enable/Disable, Delete
- **Run history** — list of all runs (newest first), each showing:
  - Status icon: green checkmark (success), red cross (failure), or spinner (running)
  - Timestamp and duration
  - Click a run to expand and view its log output
  - Open button to reveal the log file in Finder

### Managing jobs

| Action | How |
|--------|-----|
| Edit | Click **Edit** in the detail panel — form reopens with current values |
| Run now | Click **Run Now** to execute immediately outside the schedule |
| Disable | Click **Disable** — removes the launchd agent but keeps the job in Codezilla |
| Enable | Click **Enable** — re-registers the launchd agent |
| Delete | Click **Delete** — confirms, then removes the agent, all logs, and the job record |

### How it works under the hood

- Each job creates a macOS launchd agent (`~/Library/LaunchAgents/com.codezilla.job.<id>.plist`)
- Output is captured to log files in `~/.codezilla/logs/<job-id>/`
- Each run produces a separate timestamped `.log` file
- Jobs run in the project directory with a login shell, so your PATH and environment are available
- Disabled jobs have their launchd agent removed but remain in the Codezilla config for re-enabling

---

## Skills & Plugins Manager

The Skills & Plugins Manager lets you discover, install, update, and organise Claude Code skills, agents, commands, and plugins across your projects.

### Accessing the manager

- **Right panel strip** — a compact bar above the file tree shows item counts (e.g. "3 skills · 1 plugin") and an update badge. Click it to open the full manager.
- **Project view summary** — when no thread is active, the centre panel lists installed item names with a **Manage** button.

### What it shows

The manager overlay is divided into sections:

| Section | Contents |
|---------|----------|
| **Add from URL** | Text input to paste a git repo URL and fetch installable items |
| **Installed — Global** | Skills, agents, and commands installed for all projects |
| **Installed — This Project** | Items scoped to the active project only |
| **Marketplace Plugins** | Plugins installed via Claude Code's marketplace system |
| **Unmanaged** | Items found on disk but not tracked by Codezilla's registry |
| **Registry** | Previously fetched items available for install |
| **Sources** | Git repo URLs registered as item sources |

### Installing from a URL

1. Paste a git repo URL into the **Add from URL** input and press Enter or click **Fetch**
2. Codezilla clones the repo and scans for installable items (skills, agents, commands, plugins)
3. Detected items appear with checkboxes (all selected by default)
4. Choose a scope — **Global** or **This Project** — and click **Install**
5. If files already exist at the install path, a confirmation dialog warns before overwriting

### Installing marketplace plugins

1. Paste a marketplace repo URL and fetch
2. Detected plugins appear in the results
3. Select and install — Codezilla registers the marketplace and runs `claude plugin install` under the hood
4. Installed plugins show their marketplace name as a clickable link to the GitHub repo

### Managing installed items

| Action | How |
|--------|-----|
| **Remove** | Click the remove button — confirms, then deletes files |
| **Update** | When an update badge appears, click it to pull the latest version from the source repo |
| **Move to Global** | Promote a project-scoped item so all projects can use it |
| **Move to Project** | Restrict a global item to the current project only |

### Claiming unmanaged items

If Codezilla finds skills or plugins on disk that it doesn't track (e.g. manually installed), they appear in the **Unmanaged** section. Click **Link source** to associate them with a git repo URL. Codezilla verifies the content matches using SHA-256 hashes.

### Duplicate detection

If the same item is installed at both global and project scope, the project copy shows a yellow **duplicate** badge. Click **Remove duplicate** to clean up the redundant copy.

### Marketplace links

Installed items and marketplace plugins show clickable source labels (e.g. the marketplace name or `github.com/user/repo`). Clicking these opens the repo in your system browser.

### Plugin sub-items

Marketplace plugins that contain multiple skills, agents, or commands show an expand toggle. Click to reveal the plugin's contents as an indented tree.

### Scope and project filtering

- **Global** items appear in every project
- **Project-scoped** items only appear when their project is active
- Marketplace plugins installed for a specific project are filtered — you only see plugins belonging to the active project

---

## Recommended Claude Code Settings

Codezilla's thread activity detection (the working spinner, "Idle · Done" badge) relies on OSC `9;4` progress marker sequences emitted by the Claude CLI. If you disable the terminal progress bar in your Claude settings, Codezilla falls back to a less precise output-based detection mode, which can cause the thread status to lag or briefly show "Idle · Done" prematurely.

**Avoid setting this in `~/.claude/settings.json`:**

```json
{
  "terminalProgressBarEnabled": false
}
```

If you've set this for another reason, thread status in Codezilla will still work — just with slightly reduced accuracy.

---

## Close Protection

When you quit the app while threads are actively running (producing output), Codezilla shows a confirmation dialog:

> "You have N active processes running. Quit anyway?"

Idle threads (waiting for input) close silently — their sessions are saved and can be resumed next time.

---

## Keyboard Shortcut Reference

### Global

| Shortcut | Action |
|----------|--------|
| **Cmd+Q** | Quit (with confirmation if processes are active) |

### File Tree

| Shortcut | Action |
|----------|--------|
| **Up / Down** | Navigate files |
| **Left / Right** | Collapse/expand or navigate to parent/child |
| **Space** | Toggle Quick Look |
| **Right-click** | Context menu (Open, Reveal in Finder, Copy Path) |

### Quick Look

| Shortcut | Action |
|----------|--------|
| **Escape** | Close |
| **Space** | Close |
| **Up / Down** | Previous/next file |
| **D** | Toggle diff view |
| **S** | Toggle unified/side-by-side (in diff view) |

### Terminal

| Shortcut | Action |
|----------|--------|
| **Cmd+click** file path | Open in file tree + Quick Look |
| **Click** URL | Open in system browser |

### Skills & Plugins Manager

| Shortcut | Action |
|----------|--------|
| **Escape** | Close confirm dialog, then close manager |
| **Enter** (in URL input) | Fetch items from URL |
