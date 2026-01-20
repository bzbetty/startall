#!/usr/bin/env bun

import { createCliRenderer, TextRenderable, BoxRenderable, ScrollBoxRenderable, t, fg } from '@opentui/core';
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
    this.isPaused = false;  // Whether output scrolling is paused
    this.isFilterMode = false;  // Whether in filter input mode
    this.outputScrollBox = null;  // Reference to the scrollable output container
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
          // If paused, scroll the output; otherwise navigate processes
          if (this.isPaused && this.outputScrollBox) {
            // Scroll output up
            this.outputScrollBox.focus();
          } else {
            this.selectedIndex = Math.max(0, this.selectedIndex - 1);
            this.updateRunningHeader(); // Update only header and process list
          }
        } else if (keyName === 'down' || keyName === 'j') {
          if (this.isPaused && this.outputScrollBox) {
            // Scroll output down
            this.outputScrollBox.focus();
          } else {
            this.selectedIndex = Math.min(this.scripts.length - 1, this.selectedIndex + 1);
            this.updateRunningHeader(); // Update only header and process list
          }
        } else if (keyName === 'left' || keyName === 'h') {
          // Navigate processes left
          this.selectedIndex = Math.max(0, this.selectedIndex - 1);
          this.updateRunningHeader(); // Update only header and process list
        } else if (keyName === 'right' || keyName === 'l') {
          // Navigate processes right
          this.selectedIndex = Math.min(this.scripts.length - 1, this.selectedIndex + 1);
          this.updateRunningHeader(); // Update only header and process list
        } else if (keyName === 'pageup') {
          // Page up in output
          if (this.outputScrollBox) {
            this.isPaused = true;
            this.outputScrollBox.focus();
          }
        } else if (keyName === 'pagedown') {
          // Page down in output
          if (this.outputScrollBox) {
            this.isPaused = true;
            this.outputScrollBox.focus();
          }
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
    this.outputLines.push({
      process: processName,
      text,
      timestamp: Date.now(),
    });
    
    if (this.outputLines.length > this.maxOutputLines) {
      this.outputLines = this.outputLines.slice(-this.maxOutputLines);
    }
    
    // Render to update output
    this.render();
    
    // With reverse scroll (newest at top), no need to scroll anywhere
    // New messages appear at the top automatically
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
    if (!this.headerRenderable || !this.processListRenderable) {
      return;
    }
    
    // Update header
    const selectedScript = this.scripts[this.selectedIndex];
    const selectedName = selectedScript ? selectedScript.displayName : '';
    const pauseIndicator = this.isPaused ? ' [PAUSED]' : '';
    const filterIndicator = this.isFilterMode ? ` [FILTER: ${this.filter}_]` : (this.filter ? ` [FILTER: ${this.filter}]` : '');
    const headerText = `[←→: Navigate | Space: Pause | S: Stop | R: Restart | F: Filter Selected | /: Filter Text | Q: Quit] ${selectedName}${pauseIndicator}${filterIndicator}`;
    
    if (this.headerRenderable.setContent) {
      this.headerRenderable.setContent(headerText);
    }
    
    // Update process list
    const processContent = this.getProcessListContent();
    
    if (this.processListRenderable.setContent) {
      this.processListRenderable.setContent(processContent);
    }
    
    // Request a re-render to show the changes
    this.renderer.requestRender();
  }
  
  updateRunningUI() {
    // If running UI doesn't exist yet, build it
    if (!this.runningContainer || !this.outputScrollBox) {
      this.buildRunningUI();
      return;
    }
    
    // Only add new lines that haven't been rendered yet
    const filteredLines = this.filter 
      ? this.outputLines.filter(line => line.text.toLowerCase().includes(this.filter.toLowerCase()))
      : this.outputLines;
    
    // If filter changed, need to rebuild
    const currentFilteredCount = filteredLines.length;
    if (this.lastRenderedLineCount > currentFilteredCount) {
      // Filter was applied or changed, rebuild
      this.buildRunningUI();
      return;
    }
    
    // Add only new lines (in reverse order - newest first)
    const newLines = filteredLines.slice(this.lastRenderedLineCount);
    // Insert at the beginning in reverse order so newest is at top
    for (let i = newLines.length - 1; i >= 0; i--) {
      const line = newLines[i];
      const processColor = this.processColors.get(line.process) || '#FFFFFF';
      const outputLine = new TextRenderable(this.renderer, {
        id: `output-${this.lastRenderedLineCount + i}`,
        content: t`${fg(processColor)(`[${line.process}]`)} ${line.text}`,
      });
      // Insert at beginning instead of end
      if (this.outputScrollBox.children && this.outputScrollBox.children.length > 0) {
        // Insert at position 0
        const firstChild = this.outputScrollBox.children[0];
        this.outputScrollBox.insertBefore(outputLine, firstChild);
      } else {
        this.outputScrollBox.add(outputLine);
      }
    }
    
    this.lastRenderedLineCount = currentFilteredCount;
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
    
    // Process list - compact layout with colors
    // Build the styled text using template literal properly
    let processContent;
    if (this.scripts.length === 0) {
      processContent = 'No processes';
    } else if (this.scripts.length === 1) {
      const script = this.scripts[0];
      const proc = this.processes.get(script.name);
      const status = proc?.status || 'stopped';
      const statusIcon = status === 'running' ? '●' : status === 'crashed' ? '✖' : status === 'exited' ? '○' : '○';
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
      // 4+ processes
      const s0 = this.scripts[0];
      const s1 = this.scripts[1];
      const s2 = this.scripts[2];
      const s3 = this.scripts[3];
      const proc0 = this.processes.get(s0.name);
      const proc1 = this.processes.get(s1.name);
      const proc2 = this.processes.get(s2.name);
      const proc3 = this.processes.get(s3.name);
      const status0 = proc0?.status || 'stopped';
      const status1 = proc1?.status || 'stopped';
      const status2 = proc2?.status || 'stopped';
      const status3 = proc3?.status || 'stopped';
      const icon0 = status0 === 'running' ? '●' : status0 === 'crashed' ? '✖' : '○';
      const icon1 = status1 === 'running' ? '●' : status1 === 'crashed' ? '✖' : '○';
      const icon2 = status2 === 'running' ? '●' : status2 === 'crashed' ? '✖' : '○';
      const icon3 = status3 === 'running' ? '●' : status3 === 'crashed' ? '✖' : '○';
      const color0 = status0 === 'running' ? '#00FF00' : status0 === 'crashed' ? '#FF0000' : '#666666';
      const color1 = status1 === 'running' ? '#00FF00' : status1 === 'crashed' ? '#FF0000' : '#666666';
      const color2 = status2 === 'running' ? '#00FF00' : status2 === 'crashed' ? '#FF0000' : '#666666';
      const color3 = status3 === 'running' ? '#00FF00' : status3 === 'crashed' ? '#FF0000' : '#666666';
      const pcolor0 = this.processColors.get(s0.name) || '#FFFFFF';
      const pcolor1 = this.processColors.get(s1.name) || '#FFFFFF';
      const pcolor2 = this.processColors.get(s2.name) || '#FFFFFF';
      const pcolor3 = this.processColors.get(s3.name) || '#FFFFFF';
      const prefix0 = this.selectedIndex === 0 ? '▶' : '';
      const prefix1 = this.selectedIndex === 1 ? '▶' : '';
      const prefix2 = this.selectedIndex === 2 ? '▶' : '';
      const prefix3 = this.selectedIndex === 3 ? '▶' : '';
      processContent = t`${prefix0}${fg(pcolor0)(s0.displayName)} ${fg(color0)(icon0)}  ${prefix1}${fg(pcolor1)(s1.displayName)} ${fg(color1)(icon1)}  ${prefix2}${fg(pcolor2)(s2.displayName)} ${fg(color2)(icon2)}  ${prefix3}${fg(pcolor3)(s3.displayName)} ${fg(color3)(icon3)}`;
    }
    
    this.processListRenderable = new TextRenderable(this.renderer, {
      id: 'process-list',
      content: processContent,
    });
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
    
    // Create scrollable output container
    if (this.outputScrollBox) {
      this.outputScrollBox.destroy();
    }
    
    this.outputScrollBox = new ScrollBoxRenderable(this.renderer, {
      id: 'output-scrollbox',
      height: availableHeight,
      flexGrow: 1,
      showScrollbar: true,
      scrollbarOptions: {
        showArrows: true,
        trackOptions: {
          foregroundColor: '#7aa2f7',
          backgroundColor: '#414868',
        },
      },
    });
    
    // Add output lines to scrollbox in reverse order (newest first)
    const filteredLines = this.filter 
      ? this.outputLines.filter(line => line.text.toLowerCase().includes(this.filter.toLowerCase()))
      : this.outputLines;
    
    // Add lines in reverse order so newest appears at top
    for (let i = filteredLines.length - 1; i >= 0; i--) {
      const line = filteredLines[i];
      const processColor = this.processColors.get(line.process) || '#FFFFFF';
      const outputLine = new TextRenderable(this.renderer, {
        id: `output-${i}`,
        content: t`${fg(processColor)(`[${line.process}]`)} ${line.text}`,
      });
      this.outputScrollBox.add(outputLine);
    }
    
    this.lastRenderedLineCount = filteredLines.length;
    
    mainContainer.add(this.outputScrollBox);
    
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
