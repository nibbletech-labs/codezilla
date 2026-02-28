## v0.1.3 — Thread Status & Activity Detection

**Improvements**
- Project drag-and-drop reordering
- App is now signed and notarized by Apple

**Fixes**
- **Thread status accuracy**: fixed Working status getting stuck after Ctrl+C, false Working spinner during history replay on resume, and spurious Done/Idle states from progress marker timing races and stale activity signals
- **Scroll behaviour**: fixed scroll not reaching the bottom when resuming or switching threads, and miscalibration when switching back to a thread
- **Activity detection overhaul**: replaced raw byte scanning with rendered terminal buffer only, eliminating false positives from replayed history; improved pattern matching for Claude's thinking/timer progress lines
- **Codex**: fixed thread stuck on Working after tool calls complete
- **File preview**: fixed markdown link handling, memory leak, and improved syntax highlighting robustness

## v0.1.2 — Auto-updater

- **Auto-updater** — Codezilla now checks for new versions on launch and shows a notification in the status bar. Updates are downloaded on click.
