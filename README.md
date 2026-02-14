# Codezilla

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A macOS desktop app for multi-project management of AI-enabled development. Supports Claude Code and Codex with full session persistence.

## Features

- **Multi-project, multi-thread** — Manage multiple projects, each with their own Claude Code, Codex, and shell sessions
- **Session resumption** — Conversations persist across restarts; Claude Code and Codex sessions resume automatically
- **Thread status at a glance** — See which threads are running, saved, or exited across all your projects
- **File preview** — Browse project files with syntax highlighting, Quick Look preview, and git diff view
- **Git-aware file tree** — Real-time modified/added/deleted indicators with diff summary
- **Intelligent terminal detection** — File paths and commit hashes in terminal output become clickable links

## Prerequisites

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
