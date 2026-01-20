# 🚀 Start

> An interactive terminal UI for managing multiple npm scripts in parallel

## The Problem

Running multiple npm scripts during development is tedious:

- **Repetitive**: Manually typing `npm run frontend`, `npm run backend`, etc. every time
- **Cluttered terminal**: Multiple terminal tabs/windows get messy fast
- **No visibility**: Hard to tell if one process crashed while others are running
- **No control**: Can't easily restart a single service without restarting everything
- **No filtering**: Output from 4+ processes becomes unreadable noise

Traditional solutions fall short:
- `npm-run-all`/`concurrently`: No interactivity, just dumps output
- PM2: Overkill for dev workflows, designed for production
- Overmind: Amazing UX but requires tmux (not Windows-friendly)
- Manual shell scripts: No real-time status or control

## The Solution

**Start** is a lightweight, interactive TUI that gives you complete control over your development processes:

```
┌─ Starting in 7s... [Enter to start now] ─────────────┐
│ [x] frontend (npm run start:frontend)                │
│ [x] backend (npm run start:backend)                  │
│ [ ] worker (npm run start:worker)                    │
│ [x] db (npm run start:db)                            │
│                                                       │
│ ↑/↓ Navigate | Space: Toggle | Enter: Start          │
└───────────────────────────────────────────────────────┘

After starting:
┌─ Processes ──────────────┬─ Output (filter: error) ───┐
│ [f] frontend ● Running   │ [backend] Error: ECONNREF  │
│ [b] backend  ✖ Crashed   │ [backend] Retrying...      │
│ [w] worker   ⏸ Stopped   │ [frontend] Started on 3000 │
│ [d] db       ● Running   │                            │
│                          │                            │
│ Space: Start/Stop        │                            │
│ r: Restart               │                            │
│ /: Filter output         │                            │
└──────────────────────────┴────────────────────────────┘
```

## Features

### ✅ Current
- **Auto-discovery**: Reads all scripts from `package.json` automatically
- **Smart defaults**: Remembers your last selection
- **10-second countdown**: Time to review/change selections before starting
- **Parallel execution**: Run multiple npm scripts simultaneously
- **Colored output**: Each process gets its own color prefix

### 🚧 Planned
- **Live status monitoring**: See which processes are running/crashed/stopped at a glance
- **Interactive controls**: Start, stop, and restart individual processes with keyboard shortcuts
- **Output filtering**: Search/filter logs across all processes in real-time
- **Cross-platform**: Works identically on Windows, Linux, and macOS
- **Tab view**: Switch between different process outputs
- **Resource monitoring**: CPU/memory usage per process

## Installation

```bash
npm install -g @yourname/start
```

## Usage

In any project with a `package.json`:

```bash
start
```

That's it! The TUI will:

1. Show all available npm scripts
2. Pre-select your last choices
3. Give you 10 seconds to adjust
4. Start all selected scripts in parallel

### Keyboard Shortcuts

**Selection Screen:**
- `↑`/`↓` - Navigate scripts
- `Space` - Toggle selection
- `Enter` - Start immediately (skip countdown)
- `Ctrl+C` - Exit

**Running Screen (planned):**
- `Space` - Start/stop selected process
- `r` - Restart selected process
- `/` - Filter output
- `Tab` - Switch between processes
- `Ctrl+C` - Stop all and exit

## Why Build This?

Existing tools either:
- Lack interactivity (concurrently, npm-run-all)
- Are production-focused (PM2, forever)
- Don't support Windows (Overmind, tmux-based tools)
- Are too heavyweight for simple dev workflows

**Start** is purpose-built for the development workflow: lightweight, cross-platform, and interactive.

## Technical Details

- Built with [OpenTUI](https://github.com/openmux/opentui) for a modern terminal UI
- Uses standard Node.js `child_process` (no PTY required = Windows support)
- Parses `package.json` scripts automatically
- Saves preferences in `.last-selected-scripts.json`

## Roadmap

- [ ] Interactive process control (start/stop/restart)
- [ ] Real-time status indicators
- [ ] Output filtering and search
- [ ] Tab view for individual process logs
- [ ] Resource monitoring
- [ ] Custom color schemes
- [ ] Configuration file support
- [ ] Watch mode (restart on file changes)

## Contributing

PRs welcome! This is a tool built by developers, for developers.

## License

MIT
