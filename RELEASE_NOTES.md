## v0.2.0 — Scheduled Jobs, Skills & Plugins, Launch Presets

The biggest release yet. Codezilla now manages recurring jobs, helps you manage your Claude Code skills and plugins, and lets you launch threads with saved configurations.

**New Features**

- **Scheduled Jobs** — create recurring Claude, Codex, or shell jobs per project with cron-like scheduling via macOS launchd. Jobs run whether or not the app is open. In-app run history with log viewer, run-now, enable/disable, and activity indicators in the sidebar.
- **Skills & Plugins Manager** — detect, install, remove, and manage Claude Code skills, plugins, agents, and commands. Supports marketplace plugins, git-based sources, project and global scoping, conflict detection, SHA-256 verification, and scope migration. Right-panel summary strip shows what's active per project.
- **Launch Presets** — save reusable CLI flag combinations (e.g. `--model sonnet --thinking medium`) and spawn threads from them via the project context menu. Create, edit, and delete presets with custom names and emoji.
- **Clickable terminal links** — URLs in terminal output open in your default browser. File paths show a context menu with Preview, Open, Reveal in Finder, and Copy Path. Supports paths with spaces.
- **macOS code signing & notarization** — the app is now signed with a Developer ID certificate and notarized by Apple, so Gatekeeper won't block it on first launch.

**Performance**

- Fixed crashes when running many threads simultaneously
- Significantly reduced CPU and memory usage, especially with background threads
- App launch is faster and more responsive

**Fixes**

- Thread status indicators are more accurate — no more stuck "Working" spinners or false idle states
- Code preview works correctly in production builds
- macOS system files (.DS_Store, etc.) no longer clutter the file explorer
- Badge notifications clear properly when clicking a thread
- Terminal scroll now reliably reaches the bottom on resume and thread switch
