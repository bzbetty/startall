# 🚀 startall

> A powerful, interactive terminal UI for managing multiple npm scripts with tmux-style panes, filtering, and real-time control

![startall screenshot](https://github.com/bzbetty/startall/raw/main/screenshot.png)

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

**startall** is a sophisticated TUI that combines the power of tmux with the simplicity of npm scripts, giving you complete control over your development processes with split panes, filtering, and interactive controls.

## Features

### 🎯 Core Features
- **Auto-discovery**: Automatically reads all scripts from `package.json`
- **Smart defaults**: Remembers your last selection in `startall.json`
- **10-second countdown**: Review selections before starting
- **Parallel execution**: Run multiple npm scripts simultaneously
- **Live status monitoring**: Real-time status indicators (● running, ✖ crashed, ○ stopped)
- **Interactive controls**: Start, stop, and restart individual processes on the fly
- **Cross-platform**: Works identically on Windows, Linux, and macOS

### 🎨 Advanced UI
- **Multi-pane layout**: tmux-inspired split panes (vertical & horizontal)
- **Flexible filtering**: 
  - Text search across all output (`/`)
  - Filter by ANSI color (red/yellow/green/blue/cyan/magenta) (`c`)
  - Per-process visibility toggles (`Space` or `1-9`)
  - Per-pane filters (different views in each pane)
- **Custom pane naming**: Label panes for easier identification (`n`)
- **Persistent layouts**: Your pane configuration is saved between sessions
- **Process-specific views**: Show/hide specific processes in each pane
- **Colored output**: Each process gets unique color-coded output
- **Pause/resume**: Freeze output to review logs (`p`)
- **Scrollable history**: 1000-line buffer with mouse wheel support
- **Enhanced navigation**: Home/End/PageUp/PageDown keys

### ⚙️ Display Options
- **Toggleable line numbers**: Show/hide line numbers (`#`)
- **Timestamps**: Show/hide timestamps for each log line (`t`)
- **Quick process toggle**: Use number keys `1-9` for instant visibility control

### 🔧 Advanced Controls
- **Quick Commands**: Run any script on-demand without adding it to the persistent processes
  - Press `e` to open command picker and select any script
  - Or assign keyboard shortcuts for instant access (press assigned key to run)
  - Perfect for build scripts, tests, or any short-running command
  - Output shown in popup overlay with Esc to close
  - Configure shortcuts in settings (`o` → Quick Commands section)
- **Interactive input mode**: Send commands to running processes via stdin (`i`)
  - Perfect for dev servers that accept commands (Vite, Rust watch, etc.)
- **Settings panel**: Configure ignore/include patterns, shortcuts, and more (`o`)
  - Wildcard support (`*`) for pattern matching
  - Per-script visibility toggles
- **Keyboard & mouse support**: Full keyboard navigation + mouse clicking/scrolling
- **VSCode integration**: Optimized for VSCode integrated terminal

## Installation

```bash
npm install -g startall
```

## Usage

In any project with a `package.json`:

```bash
startall                    # uses startall.json if present
startall myconfig.json      # uses custom config file
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
- `o` - Open settings
- `Ctrl+C` - Exit

**Running Screen:**

*Process Control:*
- `1-9` - Quick toggle process visibility in focused pane
- `Space` - Toggle visibility of selected process
- `s` - Stop/start selected process
- `r` - Restart selected process
- `i` - Send input to selected process (interactive mode)
- `e` - Execute any script (opens command picker)
- `a-z` - Run assigned quick command (if configured)

*Pane Management:*
- `\` - Open command palette
- `|` - Split pane vertically (left/right)
- `_` - Split pane horizontally (top/bottom)
- `x` - Close current pane (if >1 pane exists)
- `Tab` - Next pane
- `Shift+Tab` - Previous pane
- `n` - Name current pane

*Filtering & View:*
- `/` - Enter text filter mode
- `c` - Cycle color filter (red/yellow/green/blue/cyan/magenta/none)
- `f` - Filter to selected process only
- `Esc` - Clear filters
- `p` - Pause/resume output scrolling
- `#` - Toggle line numbers
- `t` - Toggle timestamps

*Navigation:*
- `↑`/`↓` or `k`/`j` - Select process (vim-style)
- `←`/`→` or `h`/`l` - Select process (vim-style)
- `Home` - Scroll to top of pane
- `End` - Scroll to bottom of pane
- `Page Up` - Scroll up one page
- `Page Down` - Scroll down one page
- `Mouse wheel` - Scroll output

*Other:*
- `o` - Open settings
- `q` - Quit (stops all processes)
- `Ctrl+C` - Force quit

**Settings Screen:**
- `Tab`/`←`/`→` - Switch sections (Display/Ignore/Include/Quick Commands/Script List)
- `↑`/`↓` - Navigate items
- `i` - Add new ignore pattern
- `n` - Add new include pattern
- `Space` or `Enter` - Toggle option (Display) / Assign shortcut (Quick Commands) / Toggle ignore (Script List)
- `d` or `Backspace` - Delete pattern or shortcut
- `Esc` or `q` - Return to previous screen

**Run Command Picker:**
- `↑`/`↓` or `k`/`j` - Navigate scripts
- `Enter` - Run selected script
- `Esc` or `q` - Close picker

**Quick Commands Overlay:**
- `Esc` - Close overlay and stop command (if running)

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
- Saves configuration in `startall.json`:
  ```json
  {
    "defaultSelection": ["frontend", "backend"],
    "include": ["dev:*"],
    "ignore": ["*:test"],
    "shortcuts": {
      "b": "build",
      "t": "test",
      "l": "lint"
    }
  }
  ```
  - `defaultSelection`: scripts to auto-select on startup
  - `include` (optional): if defined, only scripts matching these patterns are shown
  - `ignore`: scripts matching these patterns are hidden
  - `shortcuts`: keyboard shortcuts for running commands on-demand
  - All patterns support wildcards (`*`)

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
