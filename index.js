#!/usr/bin/env bun

import { createCliRenderer, Text, Box } from '@opentui/core';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// Configuration
const DEFAULTS_FILE = './.last-selected-scripts.json';
const COUNTDOWN_SECONDS = 10;

// Parse npm scripts from package.json
function parseNpmScripts(packageJsonPath) {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const scripts = pkg.scripts || {};
    
    return Object.entries(scripts)
      .filter(([name]) => !name.startsWith('pre') && !name.startsWith('post') && name !== 'start')
      .map(([name, command]) => ({
        name,
        command: `npm run ${name}`,
        displayName: name,
      }));
  } catch (error) {
    console.error('Error reading package.json:', error.message);
    process.exit(1);
  }
}

// Load previous selections
function loadDefaultSelections() {
  if (existsSync(DEFAULTS_FILE)) {
    try {
      return JSON.parse(readFileSync(DEFAULTS_FILE, 'utf8'));
    } catch {
      return [];
    }
  }
  return [];
}

// Save selections
function saveDefaultSelections(selections) {
  try {
    writeFileSync(DEFAULTS_FILE, JSON.stringify(selections, null, 2));
  } catch (error) {
    console.error('Error saving selections:', error.message);
  }
}

// Process Manager
class ProcessManager {
  constructor(renderer, scripts) {
    this.renderer = renderer;
    this.scripts = scripts;
    this.phase = 'selection'; // 'selection' | 'running'
    this.selectedScripts = new Set(loadDefaultSelections());
    this.countdown = COUNTDOWN_SECONDS;
    this.selectedIndex = 0;
    this.processes = new Map();
    this.processRefs = new Map();
    this.outputLines = [];
    this.filter = '';
    this.maxOutputLines = 1000;
    
    this.setupKeyboardHandlers();
    this.startCountdown();
    this.render();
  }

  setupKeyboardHandlers() {
    this.renderer.onKeyPress((key, modifiers) => {
      // Handle Ctrl+C
      if (modifiers.ctrl && key === 'c') {
        this.cleanup();
        process.exit(0);
      }
      
      this.handleInput(key, modifiers);
      this.render();
    });
  }

  handleInput(key, modifiers) {
    if (this.phase === 'selection') {
      if (key === 'Enter') {
        clearInterval(this.countdownInterval);
        this.startProcesses();
      } else if (key === 'ArrowUp') {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      } else if (key === 'ArrowDown') {
        this.selectedIndex = Math.min(this.scripts.length - 1, this.selectedIndex + 1);
      } else if (key === ' ') {
        const scriptName = this.scripts[this.selectedIndex]?.name;
        if (scriptName) {
          if (this.selectedScripts.has(scriptName)) {
            this.selectedScripts.delete(scriptName);
          } else {
            this.selectedScripts.add(scriptName);
          }
        }
      }
    } else if (this.phase === 'running') {
      if (key === 'q') {
        this.cleanup();
        process.exit(0);
      } else if (key === 'ArrowUp') {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      } else if (key === 'ArrowDown') {
        this.selectedIndex = Math.min(this.scripts.length - 1, this.selectedIndex + 1);
      } else if (key === 'r') {
        const scriptName = this.scripts[this.selectedIndex]?.name;
        if (scriptName) {
          this.restartProcess(scriptName);
        }
      } else if (key === ' ') {
        const scriptName = this.scripts[this.selectedIndex]?.name;
        if (scriptName) {
          this.toggleProcess(scriptName);
        }
      } else if (key === 'Backspace') {
        this.filter = this.filter.slice(0, -1);
      } else if (key === 'Escape') {
        this.filter = '';
      } else if (key.length === 1) {
        this.filter += key;
      }
    }
  }

  startCountdown() {
    this.countdownInterval = setInterval(() => {
      this.countdown--;
      this.render();
      
      if (this.countdown <= 0) {
        clearInterval(this.countdownInterval);
        this.startProcesses();
      }
    }, 1000);
  }

  startProcesses() {
    const selected = Array.from(this.selectedScripts);
    
    if (selected.length === 0) {
      console.log('No scripts selected.');
      process.exit(0);
    }
    
    saveDefaultSelections(selected);
    this.phase = 'running';
    this.selectedIndex = 0;
    
    selected.forEach(scriptName => {
      this.startProcess(scriptName);
    });
    
    this.render();
  }

