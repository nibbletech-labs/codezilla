# Codezilla

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A macOS desktop app for managing AI coding sessions alongside your project files. Terminals for Claude Code, Codex, and plain shell — all in one window with an integrated file browser and Quick Look preview.

## Features

- **Multi-terminal workspace** — Run Claude Code, Codex, and shell sessions side by side
- **Three-panel layout** — Projects & threads on the left, terminal in the centre, file tree on the right
- **Session persistence** — Quit and reopen without losing context; Claude Code and Codex sessions resume automatically
- **File tree with git status** — Real-time modified/added/deleted badges, folder rollups, and a diff summary in the header
- **Quick Look preview** — Syntax-highlighted file preview with diff view, triggered by Space or Cmd+click on terminal paths
- **Clickable file paths** — Cmd+click paths in terminal output to jump to the file in the tree and open Quick Look
- **Keyboard-driven navigation** — Arrow keys, Space to preview, D for diff, S to toggle split view

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

## Usage

### Layout

```
+----------+---------------------+----------+
| Projects |      Terminal       |  Files   |
| & Threads|                     |          |
+----------+---------------------+----------+
|              Status Bar                    |
+--------------------------------------------+
```

- **Left panel** — Add projects, create threads (Claude Code / Codex / Terminal)
- **Centre panel** — Active terminal session with full colour and 5,000-line scrollback
- **Right panel** — File tree with git status indicators and filter search

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Up / Down** | Navigate file tree |
| **Left / Right** | Collapse / expand folders |
| **Space** | Toggle Quick Look preview |
| **D** | Toggle diff view (in Quick Look) |
| **S** | Toggle unified / side-by-side diff |
| **Escape** | Close Quick Look |
| **Cmd+click** | Open terminal file path in Quick Look |

## License

[MIT](LICENSE) — Copyright 2026 Nibbletech Labs
