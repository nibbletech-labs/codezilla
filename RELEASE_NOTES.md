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