  startProcess(scriptName) {
    const script = this.scripts.find(s => s.name === scriptName);
    if (!script) return;

    const proc = spawn('npm', ['run', scriptName], {
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor',
      },
      shell: true,
    });

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          this.addOutputLine(scriptName, line);
        }
      });
      this.render();
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          this.addOutputLine(scriptName, line);
        }
      });
      this.render();
    });

    proc.on('exit', (code) => {
      const status = code === 0 ? 'exited' : 'crashed';
      this.processes.set(scriptName, { status, exitCode: code });
      this.addOutputLine(scriptName, `Process exited with code ${code}`);
      this.render();
    });

    this.processRefs.set(scriptName, proc);
    this.processes.set(scriptName, { status: 'running', pid: proc.pid });
  }

  addOutputLine(processName, text) {
    this.outputLines.push({
      process: processName,
      text,
      timestamp: Date.now(),
    });
    
    if (this.outputLines.length > this.maxOutputLines) {
      this.outputLines = this.outputLines.slice(-this.maxOutputLines);
    }
  }

  stopProcess(scriptName) {
    const proc = this.processRefs.get(scriptName);
    if (proc) {
      proc.kill();
      this.processRefs.delete(scriptName);
      this.processes.set(scriptName, { status: 'stopped' });
      this.addOutputLine(scriptName, 'Process stopped');
    }
  }

  restartProcess(scriptName) {
    this.stopProcess(scriptName);
    setTimeout(() => {
      this.startProcess(scriptName);
      this.render();
    }, 100);
  }

  toggleProcess(scriptName) {
    const proc = this.processes.get(scriptName);
    if (proc?.status === 'running') {
      this.stopProcess(scriptName);
    } else {
      this.startProcess(scriptName);
    }
  }

  cleanup() {
    for (const [scriptName, proc] of this.processRefs.entries()) {
      try {
        proc.kill();
      } catch (err) {
        // Ignore
      }
    }
  }

  render() {
    this.renderer.root.clear();
    
    if (this.phase === 'selection') {
      this.renderSelection();
    } else {
      this.renderRunning();
    }
  }

  renderSelection() {
    const container = Box({
      flexDirection: 'column',
      padding: 1,
    });
    
    const header = Text({
      content: `Starting in ${this.countdown}s... [Enter to start now, Space to toggle, ↑↓ to navigate, Ctrl+C to quit]`,
      fg: '#00FFFF',
      bold: true,
    });
    container.add(header);
    
    container.add(Text({ content: '' }));
    
    this.scripts.forEach((script, index) => {
      const isSelected = this.selectedScripts.has(script.name);
      const isFocused = index === this.selectedIndex;
      const prefix = isFocused ? '▶' : ' ';
      const checkbox = isSelected ? '✓' : ' ';
      const color = isFocused ? '#00FFFF' : '#FFFFFF';
      
      const line = Text({
        content: `${prefix} [${checkbox}] ${script.displayName}`,
        fg: color,
      });
      container.add(line);
    });
    
    this.renderer.root.add(container);
  }

  renderRunning() {
    const container = Box({
      flexDirection: 'column',
      padding: 1,
      width: '100%',
      height: '100%',
    });
    
    // Process list
    const processBox = Box({
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: '#666666',
      marginBottom: 1,
    });
    
    const processHeader = Text({
      content: 'Processes [Space: Start/Stop, R: Restart, Q: Quit, ↑↓: Navigate]',
      fg: '#00FFFF',
      bold: true,
    });
    processBox.add(processHeader);
    
    this.scripts.forEach((script, index) => {
      const proc = this.processes.get(script.name);
      const status = proc?.status || 'stopped';
      const isFocused = index === this.selectedIndex;
      
      const statusIcon = status === 'running' ? '●' : status === 'crashed' ? '✖' : '○';
      const statusColor = status === 'running' ? '#00FF00' : status === 'crashed' ? '#FF0000' : '#666666';
      const nameColor = isFocused ? '#00FFFF' : '#FFFFFF';
      const prefix = isFocused ? '▶' : ' ';
      
      const displayName = script.displayName.padEnd(25);
      
      const line = Box({
        flexDirection: 'row',
      });
      
      line.add(Text({
        content: `${prefix} ${displayName} `,
        fg: nameColor,
      }));
      
      line.add(Text({
        content: statusIcon,
        fg: statusColor,
      }));
      
      line.add(Text({
        content: ` ${status}`,
        fg: '#FFFFFF',
      }));
      
      processBox.add(line);
    });
    
    container.add(processBox);
    
    // Output section
    const outputBox = Box({
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: '#666666',
      flexGrow: 1,
    });
    
    const filterText = this.filter ? ` (filter: ${this.filter})` : ' (type to filter, ESC to clear)';
    const outputHeader = Text({
      content: `Output${filterText}`,
      fg: '#00FFFF',
      bold: true,
    });
    outputBox.add(outputHeader);
    
    const filteredLines = this.filter 
      ? this.outputLines.filter(line => line.text.toLowerCase().includes(this.filter.toLowerCase()))
      : this.outputLines;
    
    const recentLines = filteredLines.slice(-20);
    
    recentLines.forEach(line => {
      outputBox.add(Text({
        content: line.text,
      }));
    });
    
    container.add(outputBox);
    this.renderer.root.add(container);
  }
}

// Main
async function main() {
  const cwd = process.cwd();
  const packageJsonPath = join(cwd, 'package.json');

  if (!existsSync(packageJsonPath)) {
    console.error(`Error: No package.json found in ${cwd}`);
    process.exit(1);
  }

  const scripts = parseNpmScripts(packageJsonPath);
  
  if (scripts.length === 0) {
    console.error('No npm scripts found in package.json');
    process.exit(1);
  }

  const renderer = await createCliRenderer();
  const manager = new ProcessManager(renderer, scripts);
  
  process.on('SIGINT', () => {
    manager.cleanup();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
