#!/usr/bin/env bun

import { createCliRenderer, TextRenderable, BoxRenderable, ScrollBoxRenderable, t, fg } from '@opentui/core';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import kill from 'tree-kill';

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
    this.maxVisibleLines = 30;  // Number of recent lines to show when not paused
    this.isPaused = false;  // Whether output scrolling is paused
    this.wasPaused = false;  // Track previous pause state to detect changes
    this.isFilterMode = false;  // Whether in filter input mode
    this.outputBox = null;  // Reference to the output container
    this.lastRenderedLineCount = 0;  // Track how many lines we've rendered
    this.headerRenderable = null;  // Reference to header text in running UI
    this.processListRenderable = null;  // Reference to process list text in running UI
    
    // Assign colors to each script
    this.processColors = new Map();
    const colors = ['#7aa2f7', '#bb9af7', '#9ece6a', '#f7768e', '#e0af68', '#73daca'];
    scripts.forEach((script, index) => {
      this.processColors.set(script.name, colors[index % colors.length]);
    });
    
    // UI references
    this.headerText = null;
    this.scriptLines = [];
    this.scriptLinePositions = []; // Track Y positions of script lines for mouse clicks
    this.selectionContainer = null;
    this.runningContainer = null;
    
    this.setupKeyboardHandlers();
    this.setupMouseHandlers();
    this.buildSelectionUI();
    this.startCountdown();
  }

  setupKeyboardHandlers() {
    this.renderer.keyInput.on('keypress', (key) => {
      // Handle Ctrl+C (if exitOnCtrlC is false)
      if (key.ctrl && key.name === 'c') {
        this.cleanup();
        this.renderer.destroy();
        return;
      }
      
      this.handleInput(key.name, key);
      this.render();
    });
  }
  
  setupMouseHandlers() {
    // Mouse events are handled via BoxRenderable properties, not a global handler
    // We'll add onMouseDown to individual script lines in buildSelectionUI
  }

  handleInput(keyName, keyEvent) {
    if (this.phase === 'selection') {
      if (keyName === 'enter' || keyName === 'return') {
        clearInterval(this.countdownInterval);
        this.startProcesses();
      } else if (keyName === 'up') {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      } else if (keyName === 'down') {
        this.selectedIndex = Math.min(this.scripts.length - 1, this.selectedIndex + 1);
      } else if (keyName === 'space') {
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
      // If in filter mode, handle filter input
      if (this.isFilterMode) {
        if (keyName === 'escape') {
          this.isFilterMode = false;
          this.filter = '';
          this.buildRunningUI(); // Rebuild to clear filter
        } else if (keyName === 'enter' || keyName === 'return') {
          this.isFilterMode = false;
          this.isPaused = true; // Pause when filter is applied
          this.buildRunningUI(); // Rebuild with filter
        } else if (keyName === 'backspace') {
          this.filter = this.filter.slice(0, -1);
          this.buildRunningUI(); // Update UI to show filter change
        } else if (keyName && keyName.length === 1 && !keyEvent.ctrl && !keyEvent.meta) {
          this.filter += keyName;
          this.buildRunningUI(); // Update UI to show filter change
        }
      } else {
        // Normal mode - handle commands
        if (keyName === 'q') {
          this.cleanup();
          this.renderer.destroy();
        } else if (keyName === 'space') {
          // Toggle pause output scrolling
          this.isPaused = !this.isPaused;
        } else if (keyName === 'f') {
          // Filter to currently selected process
          const scriptName = this.scripts[this.selectedIndex]?.name;
          if (scriptName) {
            this.filter = scriptName;
            this.isPaused = true; // Auto-pause when filtering
            this.buildRunningUI(); // Rebuild to apply filter
          }
        } else if (keyName === '/') {
          // Enter filter mode
          this.isFilterMode = true;
          this.filter = '';
        } else if (keyName === 'escape') {
          // Clear filter and unpause
          this.filter = '';
          this.isPaused = false;
          this.buildRunningUI(); // Rebuild to clear filter
        } else if (keyName === 'up' || keyName === 'k') {
          // Navigate processes up
          this.selectedIndex = Math.max(0, this.selectedIndex - 1);
          this.buildRunningUI(); // Rebuild to show selection change
        } else if (keyName === 'down' || keyName === 'j') {
          // Navigate processes down
          this.selectedIndex = Math.min(this.scripts.length - 1, this.selectedIndex + 1);
          this.buildRunningUI(); // Rebuild to show selection change
        } else if (keyName === 'left' || keyName === 'h') {
          // Navigate processes left
          this.selectedIndex = Math.max(0, this.selectedIndex - 1);
          this.buildRunningUI(); // Rebuild to show selection change
        } else if (keyName === 'right' || keyName === 'l') {
          // Navigate processes right
          this.selectedIndex = Math.min(this.scripts.length - 1, this.selectedIndex + 1);
          this.buildRunningUI(); // Rebuild to show selection change
        } else if (keyName === 'r') {
          const scriptName = this.scripts[this.selectedIndex]?.name;
          if (scriptName) {
            this.restartProcess(scriptName);
          }
        } else if (keyName === 's') {
          // Stop/start selected process
          const scriptName = this.scripts[this.selectedIndex]?.name;
          if (scriptName) {
            this.toggleProcess(scriptName);
          }
        }
      }
    }
  }
  
  handleMouse(mouse) {
    if (this.phase === 'selection') {
      // Left click or scroll wheel click
      if (mouse.type === 'mousedown' && (mouse.button === 'left' || mouse.button === 'middle')) {
        // Check if click is on a script line
        const clickedIndex = this.scriptLinePositions.findIndex(pos => pos === mouse.y);
        
        if (clickedIndex !== -1) {
          const scriptName = this.scripts[clickedIndex]?.name;
          if (scriptName) {
            // Toggle selection
            if (this.selectedScripts.has(scriptName)) {
              this.selectedScripts.delete(scriptName);
            } else {
              this.selectedScripts.add(scriptName);
            }
            // Update focused index
            this.selectedIndex = clickedIndex;
            this.render();
          }
        }
      } else if (mouse.type === 'wheeldown') {
        this.selectedIndex = Math.min(this.scripts.length - 1, this.selectedIndex + 1);
        this.render();
      } else if (mouse.type === 'wheelup') {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.render();
      }
    } else if (this.phase === 'running') {
      // Mouse support for running phase
      if (mouse.type === 'mousedown' && mouse.button === 'left') {
        const clickedIndex = this.scriptLinePositions.findIndex(pos => pos === mouse.y);
        
        if (clickedIndex !== -1) {
          this.selectedIndex = clickedIndex;
          this.render();
        }
      } else if (mouse.type === 'wheeldown') {
        this.selectedIndex = Math.min(this.scripts.length - 1, this.selectedIndex + 1);
        this.render();
      } else if (mouse.type === 'wheelup') {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.render();
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
    // Always store the output line, even when paused
    this.outputLines.push({
      process: processName,
      text,
      timestamp: Date.now(),
    });
    
    if (this.outputLines.length > this.maxOutputLines) {
      this.outputLines = this.outputLines.slice(-this.maxOutputLines);
    }
    
    // Only render if not paused - this prevents new output from appearing
    // when the user is reviewing history
    if (!this.isPaused) {
      this.render();
    }
  }

  stopProcess(scriptName) {
    const proc = this.processRefs.get(scriptName);
    if (proc && proc.pid) {
      // Use tree-kill to kill the entire process tree
      kill(proc.pid, 'SIGTERM', (err) => {
        if (err) {
          // If SIGTERM fails, try SIGKILL
          kill(proc.pid, 'SIGKILL');
        }
      });
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
        if (proc.pid) {
          kill(proc.pid, 'SIGKILL');
        }
      } catch (err) {
        // Ignore
      }
    }
  }

  buildSelectionUI() {
    // Remove old container if it exists
    if (this.selectionContainer) {
      this.renderer.root.remove(this.selectionContainer);
      this.selectionContainer.destroy();
    }
    
    // Create container
    this.selectionContainer = new BoxRenderable(this.renderer, {
      id: 'selection-container',
      flexDirection: 'column',
      padding: 1,
    });
    
    // Create header
    this.headerText = new TextRenderable(this.renderer, {
      id: 'header',
      content: this.getHeaderText(),
      fg: '#00FFFF',
    });
    this.selectionContainer.add(this.headerText);
    
    // Empty line
    this.selectionContainer.add(new TextRenderable(this.renderer, {
      id: 'spacer',
      content: '',
    }));
    
    // Create script lines with colors
    // Starting Y position is: padding (1) + header (1) + spacer (1) = 3
    // But we need to account for 0-based indexing, so it's actually row 3 (0-indexed: 2)
    let currentY = 4; // padding + header + empty line + 1 for 1-based terminal coords
    this.scriptLinePositions = [];
    
    this.scriptLines = this.scripts.map((script, index) => {
      const isSelected = this.selectedScripts.has(script.name);
      const isFocused = index === this.selectedIndex;
      const prefix = isFocused ? '▶' : ' ';
      const checkbox = isSelected ? '✓' : ' ';
      const processColor = this.processColors.get(script.name) || '#FFFFFF';
      const prefixColor = isFocused ? '#00FFFF' : '#FFFFFF';
      
      // Build styled content
      const content = t`${fg(prefixColor)(prefix)} [${checkbox}] ${fg(processColor)(script.displayName)}`;
      
      const line = new TextRenderable(this.renderer, {
        id: `script-${index}`,
        content: content,
      });
      this.selectionContainer.add(line);
      this.scriptLinePositions.push(currentY);
      currentY++;
      return line;
    });
    
    this.renderer.root.add(this.selectionContainer);
  }
  
  getHeaderText() {
    return `Starting in ${this.countdown}s... [Click or Space to toggle, Enter to start, Ctrl+C to quit]`;
  }
  
  getScriptLineText(script, index) {
    const isSelected = this.selectedScripts.has(script.name);
    const isFocused = index === this.selectedIndex;
    const prefix = isFocused ? '▶' : ' ';
    const checkbox = isSelected ? '✓' : ' ';
    const processColor = this.processColors.get(script.name) || '#FFFFFF';
    
    // Use colored text for script name
    return t`${prefix} [${checkbox}] ${fg(processColor)(script.displayName)}`;
  }
  
  getScriptLineColor(index) {
    // Return base color for the line (prefix will be cyan when focused)
    return index === this.selectedIndex ? '#00FFFF' : '#FFFFFF';
  }
  
  updateSelectionUI() {
    // Rebuild the entire UI to update colors and selection state
    // This is simpler and more reliable with OpenTUI Core
    this.buildSelectionUI();
  }
  
  render() {
    if (this.phase === 'selection') {
      // For selection phase, just update the text content
      this.updateSelectionUI();
    } else if (this.phase === 'running') {
      // For running phase, only update output, don't rebuild entire UI
      this.updateRunningUI();
    }
  }

  getProcessListContent() {
    // Build process list content dynamically for any number of processes
    let contentString = '';
    
    this.scripts.forEach((script, index) => {
      const proc = this.processes.get(script.name);
      const status = proc?.status || 'stopped';
      const icon = status === 'running' ? '●' : status === 'crashed' ? '✖' : '○';
      const statusColor = status === 'running' ? '#00FF00' : status === 'crashed' ? '#FF0000' : '#666666';
      const processColor = this.processColors.get(script.name) || '#FFFFFF';
      const prefix = this.selectedIndex === index ? '▶' : '';
      
      // Build the colored string for this process
      if (index > 0) contentString += '  ';
      contentString += prefix + script.displayName + ' ' + icon;
    });
    
    return contentString;
  }
  
  updateRunningHeader() {
    // Update only the header and process list without rebuilding everything
    if (!this.headerRenderable || !this.processListRenderable || !this.runningContainer) {
      return;
    }
    
    // Update header (plain text works)
    const selectedScript = this.scripts[this.selectedIndex];
    const selectedName = selectedScript ? selectedScript.displayName : '';
    const pauseIndicator = this.isPaused ? ' [PAUSED]' : '';
    const filterIndicator = this.isFilterMode ? ` [FILTER: ${this.filter}_]` : (this.filter ? ` [FILTER: ${this.filter}]` : '');
    const headerText = `[←→: Navigate | Space: Pause | S: Stop | R: Restart | F: Filter Selected | /: Filter Text | Q: Quit] ${selectedName}${pauseIndicator}${filterIndicator}`;
    
    if (this.headerRenderable.setContent) {
      this.headerRenderable.setContent(headerText);
    }
    
    // For process list with styled text, we need to recreate it
    // Remove old one
    this.runningContainer.remove(this.processListRenderable);
    this.processListRenderable.destroy();
    
    // Create new process list with current selection
    let processContent;
    if (this.scripts.length === 1) {
      const script = this.scripts[0];
      const proc = this.processes.get(script.name);
      const status = proc?.status || 'stopped';
      const statusIcon = status === 'running' ? '●' : status === 'crashed' ? '✖' : '○';
      const statusColor = status === 'running' ? '#00FF00' : status === 'crashed' ? '#FF0000' : '#666666';
      const processColor = this.processColors.get(script.name) || '#FFFFFF';
      processContent = t`▶${fg(processColor)(script.displayName)} ${fg(statusColor)(statusIcon)}`;
    } else if (this.scripts.length === 2) {
      const s0 = this.scripts[0];
      const s1 = this.scripts[1];
      const proc0 = this.processes.get(s0.name);
      const proc1 = this.processes.get(s1.name);
      const status0 = proc0?.status || 'stopped';
      const status1 = proc1?.status || 'stopped';
      const icon0 = status0 === 'running' ? '●' : status0 === 'crashed' ? '✖' : '○';
      const icon1 = status1 === 'running' ? '●' : status1 === 'crashed' ? '✖' : '○';
      const color0 = status0 === 'running' ? '#00FF00' : status0 === 'crashed' ? '#FF0000' : '#666666';
      const color1 = status1 === 'running' ? '#00FF00' : status1 === 'crashed' ? '#FF0000' : '#666666';
      const pcolor0 = this.processColors.get(s0.name) || '#FFFFFF';
      const pcolor1 = this.processColors.get(s1.name) || '#FFFFFF';
      const prefix0 = this.selectedIndex === 0 ? '▶' : '';
      const prefix1 = this.selectedIndex === 1 ? '▶' : '';
      processContent = t`${prefix0}${fg(pcolor0)(s0.displayName)} ${fg(color0)(icon0)}  ${prefix1}${fg(pcolor1)(s1.displayName)} ${fg(color1)(icon1)}`;
    } else if (this.scripts.length === 3) {
      const s0 = this.scripts[0];
      const s1 = this.scripts[1];
      const s2 = this.scripts[2];
      const proc0 = this.processes.get(s0.name);
      const proc1 = this.processes.get(s1.name);
      const proc2 = this.processes.get(s2.name);
      const status0 = proc0?.status || 'stopped';
      const status1 = proc1?.status || 'stopped';
      const status2 = proc2?.status || 'stopped';
      const icon0 = status0 === 'running' ? '●' : status0 === 'crashed' ? '✖' : '○';
      const icon1 = status1 === 'running' ? '●' : status1 === 'crashed' ? '✖' : '○';
      const icon2 = status2 === 'running' ? '●' : status2 === 'crashed' ? '✖' : '○';
      const color0 = status0 === 'running' ? '#00FF00' : status0 === 'crashed' ? '#FF0000' : '#666666';
      const color1 = status1 === 'running' ? '#00FF00' : status1 === 'crashed' ? '#FF0000' : '#666666';
      const color2 = status2 === 'running' ? '#00FF00' : status2 === 'crashed' ? '#FF0000' : '#666666';
      const pcolor0 = this.processColors.get(s0.name) || '#FFFFFF';
      const pcolor1 = this.processColors.get(s1.name) || '#FFFFFF';
      const pcolor2 = this.processColors.get(s2.name) || '#FFFFFF';
      const prefix0 = this.selectedIndex === 0 ? '▶' : '';
      const prefix1 = this.selectedIndex === 1 ? '▶' : '';
      const prefix2 = this.selectedIndex === 2 ? '▶' : '';
      processContent = t`${prefix0}${fg(pcolor0)(s0.displayName)} ${fg(color0)(icon0)}  ${prefix1}${fg(pcolor1)(s1.displayName)} ${fg(color1)(icon1)}  ${prefix2}${fg(pcolor2)(s2.displayName)} ${fg(color2)(icon2)}`;
    } else {
      // 4+ processes - for now hardcode to 4, but should be dynamic
      const parts = this.scripts.slice(0, 4).map((script, idx) => {
        const proc = this.processes.get(script.name);
        const status = proc?.status || 'stopped';
        const icon = status === 'running' ? '●' : status === 'crashed' ? '✖' : '○';
        const color = status === 'running' ? '#00FF00' : status === 'crashed' ? '#FF0000' : '#666666';
        const pcolor = this.processColors.get(script.name) || '#FFFFFF';
        const prefix = this.selectedIndex === idx ? '▶' : '';
        return { prefix, name: script.displayName, icon, color, pcolor };
      });
      processContent = t`${parts[0].prefix}${fg(parts[0].pcolor)(parts[0].name)} ${fg(parts[0].color)(parts[0].icon)}  ${parts[1].prefix}${fg(parts[1].pcolor)(parts[1].name)} ${fg(parts[1].color)(parts[1].icon)}  ${parts[2].prefix}${fg(parts[2].pcolor)(parts[2].name)} ${fg(parts[2].color)(parts[2].icon)}  ${parts[3].prefix}${fg(parts[3].pcolor)(parts[3].name)} ${fg(parts[3].color)(parts[3].icon)}`;
    }
    
    // Create new process list renderable
    this.processListRenderable = new TextRenderable(this.renderer, {
      id: 'process-list',
      content: processContent,
    });
    
    // Insert it back in the right position (after header and spacer)
    // This is tricky - we need to insert at position 2
    // For now, just rebuild the whole UI since we can't easily insert
    this.buildRunningUI();
  }
  
  updateRunningUI() {
    // Just rebuild the entire UI - simpler and more reliable
    // OpenTUI doesn't have great incremental update support anyway
    this.buildRunningUI();
  }
  
  buildRunningUI() {
    // Remove old containers if they exist
    if (this.selectionContainer) {
      this.renderer.root.remove(this.selectionContainer);
      this.selectionContainer.destroy();
      this.selectionContainer = null;
    }
    if (this.runningContainer) {
      this.renderer.root.remove(this.runningContainer);
      this.runningContainer.destroy();
    }
    
    // Create main container - full screen
    const mainContainer = new BoxRenderable(this.renderer, {
      id: 'running-container',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      padding: 1,
    });
    
    // Header with status
    const selectedScript = this.scripts[this.selectedIndex];
    const selectedName = selectedScript ? selectedScript.displayName : '';
    const pauseIndicator = this.isPaused ? ' [PAUSED]' : '';
    const filterIndicator = this.isFilterMode ? ` [FILTER: ${this.filter}_]` : (this.filter ? ` [FILTER: ${this.filter}]` : '');
    const headerText = `[←→: Navigate | Space: Pause | S: Stop | R: Restart | F: Filter Selected | /: Filter Text | Q: Quit] ${selectedName}${pauseIndicator}${filterIndicator}`;
    this.headerRenderable = new TextRenderable(this.renderer, {
      id: 'running-header',
      content: headerText,
      fg: '#00FFFF',
    });
    mainContainer.add(this.headerRenderable);
    
    // Empty line
    mainContainer.add(new TextRenderable(this.renderer, {
      id: 'spacer1',
      content: '',
    }));
    
    // Track positions for mouse clicks
    let currentY = 4; // padding + header + spacer + 1 for 1-based coords
    this.scriptLinePositions = [];
    
    // Process list - compact horizontal layout with all processes
    // Create a container to hold all process items in a row
    const processListContainer = new BoxRenderable(this.renderer, {
      id: 'process-list-container',
      flexDirection: 'row',
      gap: 2,
    });
    
    // Add each process as a separate text element
    this.scripts.forEach((script, index) => {
      const proc = this.processes.get(script.name);
      const status = proc?.status || 'stopped';
      const icon = status === 'running' ? '●' : status === 'crashed' ? '✖' : '○';
      const statusColor = status === 'running' ? '#00FF00' : status === 'crashed' ? '#FF0000' : '#666666';
      const processColor = this.processColors.get(script.name) || '#FFFFFF';
      const prefix = this.selectedIndex === index ? '▶' : '';
      
      const processItem = new TextRenderable(this.renderer, {
        id: `process-item-${index}`,
        content: t`${prefix}${fg(processColor)(script.displayName)} ${fg(statusColor)(icon)}`,
      });
      processListContainer.add(processItem);
    });
    
    this.processListRenderable = processListContainer;
    mainContainer.add(this.processListRenderable);
    currentY++;
    
    // Empty line separator
    mainContainer.add(new TextRenderable(this.renderer, {
      id: 'spacer2',
      content: '',
    }));
    
    // Output section header
    const outputHeader = new TextRenderable(this.renderer, {
      id: 'output-header',
      content: 'Output',
      fg: '#00FFFF',
    });
    mainContainer.add(outputHeader);
    
    // Calculate available height for output
    // Header (1) + spacer (1) + process-list (1) + spacer (1) + output header (1) = 5 lines used
    const usedLines = 5;
    const availableHeight = Math.max(10, this.renderer.height - usedLines - 2); // -2 for padding
    
    // Create output container
    // Use ScrollBoxRenderable when paused (to allow scrolling), BoxRenderable when not paused
    if (this.outputBox) {
      this.outputBox.destroy();
    }
    
    if (this.isPaused) {
      // When paused, use ScrollBoxRenderable to allow scrolling through all history
      this.outputBox = new ScrollBoxRenderable(this.renderer, {
        id: 'output-box',
        flexGrow: 1,
        showScrollbar: true,  // Show scrollbar when paused
      });
    } else {
      // When not paused, use regular BoxRenderable (no scrollbar needed)
      this.outputBox = new BoxRenderable(this.renderer, {
        id: 'output-box',
        flexDirection: 'column',
        flexGrow: 1,
        overflow: 'hidden',
      });
    }
    
    // Add output lines to scrollbox in reverse order (newest first)
    const filteredLines = this.filter 
      ? this.outputLines.filter(line => 
          line.process.toLowerCase().includes(this.filter.toLowerCase()) || 
          line.text.toLowerCase().includes(this.filter.toLowerCase())
        )
      : this.outputLines;
    
    // Decide which lines to show
    let linesToShow;
    if (this.isPaused) {
      // When paused, show all lines (scrollable)
      linesToShow = filteredLines;
    } else {
      // When not paused, only show most recent N lines
      linesToShow = filteredLines.slice(-this.maxVisibleLines);
    }
    
    // Add lines in reverse order (newest first)
    for (let i = linesToShow.length - 1; i >= 0; i--) {
      const line = linesToShow[i];
      const processColor = this.processColors.get(line.process) || '#FFFFFF';
      
      // Truncate long lines to prevent wrapping (terminal width - prefix length - padding)
      const maxWidth = Math.max(40, this.renderer.width - line.process.length - 10);
      const truncatedText = line.text.length > maxWidth 
        ? line.text.substring(0, maxWidth - 3) + '...' 
        : line.text;
      
      const outputLine = new TextRenderable(this.renderer, {
        id: `output-${i}`,
        content: t`${fg(processColor)(`[${line.process}]`)} ${truncatedText}`,
      });
      this.outputBox.add(outputLine);
    }
    
    this.lastRenderedLineCount = filteredLines.length;
    this.wasPaused = this.isPaused;
    
    mainContainer.add(this.outputBox);
    
    this.renderer.root.add(mainContainer);
    this.runningContainer = mainContainer;
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
  
  // Handle cleanup on exit
  process.on('SIGINT', () => {
    manager.cleanup();
    renderer.destroy();
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
