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
