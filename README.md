# Codezilla

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A macOS desktop app for multi-project management of AI-enabled development. Supports Claude Code and Codex [Beta] with full session persistence.

## Features

- **Multiple thread types** — Launch Claude Code, Codex [Beta], or standard terminal sessions within project folders
- **Session resumption** — Conversations persist across restarts; Claude Code and Codex sessions resume automatically
- **Thread status at a glance** — See which threads are running, saved, or exited across all your projects
- **Launch presets** — Create reusable thread configurations with custom CLI arguments
- **File preview** — Browse project files with syntax highlighting, Quick Look preview, markdown rendering, and git diff view
- **File panel views** — Switch between All, Recent, and Changes views to focus on the files that matter
- **Git-aware file tree** — Real-time modified/added/deleted indicators with diff summary
- **Clickable terminal output** — File paths, URLs, and commit hashes become clickable links
- **Copy as prose** — Select terminal output and copy it as clean, readable text with line wraps removed
- **Appearance** — Dark, Light, or System theme with 8 accent colours and text size scaling
- **[Beta] Skills & Plugins Manager** — Discover, install, and manage Claude Code skills, agents, commands, and plugins from git repos with a built-in registry and update tracking
- **[Beta] Scheduled jobs** — Create recurring tasks with launchd integration

See the [User Guide](USER_GUIDE.md) for full documentation.

## Install

Download the latest `.dmg` from [Releases](https://github.com/nibbletech-labs/codezilla/releases), open it, and drag Codezilla to Applications.

The app is code-signed and notarised for macOS.

## Prerequisites (building from source)

- **Node.js** 18+
- **Rust** (install via [rustup](https://rustup.rs))
- **Xcode Command Line Tools** — `xcode-select --install`

## Getting Started

```bash
# Install dependencies
npm install

# Run in development mode
npx tauri dev

# Build macOS .app bundle
npx tauri build --bundles app
```

The built app is output to `src-tauri/target/release/bundle/macos/Codezilla.app`.

## License

[MIT](LICENSE) — Copyright 2026 Nibbletech Labs
