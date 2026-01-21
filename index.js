#!/usr/bin/env bun

import { createCliRenderer, TextRenderable, BoxRenderable, ScrollBoxRenderable, t, fg } from '@opentui/core';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import kill from 'tree-kill';
import stripAnsi from 'strip-ansi';

// Configuration
const CONFIG_FILE = process.argv[2] || 'startall.json';
const COUNTDOWN_SECONDS = 10;

// Read version from package.json
function getAppVersion() {
  try {
    const packagePath = new URL('./package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    return `v${pkg.version}`;
  } catch (error) {
    return 'v0.0.0'; // Fallback if package.json can't be read
  }
}
const APP_VERSION = getAppVersion();

// Detect if running inside VS Code's integrated terminal
const IS_VSCODE = process.env.TERM_PROGRAM === 'vscode';

// VSCode-specific optimizations
const VSCODE_CONFIG = {
  // VSCode terminal has better mouse support
  enhancedMouse: IS_VSCODE,
  // VSCode can detect and linkify file paths (file:///path/to/file.js:line:col)
  fileLinking: IS_VSCODE,
  // Some key combinations are captured by VSCode
  remapKeys: IS_VSCODE,
};

// Pane ID generator
let paneIdCounter = 0;
function generatePaneId() {
  return `pane-${++paneIdCounter}`;
}

// Create a new pane node
function createPane(processes = []) {
  return {
    type: 'pane',
    id: generatePaneId(),
    name: '', // Custom name for the pane
    processes: processes, // Array of process names shown in this pane (empty = all)
    hidden: [], // Array of process names to hide from this pane
    filter: '', // Text filter for this pane
    colorFilter: null, // Color filter: 'red', 'yellow', 'green', 'blue', 'cyan', 'magenta', or null
    isPaused: false,
    scrollOffset: 0,
  };
}

// Create a split node
function createSplit(direction, children) {
  return {
    type: 'split',
    direction: direction, // 'horizontal' (top/bottom) or 'vertical' (left/right)
    children: children,
    sizes: children.map(() => 1), // Equal sizes by default (flex ratios)
  };
}

// Find a pane by ID in the tree
function findPaneById(node, id) {
  if (!node) return null;
  if (node.type === 'pane') {
    return node.id === id ? node : null;
  }
  for (const child of node.children) {
    const found = findPaneById(child, id);
    if (found) return found;
  }
  return null;
}

// Find all pane IDs in order (for navigation)
function getAllPaneIds(node, ids = []) {
  if (!node) return ids;
  if (node.type === 'pane') {
    ids.push(node.id);
  } else {
    for (const child of node.children) {
      getAllPaneIds(child, ids);
    }
  }
  return ids;
}

// Get ANSI color codes for a color name (includes normal and bright variants)
function getAnsiColorCodes(colorName) {
  const colorMap = {
    red: [31, 91],      // normal red, bright red
    yellow: [33, 93],   // normal yellow, bright yellow (warnings)
    green: [32, 92],    // normal green, bright green
    blue: [34, 94],     // normal blue, bright blue
    cyan: [36, 96],     // normal cyan, bright cyan
    magenta: [35, 95],  // normal magenta, bright magenta
  };
  return colorMap[colorName] || [];
}

// Check if a line contains a specific ANSI color
function lineHasColor(text, colorName) {
  const codes = getAnsiColorCodes(colorName);
  // Match ANSI escape sequences like \x1b[31m, \x1b[91m, \x1b[1;31m, etc.
  for (const code of codes) {
    // Check for direct color code: \x1b[31m
    if (text.includes(`\x1b[${code}m`)) return true;
    // Check for color with modifiers: \x1b[1;31m, \x1b[0;31m, etc.
    if (text.includes(`;${code}m`)) return true;
    // Check for color at start of sequence: \x1b[31;1m
    if (text.includes(`\x1b[${code};`)) return true;
  }
  return false;
}

// Find parent of a node
function findParent(root, targetId, parent = null) {
  if (!root) return null;
  if (root.type === 'pane') {
    return root.id === targetId ? parent : null;
  }
  for (const child of root.children) {
    if (child.type === 'pane' && child.id === targetId) {
      return root;
    }
    const found = findParent(child, targetId, root);
    if (found) return found;
  }
  return null;
}

// Split a pane in a given direction
function splitPane(root, paneId, direction) {
  if (!root) return root;
  
  if (root.type === 'pane') {
    if (root.id === paneId) {
      // Split this pane - new pane inherits processes from current
      const newPane = createPane([...root.processes]);
      return createSplit(direction, [root, newPane]);
    }
    return root;
  }
  
  // It's a split node - recurse into children
  const newChildren = root.children.map(child => splitPane(child, paneId, direction));
  
  // Check if any child was replaced with a split of same direction - flatten it
  const flattenedChildren = [];
  const flattenedSizes = [];
  newChildren.forEach((child, idx) => {
    if (child.type === 'split' && child.direction === root.direction && child !== root.children[idx]) {
      // Flatten: add the new split's children directly
      flattenedChildren.push(...child.children);
      const sizePerChild = root.sizes[idx] / child.children.length;
      flattenedSizes.push(...child.children.map(() => sizePerChild));
    } else {
      flattenedChildren.push(child);
      flattenedSizes.push(root.sizes[idx]);
    }
  });
  
  return {
    ...root,
    children: flattenedChildren,
    sizes: flattenedSizes,
  };
}

// Close a pane (remove it from the tree)
function closePane(root, paneId) {
  if (!root) return null;
  
  if (root.type === 'pane') {
    return root.id === paneId ? null : root;
  }
  
  // Find and remove the pane
  const newChildren = root.children
    .map(child => closePane(child, paneId))
    .filter(child => child !== null);
  
  if (newChildren.length === 0) {
    return null;
  }
  if (newChildren.length === 1) {
    // Unwrap single child
    return newChildren[0];
  }
  
  // Recalculate sizes for remaining children
  const originalIndices = [];
  root.children.forEach((child, idx) => {
    const closed = closePane(child, paneId);
    if (closed !== null) {
      originalIndices.push(idx);
    }
  });
  
  const newSizes = originalIndices.map(idx => root.sizes[idx]);
  // Normalize sizes
  const total = newSizes.reduce((a, b) => a + b, 0);
  const normalizedSizes = newSizes.map(s => s / total * newChildren.length);
  
  return {
    ...root,
    children: newChildren,
    sizes: normalizedSizes,
  };
}

// Serialize pane tree for saving to config (strip runtime state)
function serializePaneTree(node) {
  if (!node) return null;
  
  if (node.type === 'pane') {
    return {
      type: 'pane',
      name: node.name || '',
      processes: node.processes || [],
      hidden: node.hidden || [],
      filter: node.filter || '',
      colorFilter: node.colorFilter || null,
    };
  }
  
  return {
    type: 'split',
    direction: node.direction,
    sizes: node.sizes,
    children: node.children.map(child => serializePaneTree(child)),
  };
}

// Deserialize pane tree from config (restore with fresh IDs)
function deserializePaneTree(data) {
  if (!data) return null;
  
  if (data.type === 'pane') {
    const pane = createPane(data.processes || []);
    pane.name = data.name || '';
    pane.hidden = data.hidden || [];
    pane.filter = data.filter || '';
    pane.colorFilter = data.colorFilter || null;
    return pane;
  }
  
  return {
    type: 'split',
    direction: data.direction,
    sizes: data.sizes || data.children.map(() => 1),
    children: data.children.map(child => deserializePaneTree(child)),
  };
}

// Color palette (inspired by Tokyo Night theme)
const COLORS = {
  border: '#3b4261',
  borderFocused: '#7aa2f7',
  bg: '#1a1b26',
  bgLight: '#24283b',
  bgHighlight: '#292e42',
  text: '#c0caf5',
  textDim: '#565f89',
  accent: '#7aa2f7',
  success: '#9ece6a',
  error: '#f7768e',
  warning: '#e0af68',
  cyan: '#7dcfff',
  magenta: '#bb9af7',
};

// Match string against pattern with wildcard support
function matchesPattern(str, pattern) {
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  return regex.test(str);
}

function isIncluded(name, includePatterns) {
  if (!includePatterns) return true;
  return includePatterns.some(pattern => matchesPattern(name, pattern));
}

function isIgnored(name, ignorePatterns) {
  return ignorePatterns.some(pattern => matchesPattern(name, pattern));
}

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

// Load config
function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      return { defaultSelection: [], ignore: [], shortcuts: {} };
    }
  }
  return { defaultSelection: [], ignore: [], shortcuts: {} };
}

// Save config
function saveConfig(config) {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error saving config:', error.message);
  }
}

// Process Manager
class ProcessManager {
  constructor(renderer, scripts) {
    this.renderer = renderer;
    this.config = loadConfig();
    this.allScripts = scripts;  // Keep reference to all scripts (unfiltered)
    this.scripts = scripts
      .filter(s => isIncluded(s.name, this.config.include))
      .filter(s => !isIgnored(s.name, this.config.ignore || []));
    this.phase = 'selection'; // 'selection' | 'running' | 'settings'
    this.selectedScripts = new Set(this.config.defaultSelection);
    this.countdown = COUNTDOWN_SECONDS;
    this.selectedIndex = 0;
    this.processes = new Map();
    this.processRefs = new Map();
    this.outputLines = [];
    this.totalLinesReceived = 0;  // Track total lines ever received (never resets)
    this.filter = '';
    this.maxOutputLines = 1000;
    this.maxVisibleLines = null;  // Calculated dynamically based on screen height
    this.isPaused = false;  // Whether output scrolling is paused
    this.wasPaused = false;  // Track previous pause state to detect changes
    this.isFilterMode = false;  // Whether in filter input mode
    this.isNamingMode = false;  // Whether in pane naming input mode
    this.namingModeText = '';  // Text being typed for pane name
    this.showLineNumbers = this.config.showLineNumbers !== undefined ? this.config.showLineNumbers : true;  // Whether to show line numbers
    this.showTimestamps = this.config.showTimestamps !== undefined ? this.config.showTimestamps : false;  // Whether to show timestamps
    this.isInputMode = false;  // Whether in stdin input mode
    this.inputModeText = '';  // Text being typed for stdin
    
    // Settings menu state
    this.settingsSection = 'display';  // 'display' | 'ignore' | 'include' | 'scripts' | 'shortcuts'
    this.settingsIndex = 0;  // Current selection index within section
    this.isAddingPattern = false;  // Whether typing a new pattern
    this.newPatternText = '';  // Text being typed for new pattern
    this.isAssigningShortcut = false;  // Whether waiting for a key to assign as shortcut
    this.shortcutScriptName = '';  // Script name being assigned a shortcut
    this.settingsContainer = null;  // UI reference
    this.previousPhase = 'selection';  // Track where we came from
    
    // Command execution overlay state
    this.showCommandOverlay = false;  // Whether command output overlay is visible
    this.commandOverlayOutput = [];  // Output lines from command
    this.commandOverlayScript = '';  // Script name being executed
    this.commandOverlayStatus = 'running';  // 'running' | 'exited' | 'crashed'
    this.commandOverlayProcess = null;  // Process reference
    
    // Run command modal state
    this.showRunCommandModal = false;  // Whether the run command picker is visible
    this.runCommandModalIndex = 0;  // Selected index in the modal
    this.outputBox = null;  // Reference to the output container
    this.destroyed = false;  // Flag to prevent operations after cleanup
    this.lastRenderedLineCount = 0;  // Track how many lines we've rendered
    this.headerRenderable = null;  // Reference to header text in running UI
    this.processListRenderable = null;  // Reference to process list text in running UI
    this.renderScheduled = false;  // Throttle renders for CPU efficiency
    
    // Split pane state
    this.paneRoot = null;  // Root of pane tree (initialized when running starts)
    this.focusedPaneId = null;  // ID of currently focused pane
    this.splitMode = false;  // Whether waiting for split command after Ctrl+b
    this.showSplitMenu = false;  // Whether to show the command palette
    this.splitMenuIndex = 0;  // Selected item in split menu
    this.paneScrollPositions = new Map();  // Store scroll positions per pane ID
    this.paneScrollBoxes = new Map();  // Store ScrollBox references per pane ID
    this.paneFilterState = new Map();  // Track filter state per pane to detect changes
    this.paneLineCount = new Map();  // Track how many lines we've rendered per pane
    
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
          // Reset countdown when selection changes
          this.countdown = COUNTDOWN_SECONDS;
        }
      } else if (keyName === 'o') {
        // Open settings menu (options)
        clearInterval(this.countdownInterval);
        this.previousPhase = 'selection';
        this.phase = 'settings';
        this.settingsSection = 'display';
        this.settingsIndex = 0;
        this.buildSettingsUI();
        return;
      } else if (keyName >= '1' && keyName <= '9') {
        // Toggle script by number (1-9)
        const index = parseInt(keyName) - 1;
        if (index >= 0 && index < this.scripts.length) {
          const scriptName = this.scripts[index]?.name;
          if (scriptName) {
            if (this.selectedScripts.has(scriptName)) {
              this.selectedScripts.delete(scriptName);
            } else {
              this.selectedScripts.add(scriptName);
            }
            // Reset countdown when selection changes
            this.countdown = COUNTDOWN_SECONDS;
          }
        }
      }
    } else if (this.phase === 'settings') {
      this.handleSettingsInput(keyName, keyEvent);
      return;
    } else if (this.phase === 'running') {
      // Handle command overlay
      if (this.showCommandOverlay) {
        if (keyName === 'escape') {
          this.closeCommandOverlay();
          this.buildRunningUI();
        }
        return;
      }
      
      // Handle run command modal
      if (this.showRunCommandModal) {
        this.handleRunCommandModalInput(keyName, keyEvent);
        return;
      }
      
      // Handle split menu
      if (this.showSplitMenu) {
        this.handleSplitMenuInput(keyName, keyEvent);
        return;
      }
      
      // If in input mode (stdin), handle stdin input
      if (this.isInputMode) {
        const scriptName = this.scripts[this.selectedIndex]?.name;
        if (keyName === 'escape') {
          this.isInputMode = false;
          this.inputModeText = '';
          this.buildRunningUI();
        } else if (keyName === 'enter' || keyName === 'return') {
          // Send the input to the selected process
          if (scriptName && this.inputModeText.trim()) {
            this.sendInputToProcess(scriptName, this.inputModeText + '\n');
          }
          this.isInputMode = false;
          this.inputModeText = '';
          this.buildRunningUI();
        } else if (keyName === 'backspace') {
          this.inputModeText = this.inputModeText.slice(0, -1);
          this.buildRunningUI();
        } else if (keyName === 'space') {
          this.inputModeText += ' ';
          this.buildRunningUI();
        } else if (keyName && keyName.length === 1 && !keyEvent.ctrl && !keyEvent.meta) {
          this.inputModeText += keyName;
          this.buildRunningUI();
        }
      }
      // If in naming mode, handle name input
      else if (this.isNamingMode) {
        const pane = findPaneById(this.paneRoot, this.focusedPaneId);
        if (keyName === 'escape') {
          this.isNamingMode = false;
          this.namingModeText = '';
          this.buildRunningUI(); // Rebuild to cancel naming
        } else if (keyName === 'enter' || keyName === 'return') {
          if (pane) {
            pane.name = this.namingModeText;
            this.savePaneLayout(); // Save the new name
          }
          this.isNamingMode = false;
          this.namingModeText = '';
          this.buildRunningUI(); // Rebuild with new name
        } else if (keyName === 'backspace') {
          this.namingModeText = this.namingModeText.slice(0, -1);
          this.buildRunningUI(); // Update UI to show name change
        } else if (keyName && keyName.length === 1 && !keyEvent.ctrl && !keyEvent.meta) {
          this.namingModeText += keyName;
          this.buildRunningUI(); // Update UI to show name change
        }
      }
      // If in filter mode, handle filter input
      else if (this.isFilterMode) {
        const pane = findPaneById(this.paneRoot, this.focusedPaneId);
        if (keyName === 'escape') {
          this.isFilterMode = false;
          if (pane) pane.filter = '';
          this.buildRunningUI(); // Rebuild to clear filter
        } else if (keyName === 'enter' || keyName === 'return') {
          this.isFilterMode = false;
          this.buildRunningUI(); // Rebuild with filter
        } else if (keyName === 'backspace') {
          if (pane) pane.filter = (pane.filter || '').slice(0, -1);
          this.buildRunningUI(); // Update UI to show filter change
        } else if (keyName && keyName.length === 1 && !keyEvent.ctrl && !keyEvent.meta) {
          if (pane) pane.filter = (pane.filter || '') + keyName;
          this.buildRunningUI(); // Update UI to show filter change
        }
      } else {
        // Normal mode - handle commands
        if (keyName === 'q') {
          this.savePaneLayout();
          this.cleanup();
          this.renderer.destroy();
        } else if (keyName === '\\') {
          // Open split/pane menu (VSCode-friendly alternative to Ctrl+b)
          this.showSplitMenu = true;
          this.splitMenuIndex = 0;
          this.buildRunningUI();
        } else if (keyName === '|') {
          // Quick vertical split
          this.splitCurrentPane('vertical');
          this.buildRunningUI();
        } else if (keyName === '_') {
          // Quick horizontal split
          this.splitCurrentPane('horizontal');
          this.buildRunningUI();
        } else if (keyName === 'x' && getAllPaneIds(this.paneRoot).length > 1) {
          // Close current pane (only if more than one)
          this.closeCurrentPane();
          this.buildRunningUI();
        } else if (keyName === 'space') {
          // Toggle visibility of selected process in focused pane
          this.toggleProcessVisibility();
          this.buildRunningUI();
        } else if (keyName === 'p') {
          // Toggle pause output scrolling globally
          this.isPaused = !this.isPaused;
          this.updateStreamPauseState();
          this.buildRunningUI();
        } else if (keyName === 'f') {
          // Filter focused pane to currently selected process
          const scriptName = this.scripts[this.selectedIndex]?.name;
          const pane = findPaneById(this.paneRoot, this.focusedPaneId);
          if (scriptName && pane) {
            pane.filter = scriptName;
            this.buildRunningUI(); // Rebuild to apply filter
          }
        } else if (keyName === '/') {
          // Enter filter mode for focused pane
          this.isFilterMode = true;
          const pane = findPaneById(this.paneRoot, this.focusedPaneId);
          if (pane) pane.filter = '';
        } else if (keyName === 'n') {
          // Enter naming mode for focused pane
          this.isNamingMode = true;
          const pane = findPaneById(this.paneRoot, this.focusedPaneId);
          this.namingModeText = pane?.name || '';
          this.buildRunningUI(); // Rebuild to show naming input
        } else if (keyName === 'escape') {
          // Clear filter on focused pane
          const pane = findPaneById(this.paneRoot, this.focusedPaneId);
          if (pane) pane.filter = '';
          this.isPaused = false;
          this.updateStreamPauseState();
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
          // Navigate processes left with wrapping
          this.selectedIndex = this.selectedIndex - 1;
          if (this.selectedIndex < 0) {
            this.selectedIndex = this.scripts.length - 1;
          }
          this.buildRunningUI(); // Rebuild to show selection change
        } else if (keyName === 'right' || keyName === 'l') {
          // Navigate processes right with wrapping
          this.selectedIndex = (this.selectedIndex + 1) % this.scripts.length;
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
        } else if (keyName === 'o') {
      // Open settings (options)
      this.previousPhase = 'running';
      this.phase = 'settings';
      this.settingsSection = 'display';
      this.settingsIndex = 0;
      this.buildSettingsUI();
      return;
        } else if (keyName === 'c') {
          // Cycle color filter on focused pane
          const pane = findPaneById(this.paneRoot, this.focusedPaneId);
          if (pane) {
            const colors = [null, 'red', 'yellow', 'green', 'blue', 'cyan', 'magenta'];
            const currentIndex = colors.indexOf(pane.colorFilter);
            pane.colorFilter = colors[(currentIndex + 1) % colors.length];
            this.buildRunningUI();
          }
        } else if (keyName === 'tab') {
          // Navigate to next pane
          this.navigateToNextPane(1);
          this.buildRunningUI();
        } else if (keyEvent.shift && keyName === 'tab') {
          // Navigate to previous pane
          this.navigateToNextPane(-1);
          this.buildRunningUI();
        } else if (keyName === 'home') {
          // Scroll to top of focused pane
          this.scrollFocusedPane('home');
        } else if (keyName === 'end') {
          // Scroll to bottom of focused pane
          this.scrollFocusedPane('end');
        } else if (keyName === 'pageup') {
          // Scroll up one page in focused pane
          this.scrollFocusedPane('pageup');
        } else if (keyName === 'pagedown') {
          // Scroll down one page in focused pane
          this.scrollFocusedPane('pagedown');
        } else if (keyName >= '1' && keyName <= '9') {
          // Toggle process by number (1-9)
          const index = parseInt(keyName) - 1;
          if (index >= 0 && index < this.scripts.length) {
            this.selectedIndex = index;
            this.toggleProcessVisibility();
            this.buildRunningUI();
          }
        } else if (keyName === 'i') {
          // Enter input mode to send stdin to selected process
          const scriptName = this.scripts[this.selectedIndex]?.name;
          const proc = this.processes.get(scriptName);
          if (scriptName && proc?.status === 'running') {
            this.isInputMode = true;
            this.inputModeText = '';
            this.buildRunningUI();
          }
        } else if (keyName === 'e') {
          // Open run command modal
          this.showRunCommandModal = true;
          this.runCommandModalIndex = 0;
          this.buildRunningUI();
        } else if (keyName && keyName.length === 1 && !keyEvent.ctrl && !keyEvent.meta && !keyEvent.shift) {
          // Check if this key is a custom shortcut
          const shortcuts = this.config.shortcuts || {};
          const scriptName = shortcuts[keyName];
          if (scriptName) {
            // Find the script in allScripts (since it might be ignored/filtered out)
            const script = this.allScripts.find(s => s.name === scriptName);
            if (script) {
              this.executeCommand(scriptName);
            }
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
            // Reset countdown when selection changes
            this.countdown = COUNTDOWN_SECONDS;
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
    
    this.config.defaultSelection = selected;
    saveConfig(this.config);
    this.phase = 'running';
    this.selectedIndex = 0;
    
    // Load pane layout from config or create default
    if (this.config.paneLayout) {
      this.paneRoot = deserializePaneTree(this.config.paneLayout);
    } else {
      this.paneRoot = createPane([]); // Empty array means show all processes
    }
    this.focusedPaneId = this.paneRoot.id;
    
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
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          this.addOutputLine(scriptName, line);
        }
      });
    });

    proc.on('exit', (code) => {
      const status = code === 0 ? 'exited' : 'crashed';
      this.processes.set(scriptName, { status, exitCode: code });
      this.addOutputLine(scriptName, `Process exited with code ${code}`);
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
      lineNumber: ++this.totalLinesReceived,  // Track absolute line number
    });
    
    if (this.outputLines.length > this.maxOutputLines) {
      this.outputLines = this.outputLines.slice(-this.maxOutputLines);
    }
    
    // Only render if not paused - this prevents new output from appearing
    // when the user is reviewing history
    if (!this.isPaused) {
      this.scheduleRender();
    }
  }
  
  scheduleRender() {
    // Update the DOM - OpenTUI's render loop will pick up changes automatically
    if (!this.destroyed) {
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
  
  sendInputToProcess(scriptName, input) {
    const proc = this.processRefs.get(scriptName);
    if (proc && proc.stdin && proc.stdin.writable) {
      try {
        proc.stdin.write(input);
        // Echo the input in the output for visibility
        this.addOutputLine(scriptName, `> ${input.trim()}`);
      } catch (err) {
        this.addOutputLine(scriptName, `Error sending input: ${err.message}`);
      }
    }
  }

  handleSettingsInput(keyName, keyEvent) {
    // Handle shortcut assignment mode
    if (this.isAssigningShortcut) {
      if (keyName === 'escape') {
        this.isAssigningShortcut = false;
        this.shortcutScriptName = '';
        this.buildSettingsUI();
        return;
      } else if (keyName && keyName.length === 1 && !keyEvent.ctrl && !keyEvent.meta && !keyEvent.shift) {
        // Assign this key to the script
        if (!this.config.shortcuts) this.config.shortcuts = {};
        
        // Remove any existing shortcut for this script (one key per script)
        for (const [key, scriptName] of Object.entries(this.config.shortcuts)) {
          if (scriptName === this.shortcutScriptName) {
            delete this.config.shortcuts[key];
          }
        }
        
        // Also remove this key if it's assigned to another script (one script per key)
        if (this.config.shortcuts[keyName]) {
          delete this.config.shortcuts[keyName];
        }
        
        // Assign the new shortcut
        this.config.shortcuts[keyName] = this.shortcutScriptName;
        saveConfig(this.config);
        this.isAssigningShortcut = false;
        this.shortcutScriptName = '';
        this.buildSettingsUI();
        return;
      }
      return;
    }
    
    // Handle text input mode for adding patterns
    if (this.isAddingPattern) {
      if (keyName === 'escape') {
        this.isAddingPattern = false;
        this.newPatternText = '';
        this.buildSettingsUI();
      } else if (keyName === 'enter' || keyName === 'return') {
        if (this.newPatternText.trim()) {
          // Add the pattern to the appropriate list
          if (this.settingsSection === 'ignore') {
            if (!this.config.ignore) this.config.ignore = [];
            this.config.ignore.push(this.newPatternText.trim());
          } else if (this.settingsSection === 'include') {
            if (!this.config.include) this.config.include = [];
            this.config.include.push(this.newPatternText.trim());
          }
          saveConfig(this.config);
          this.applyFilters();
        }
        this.isAddingPattern = false;
        this.newPatternText = '';
        this.buildSettingsUI();
      } else if (keyName === 'backspace') {
        this.newPatternText = this.newPatternText.slice(0, -1);
        this.buildSettingsUI();
      } else if (keyName && keyName.length === 1 && !keyEvent.ctrl && !keyEvent.meta) {
        this.newPatternText += keyName;
        this.buildSettingsUI();
      }
      return;
    }
    
    // Normal settings navigation
    if (keyName === 'escape' || keyName === 'q') {
      // Apply filters before returning (updates this.scripts)
      this.applyFilters();
      
      // Ensure selectedIndex is within bounds after filter changes
      if (this.selectedIndex >= this.scripts.length) {
        this.selectedIndex = Math.max(0, this.scripts.length - 1);
      }
      
      // Return to previous phase
      if (this.previousPhase === 'running') {
        this.phase = 'running';
        this.buildRunningUI();
      } else {
        this.phase = 'selection';
        this.buildSelectionUI();
        this.countdown = COUNTDOWN_SECONDS;
        this.startCountdown();
      }
    } else if (keyName === 'tab' || keyName === 'right') {
      // Switch section
      const sections = ['display', 'ignore', 'include', 'shortcuts', 'scripts'];
      const idx = sections.indexOf(this.settingsSection);
      this.settingsSection = sections[(idx + 1) % sections.length];
      this.settingsIndex = 0;
      this.buildSettingsUI();
    } else if (keyEvent.shift && keyName === 'tab') {
      // Switch section backwards
      const sections = ['display', 'ignore', 'include', 'shortcuts', 'scripts'];
      const idx = sections.indexOf(this.settingsSection);
      this.settingsSection = sections[(idx - 1 + sections.length) % sections.length];
      this.settingsIndex = 0;
      this.buildSettingsUI();
    } else if (keyName === 'left') {
      // Switch section backwards
      const sections = ['display', 'ignore', 'include', 'shortcuts', 'scripts'];
      const idx = sections.indexOf(this.settingsSection);
      this.settingsSection = sections[(idx - 1 + sections.length) % sections.length];
      this.settingsIndex = 0;
      this.buildSettingsUI();
    } else if (keyName === 'up') {
      if (this.settingsIndex > 0) {
        this.settingsIndex--;
        this.buildSettingsUI();
      } else {
        // Move to previous section
        const sections = ['display', 'ignore', 'include', 'shortcuts', 'scripts'];
        const idx = sections.indexOf(this.settingsSection);
        if (idx > 0) {
          this.settingsSection = sections[idx - 1];
          this.settingsIndex = this.getSettingsMaxIndex();
          this.buildSettingsUI();
        }
      }
    } else if (keyName === 'down') {
      const maxIndex = this.getSettingsMaxIndex();
      if (this.settingsIndex < maxIndex) {
        this.settingsIndex++;
        this.buildSettingsUI();
      } else {
        // Move to next section
        const sections = ['display', 'ignore', 'include', 'shortcuts', 'scripts'];
        const idx = sections.indexOf(this.settingsSection);
        if (idx < sections.length - 1) {
          this.settingsSection = sections[idx + 1];
          this.settingsIndex = 0;
          this.buildSettingsUI();
        }
      }
    } else if (keyName === 'i') {
      // Add new ignore pattern
      this.settingsSection = 'ignore';
      this.isAddingPattern = true;
      this.newPatternText = '';
      this.buildSettingsUI();
    } else if (keyName === 'n') {
      // Add new include pattern
      this.settingsSection = 'include';
      this.isAddingPattern = true;
      this.newPatternText = '';
      this.buildSettingsUI();
    } else if (keyName === 'd' || keyName === 'backspace') {
      // Delete selected pattern or shortcut
      this.deleteSelectedItem();
      this.buildSettingsUI();
    } else if (keyName === 'space' || keyName === 'enter' || keyName === 'return') {
      // Toggle display options, script visibility, or assign shortcut
      if (this.settingsSection === 'display') {
        this.toggleDisplayOption();
        this.buildSettingsUI();
      } else if (this.settingsSection === 'shortcuts') {
        this.assignShortcut();
      } else if (this.settingsSection === 'scripts') {
        this.toggleScriptIgnore();
        this.buildSettingsUI();
      }
    }
  }
  
  getSettingsMaxIndex() {
    if (this.settingsSection === 'display') {
      return 1; // 2 display options (line numbers, timestamps)
    } else if (this.settingsSection === 'ignore') {
      const count = this.config.ignore?.length || 0;
      return count > 0 ? count - 1 : 0;
    } else if (this.settingsSection === 'include') {
      const count = this.config.include?.length || 0;
      return count > 0 ? count - 1 : 0;
    } else if (this.settingsSection === 'shortcuts') {
      return Math.max(0, this.allScripts.length - 1);
    } else if (this.settingsSection === 'scripts') {
      return Math.max(0, this.allScripts.length - 1);
    }
    return 0;
  }
  
  toggleDisplayOption() {
    if (this.settingsIndex === 0) {
      this.showLineNumbers = !this.showLineNumbers;
      this.config.showLineNumbers = this.showLineNumbers;
    } else if (this.settingsIndex === 1) {
      this.showTimestamps = !this.showTimestamps;
      this.config.showTimestamps = this.showTimestamps;
    }
    saveConfig(this.config);
  }
  
  deleteSelectedItem() {
    if (this.settingsSection === 'ignore' && this.config.ignore?.length > 0) {
      this.config.ignore.splice(this.settingsIndex, 1);
      if (this.config.ignore.length === 0) delete this.config.ignore;
      saveConfig(this.config);
      this.applyFilters();
      this.settingsIndex = Math.max(0, Math.min(this.settingsIndex, (this.config.ignore?.length || 1) - 1));
    } else if (this.settingsSection === 'include' && this.config.include?.length > 0) {
      this.config.include.splice(this.settingsIndex, 1);
      if (this.config.include.length === 0) delete this.config.include;
      saveConfig(this.config);
      this.applyFilters();
      this.settingsIndex = Math.max(0, Math.min(this.settingsIndex, (this.config.include?.length || 1) - 1));
    } else if (this.settingsSection === 'shortcuts') {
      const script = this.allScripts[this.settingsIndex];
      if (script && this.config.shortcuts) {
        // Find and delete any shortcut assigned to this script
        for (const [key, scriptName] of Object.entries(this.config.shortcuts)) {
          if (scriptName === script.name) {
            delete this.config.shortcuts[key];
            saveConfig(this.config);
            break;
          }
        }
      }
    }
  }
  
  assignShortcut() {
    const script = this.allScripts[this.settingsIndex];
    if (script) {
      this.isAssigningShortcut = true;
      this.shortcutScriptName = script.name;
      this.buildSettingsUI();
    }
  }
  
  toggleScriptIgnore() {
    const script = this.allScripts[this.settingsIndex];
    if (!script) return;
    
    if (!this.config.ignore) this.config.ignore = [];
    
    const exactPattern = script.name;
    const idx = this.config.ignore.indexOf(exactPattern);
    
    if (idx >= 0) {
      // Remove from ignore list
      this.config.ignore.splice(idx, 1);
      if (this.config.ignore.length === 0) delete this.config.ignore;
    } else {
      // Add to ignore list
      this.config.ignore.push(exactPattern);
    }
    
    saveConfig(this.config);
    this.applyFilters();
  }
  
  applyFilters() {
    // Re-filter scripts based on current config
    this.scripts = this.allScripts
      .filter(s => isIncluded(s.name, this.config.include))
      .filter(s => !isIgnored(s.name, this.config.ignore || []));
    
    // Clean up selected scripts that are no longer visible
    const visibleNames = new Set(this.scripts.map(s => s.name));
    this.selectedScripts = new Set([...this.selectedScripts].filter(name => visibleNames.has(name)));
    
    // Update default selection in config
    this.config.defaultSelection = Array.from(this.selectedScripts);
    saveConfig(this.config);
  }
  
  // Handle split mode commands (after Ctrl+b prefix)
  handleSplitModeInput(keyName, keyEvent) {
    this.splitMode = false; // Exit split mode after any key
    
    if (keyName === 'escape') {
      // Just cancel split mode
      this.buildRunningUI();
      return;
    }
    
    // % or | = vertical split (left/right)
    if (keyName === '5' && keyEvent.shift) { // % key
      this.splitCurrentPane('vertical');
    } else if (keyName === '\\' && keyEvent.shift) { // | key
      this.splitCurrentPane('vertical');
    }
    // " or - = horizontal split (top/bottom)
    else if (keyName === "'" && keyEvent.shift) { // " key
      this.splitCurrentPane('horizontal');
    } else if (keyName === '-') {
      this.splitCurrentPane('horizontal');
    }
    // Arrow keys = navigate between panes
    else if (keyName === 'up' || keyName === 'down' || keyName === 'left' || keyName === 'right') {
      this.navigatePaneByDirection(keyName);
    }
    // x = close current pane
    else if (keyName === 'x') {
      this.closeCurrentPane();
    }
    // m = move selected process to current pane
    else if (keyName === 'm') {
      this.moveProcessToCurrentPane();
    }
    // o = cycle through panes
    else if (keyName === 'o') {
      this.navigateToNextPane(1);
    }
    
    this.buildRunningUI();
  }
  
  // Handle command palette input
  handleSplitMenuInput(keyName, keyEvent) {
    const menuItems = this.getSplitMenuItems();
    
    if (keyName === 'escape' || keyName === 'q') {
      this.showSplitMenu = false;
      this.buildRunningUI();
      return;
    }
    
    if (keyName === 'up' || keyName === 'k') {
      this.splitMenuIndex = Math.max(0, this.splitMenuIndex - 1);
      this.buildRunningUI();
    } else if (keyName === 'down' || keyName === 'j') {
      this.splitMenuIndex = Math.min(menuItems.length - 1, this.splitMenuIndex + 1);
      this.buildRunningUI();
    } else if (keyName === 'enter' || keyName === 'return') {
      const selectedItem = menuItems[this.splitMenuIndex];
      if (selectedItem) {
        selectedItem.action();
      }
      this.showSplitMenu = false;
      this.buildRunningUI();
    }
  }
  
  handleRunCommandModalInput(keyName, keyEvent) {
    if (keyName === 'escape' || keyName === 'q') {
      this.showRunCommandModal = false;
      this.buildRunningUI();
      return;
    }
    
    if (keyName === 'up' || keyName === 'k') {
      this.runCommandModalIndex = Math.max(0, this.runCommandModalIndex - 1);
      this.buildRunningUI();
    } else if (keyName === 'down' || keyName === 'j') {
      this.runCommandModalIndex = Math.min(this.allScripts.length - 1, this.runCommandModalIndex + 1);
      this.buildRunningUI();
    } else if (keyName === 'enter' || keyName === 'return') {
      const selectedScript = this.allScripts[this.runCommandModalIndex];
      if (selectedScript) {
        this.showRunCommandModal = false;
        this.executeCommand(selectedScript.name);
      }
    }
  }
  
  getSplitMenuItems() {
    const allPanes = getAllPaneIds(this.paneRoot);
    const items = [
      { label: 'Split Vertical (left/right)', shortcut: '|', action: () => this.splitCurrentPane('vertical') },
      { label: 'Split Horizontal (top/bottom)', shortcut: '_', action: () => this.splitCurrentPane('horizontal') },
    ];
    
    if (allPanes.length > 1) {
      items.push({ label: 'Close Pane', shortcut: 'x', action: () => this.closeCurrentPane() });
      items.push({ label: 'Next Pane', shortcut: 'Tab', action: () => this.navigateToNextPane(1) });
      items.push({ label: 'Previous Pane', shortcut: 'Shift+Tab', action: () => this.navigateToNextPane(-1) });
    }
    
    items.push({ label: 'Toggle Line Numbers', shortcut: '#', action: () => { this.showLineNumbers = !this.showLineNumbers; } });
    items.push({ label: 'Toggle Timestamps', shortcut: 't', action: () => { this.showTimestamps = !this.showTimestamps; } });
    
    return items;
  }
  
  // Split the currently focused pane
  splitCurrentPane(direction) {
    if (!this.focusedPaneId) return;
    
    this.paneRoot = splitPane(this.paneRoot, this.focusedPaneId, direction);
    
    // Focus the new pane (second child of the split)
    const allPanes = getAllPaneIds(this.paneRoot);
    const currentIdx = allPanes.indexOf(this.focusedPaneId);
    if (currentIdx >= 0 && currentIdx + 1 < allPanes.length) {
      this.focusedPaneId = allPanes[currentIdx + 1];
    }
    
    this.savePaneLayout();
  }
  
  // Close the currently focused pane
  closeCurrentPane() {
    if (!this.focusedPaneId) return;
    
    const allPanes = getAllPaneIds(this.paneRoot);
    if (allPanes.length <= 1) {
      // Don't close the last pane
      return;
    }
    
    // Find the next pane to focus
    const currentIdx = allPanes.indexOf(this.focusedPaneId);
    const nextIdx = currentIdx > 0 ? currentIdx - 1 : 1;
    const nextPaneId = allPanes[nextIdx];
    
    this.paneRoot = closePane(this.paneRoot, this.focusedPaneId);
    this.focusedPaneId = nextPaneId;
    
    this.savePaneLayout();
  }
  
  // Navigate to next/previous pane
  navigateToNextPane(direction) {
    const allPanes = getAllPaneIds(this.paneRoot);
    if (allPanes.length <= 1) return;
    
    const currentIdx = allPanes.indexOf(this.focusedPaneId);
    let nextIdx = (currentIdx + direction + allPanes.length) % allPanes.length;
    this.focusedPaneId = allPanes[nextIdx];
  }
  
  // Navigate pane by direction (up/down/left/right)
  navigatePaneByDirection(direction) {
    // For now, just cycle through panes
    // A more sophisticated implementation would use pane positions
    if (direction === 'right' || direction === 'down') {
      this.navigateToNextPane(1);
    } else {
      this.navigateToNextPane(-1);
    }
  }
  
  // Move the currently selected process to the focused pane
  moveProcessToCurrentPane() {
    const scriptName = this.scripts[this.selectedIndex]?.name;
    if (!scriptName || !this.focusedPaneId) return;
    
    const pane = findPaneById(this.paneRoot, this.focusedPaneId);
    if (!pane) return;
    
    // If pane shows all processes (empty array), make it show only this one
    if (pane.processes.length === 0) {
      pane.processes = [scriptName];
    } else if (!pane.processes.includes(scriptName)) {
      pane.processes.push(scriptName);
    }
    
    // Remove from other panes
    const allPanes = getAllPaneIds(this.paneRoot);
    for (const paneId of allPanes) {
      if (paneId !== this.focusedPaneId) {
        const otherPane = findPaneById(this.paneRoot, paneId);
        if (otherPane && otherPane.processes.length > 0) {
          otherPane.processes = otherPane.processes.filter(p => p !== scriptName);
        }
      }
    }
  }
  
  // Hide the selected process from the focused pane
  hideProcessFromCurrentPane() {
    const scriptName = this.scripts[this.selectedIndex]?.name;
    if (!scriptName || !this.focusedPaneId) return;
    
    const pane = findPaneById(this.paneRoot, this.focusedPaneId);
    if (!pane) return;
    
    // Initialize hidden array if needed
    if (!pane.hidden) pane.hidden = [];
    
    // Add to hidden list if not already there
    if (!pane.hidden.includes(scriptName)) {
      pane.hidden.push(scriptName);
    }
    
    // Also remove from processes list if it was explicitly added
    if (pane.processes.length > 0) {
      pane.processes = pane.processes.filter(p => p !== scriptName);
    }
  }
  
  // Unhide/show the selected process in the focused pane
  unhideProcessInCurrentPane() {
    const scriptName = this.scripts[this.selectedIndex]?.name;
    if (!scriptName || !this.focusedPaneId) return;
    
    const pane = findPaneById(this.paneRoot, this.focusedPaneId);
    if (!pane) return;
    
    // Remove from hidden list
    if (pane.hidden) {
      pane.hidden = pane.hidden.filter(p => p !== scriptName);
    }
  }
  
  // Toggle visibility of selected process in focused pane
  toggleProcessVisibility() {
    const scriptName = this.scripts[this.selectedIndex]?.name;
    if (!scriptName || !this.focusedPaneId) return;
    
    const pane = findPaneById(this.paneRoot, this.focusedPaneId);
    if (!pane) return;
    
    // Initialize hidden array if needed
    if (!pane.hidden) pane.hidden = [];
    
    // Toggle: if hidden, show it; if visible, hide it
    if (pane.hidden.includes(scriptName)) {
      pane.hidden = pane.hidden.filter(p => p !== scriptName);
    } else {
      pane.hidden.push(scriptName);
    }
    
    this.savePaneLayout();
  }
  
  // Save the current pane layout to config
  savePaneLayout() {
    this.config.paneLayout = serializePaneTree(this.paneRoot);
    saveConfig(this.config);
  }
  
  // Scroll the focused pane
  scrollFocusedPane(direction) {
    if (!this.focusedPaneId) return;
    
    const scrollBox = this.paneScrollBoxes.get(this.focusedPaneId);
    if (!scrollBox || !scrollBox.scrollTo) return;
    
    const currentY = scrollBox.scrollTop || 0;
    const viewportHeight = scrollBox.height || 20;
    const contentHeight = scrollBox.contentHeight || 0;
    
    let newY = currentY;
    
    if (direction === 'home') {
      newY = 0;
    } else if (direction === 'end') {
      newY = Number.MAX_SAFE_INTEGER;
    } else if (direction === 'pageup') {
      newY = Math.max(0, currentY - viewportHeight);
    } else if (direction === 'pagedown') {
      newY = Math.min(contentHeight - viewportHeight, currentY + viewportHeight);
    }
    
    scrollBox.scrollTo({ x: 0, y: newY });
    
    // Save the new scroll position
    this.paneScrollPositions.set(this.focusedPaneId, { x: 0, y: newY });
    
    // Auto-pause when manually scrolling (unless going to end)
    if (direction !== 'end' && !this.isPaused) {
      this.isPaused = true;
      this.updateStreamPauseState();
      this.buildRunningUI();
    }
  }
  
  // Check if a process is visible in the focused pane
  isProcessVisibleInPane(scriptName, pane) {
    if (!pane) return true;
    
    // If pane has specific processes, check if this one is included
    if (pane.processes.length > 0 && !pane.processes.includes(scriptName)) {
      return false;
    }
    
    // Check if hidden
    if (pane.hidden && pane.hidden.includes(scriptName)) {
      return false;
    }
    
    return true;
  }
  
  // Count horizontal splits (which reduce available height per pane)
  // Get output lines for a specific pane
  getOutputLinesForPane(pane) {
    let lines = this.outputLines;
    
    // Filter by processes assigned to this pane
    if (pane.processes.length > 0) {
      lines = lines.filter(line => pane.processes.includes(line.process));
    }
    
    // Exclude hidden processes
    if (pane.hidden && pane.hidden.length > 0) {
      lines = lines.filter(line => !pane.hidden.includes(line.process));
    }
    
    // Apply pane-specific text filter (from / or f command)
    if (pane.filter) {
      lines = lines.filter(line => 
        line.process.toLowerCase().includes(pane.filter.toLowerCase()) || 
        line.text.toLowerCase().includes(pane.filter.toLowerCase())
      );
    }
    
    // Apply color filter (filter lines containing specific ANSI color codes)
    if (pane.colorFilter) {
      lines = lines.filter(line => lineHasColor(line.text, pane.colorFilter));
    }
    
    return lines;
  }
  
  buildSettingsUI() {
    // Remove old containers - use destroyRecursively to clean up all children
    if (this.selectionContainer) {
      this.renderer.root.remove(this.selectionContainer);
      this.selectionContainer.destroyRecursively();
      this.selectionContainer = null;
      this.scriptLines = null;
      this.headerText = null;
    }
    if (this.settingsContainer) {
      this.renderer.root.remove(this.settingsContainer);
      this.settingsContainer.destroyRecursively();
      this.settingsContainer = null;
    }
    if (this.runningContainer) {
      this.renderer.root.remove(this.runningContainer);
      this.runningContainer.destroyRecursively();
      this.runningContainer = null;
      this.outputBox = null;
    }
    
    // Create main container - full screen with dark background
    this.settingsContainer = new BoxRenderable(this.renderer, {
      id: 'settings-container',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      backgroundColor: COLORS.bg,
      padding: 1,
    });
    
    // Header bar with title
    const headerBar = new BoxRenderable(this.renderer, {
      id: 'header-bar',
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: '100%',
      border: ['bottom'],
      borderStyle: 'single',
      borderColor: COLORS.border,
      paddingBottom: 1,
      marginBottom: 1,
    });
    
    const titleText = new TextRenderable(this.renderer, {
      id: 'title',
      content: t`${fg(COLORS.accent)('# Settings')}`,
    });
    headerBar.add(titleText);
    
    const versionText = new TextRenderable(this.renderer, {
      id: 'version',
      content: t`${fg(COLORS.textDim)(APP_VERSION)}`,
    });
    headerBar.add(versionText);
    
    this.settingsContainer.add(headerBar);
    
    // Input prompt if adding pattern
    if (this.isAddingPattern) {
      const inputBar = new BoxRenderable(this.renderer, {
        id: 'input-bar',
        border: ['left'],
        borderStyle: 'single',
        borderColor: COLORS.accent,
        paddingLeft: 1,
        marginBottom: 1,
      });
      const inputText = new TextRenderable(this.renderer, {
        id: 'input-text',
        content: t`${fg(COLORS.textDim)('Add ' + this.settingsSection + ' pattern:')} ${fg(COLORS.text)(this.newPatternText)}${fg(COLORS.accent)('_')}`,
      });
      inputBar.add(inputText);
      this.settingsContainer.add(inputBar);
    }
    
    // Input prompt if assigning shortcut
    if (this.isAssigningShortcut) {
      const inputBar = new BoxRenderable(this.renderer, {
        id: 'input-bar',
        border: ['left'],
        borderStyle: 'single',
        borderColor: COLORS.accent,
        paddingLeft: 1,
        marginBottom: 1,
      });
      const inputText = new TextRenderable(this.renderer, {
        id: 'input-text',
        content: t`${fg(COLORS.textDim)('Press a key to assign as shortcut for')} ${fg(COLORS.accent)(this.shortcutScriptName)} ${fg(COLORS.textDim)('(esc to cancel)')}`,
      });
      inputBar.add(inputText);
      this.settingsContainer.add(inputBar);
    }
    
    // Combined content panel with all sections
    const contentPanel = new BoxRenderable(this.renderer, {
      id: 'content-panel',
      flexDirection: 'row',
      flexGrow: 1,
      gap: 1,
    });
    
    // Left column - Display options, Ignore, Include
    const leftColumn = new BoxRenderable(this.renderer, {
      id: 'left-column',
      flexDirection: 'column',
      flexGrow: 1,
      gap: 1,
    });
    
    // Display options section
    const displayBox = new BoxRenderable(this.renderer, {
      id: 'display-box',
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: this.settingsSection === 'display' ? COLORS.borderFocused : COLORS.border,
      title: ' Display Options ',
      titleAlignment: 'left',
      padding: 1,
    });
    this.buildDisplaySectionContent(displayBox);
    leftColumn.add(displayBox);
    
    // Ignore patterns section
    const ignoreBox = new BoxRenderable(this.renderer, {
      id: 'ignore-box',
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: this.settingsSection === 'ignore' ? COLORS.borderFocused : COLORS.border,
      title: ' Ignore Patterns (i) ',
      titleAlignment: 'left',
      padding: 1,
      flexGrow: 1,
    });
    this.buildIgnoreSectionContent(ignoreBox);
    leftColumn.add(ignoreBox);
    
    // Include patterns section
    const includeBox = new BoxRenderable(this.renderer, {
      id: 'include-box',
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: this.settingsSection === 'include' ? COLORS.borderFocused : COLORS.border,
      title: ' Include Patterns (n) ',
      titleAlignment: 'left',
      padding: 1,
      flexGrow: 1,
    });
    this.buildIncludeSectionContent(includeBox);
    leftColumn.add(includeBox);
    
    contentPanel.add(leftColumn);
    
    // Middle column - Quick Commands
    const shortcutsBox = new BoxRenderable(this.renderer, {
      id: 'shortcuts-box',
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: this.settingsSection === 'shortcuts' ? COLORS.borderFocused : COLORS.border,
      title: ' Quick Commands ',
      titleAlignment: 'left',
      flexGrow: 1,
      padding: 1,
    });
    this.buildShortcutsSectionContent(shortcutsBox);
    contentPanel.add(shortcutsBox);
    
    // Right column - Script List
    const scriptsBox = new BoxRenderable(this.renderer, {
      id: 'scripts-box',
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: this.settingsSection === 'scripts' ? COLORS.borderFocused : COLORS.border,
      title: ' Script List ',
      titleAlignment: 'left',
      flexGrow: 1,
      padding: 1,
    });
    this.buildScriptsSectionContent(scriptsBox);
    contentPanel.add(scriptsBox);
    
    this.settingsContainer.add(contentPanel);
    
    // Footer bar with keyboard shortcuts
    const footerBar = new BoxRenderable(this.renderer, {
      id: 'footer-bar',
      flexDirection: 'row',
      width: '100%',
      border: ['top'],
      borderStyle: 'single',
      borderColor: COLORS.border,
      paddingTop: 1,
      marginTop: 1,
      gap: 2,
    });
    
    let shortcuts;
    if (this.isAddingPattern) {
      shortcuts = [
        { key: 'enter', desc: 'save' },
        { key: 'esc', desc: 'cancel' },
      ];
    } else if (this.isAssigningShortcut) {
      shortcuts = [
        { key: 'any key', desc: 'assign' },
        { key: 'esc', desc: 'cancel' },
      ];
    } else {
      shortcuts = [
        { key: 'tab', desc: 'section' },
        { key: 'space', desc: this.settingsSection === 'shortcuts' ? 'assign' : 'toggle' },
        { key: 'i', desc: 'add ignore' },
        { key: 'n', desc: 'add include' },
        { key: 'd', desc: 'delete' },
        { key: 'esc', desc: 'back' },
      ];
    }
    
    shortcuts.forEach(({ key, desc }) => {
      const shortcut = new TextRenderable(this.renderer, {
        id: `shortcut-${key}`,
        content: t`${fg(COLORS.textDim)(key)} ${fg(COLORS.text)(desc)}`,
      });
      footerBar.add(shortcut);
    });
    
    this.settingsContainer.add(footerBar);
    
    this.renderer.root.add(this.settingsContainer);
  }
  
  buildDisplaySectionContent(container) {
    const options = [
      { id: 'lineNumbers', label: 'Show Line Numbers', value: this.showLineNumbers },
      { id: 'timestamps', label: 'Show Timestamps', value: this.showTimestamps },
    ];
    
    options.forEach((option, idx) => {
      const isFocused = this.settingsSection === 'display' && idx === this.settingsIndex;
      const indicator = isFocused ? '>' : ' ';
      const checkbox = option.value ? '[x]' : '[ ]';
      const checkColor = option.value ? COLORS.success : COLORS.textDim;
      
      const line = new TextRenderable(this.renderer, {
        id: `display-option-${idx}`,
        content: t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(checkColor)(checkbox)} ${fg(COLORS.text)(option.label)}`,
      });
      container.add(line);
    });
  }
  
  buildIgnoreSectionContent(container) {
    const patterns = this.config.ignore || [];
    
    if (patterns.length === 0) {
      const empty = new TextRenderable(this.renderer, {
        id: 'ignore-empty',
        content: t`${fg(COLORS.textDim)('Press i to add')}`,
      });
      container.add(empty);
    } else {
      patterns.forEach((pattern, idx) => {
        const isFocused = this.settingsSection === 'ignore' && idx === this.settingsIndex;
        const indicator = isFocused ? '>' : ' ';
        
        const line = new TextRenderable(this.renderer, {
          id: `ignore-pattern-${idx}`,
          content: t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(COLORS.error)(pattern)}`,
        });
        container.add(line);
      });
    }
  }
  
  buildIncludeSectionContent(container) {
    const patterns = this.config.include || [];
    
    if (patterns.length === 0) {
      const empty = new TextRenderable(this.renderer, {
        id: 'include-empty',
        content: t`${fg(COLORS.textDim)('Press n to add')}`,
      });
      container.add(empty);
    } else {
      patterns.forEach((pattern, idx) => {
        const isFocused = this.settingsSection === 'include' && idx === this.settingsIndex;
        const indicator = isFocused ? '>' : ' ';
        
        const line = new TextRenderable(this.renderer, {
          id: `include-pattern-${idx}`,
          content: t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(COLORS.success)(pattern)}`,
        });
        container.add(line);
      });
    }
  }
  
  buildShortcutsSectionContent(container) {
    const shortcuts = this.config.shortcuts || {};
    
    // Helper to find shortcut key for a script
    const getShortcutKey = (scriptName) => {
      for (const [key, name] of Object.entries(shortcuts)) {
        if (name === scriptName) return key;
      }
      return null;
    };
    
    this.allScripts.forEach((script, idx) => {
      const isFocused = this.settingsSection === 'shortcuts' && idx === this.settingsIndex;
      const indicator = isFocused ? '>' : ' ';
      const shortcutKey = getShortcutKey(script.name);
      const processColor = this.processColors.get(script.name) || COLORS.text;
      
      let content;
      if (shortcutKey) {
        content = t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(COLORS.warning)(`[${shortcutKey}]`)} ${fg(processColor)(script.displayName)}`;
      } else {
        content = t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(COLORS.textDim)('[ ]')} ${fg(processColor)(script.displayName)}`;
      }
      
      const line = new TextRenderable(this.renderer, {
        id: `shortcut-item-${idx}`,
        content: content,
      });
      container.add(line);
    });
  }
  
  buildScriptsSectionContent(container) {
    const ignorePatterns = this.config.ignore || [];
    
    this.allScripts.forEach((script, idx) => {
      const isIgnored = ignorePatterns.includes(script.name);
      const isFocused = this.settingsSection === 'scripts' && idx === this.settingsIndex;
      const indicator = isFocused ? '>' : ' ';
      const checkbox = isIgnored ? '[x]' : '[ ]';
      const checkColor = isIgnored ? COLORS.error : COLORS.success;
      const processColor = this.processColors.get(script.name) || COLORS.text;
      const nameColor = isIgnored ? COLORS.textDim : processColor;
      
      let content;
      if (isIgnored) {
        content = t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(checkColor)(checkbox)} ${fg(nameColor)(script.displayName)} ${fg(COLORS.textDim)('(ignored)')}`;
      } else {
        content = t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(checkColor)(checkbox)} ${fg(nameColor)(script.displayName)}`;
      }
      
      const line = new TextRenderable(this.renderer, {
        id: `script-toggle-${idx}`,
        content: content,
      });
      container.add(line);
    });
  }
  
  updateStreamPauseState() {
    // Pause or resume all process stdout/stderr streams
    for (const proc of this.processRefs.values()) {
      if (proc && proc.stdout && proc.stderr) {
        if (this.isPaused) {
          proc.stdout.pause();
          proc.stderr.pause();
        } else {
          proc.stdout.resume();
          proc.stderr.resume();
        }
      }
    }
  }

  cleanup() {
    this.destroyed = true;
    
    // Stop the countdown interval
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    
    // Clean up command overlay process if running
    if (this.commandOverlayProcess && this.commandOverlayProcess.pid) {
      try {
        kill(this.commandOverlayProcess.pid, 'SIGKILL');
      } catch (err) {
        // Ignore
      }
    }
    
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
  
  executeCommand(scriptName) {
    // Initialize overlay state
    this.showCommandOverlay = true;
    this.commandOverlayOutput = [];
    this.commandOverlayScript = scriptName;
    this.commandOverlayStatus = 'running';
    
    // Spawn the process
    const proc = spawn('npm', ['run', scriptName], {
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor',
      },
      shell: true,
    });
    
    this.commandOverlayProcess = proc;
    
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          this.commandOverlayOutput.push(line);
          this.buildRunningUI();
        }
      });
    });
    
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          this.commandOverlayOutput.push(line);
          this.buildRunningUI();
        }
      });
    });
    
    proc.on('exit', (code) => {
      this.commandOverlayStatus = code === 0 ? 'exited' : 'crashed';
      this.commandOverlayOutput.push('');
      this.commandOverlayOutput.push(`Process exited with code ${code}`);
      this.commandOverlayProcess = null;
      this.buildRunningUI();
    });
    
    this.buildRunningUI();
  }
  
  closeCommandOverlay() {
    // Kill the process if still running
    if (this.commandOverlayProcess && this.commandOverlayProcess.pid) {
      try {
        kill(this.commandOverlayProcess.pid, 'SIGKILL');
      } catch (err) {
        // Ignore
      }
    }
    
    this.showCommandOverlay = false;
    this.commandOverlayOutput = [];
    this.commandOverlayScript = '';
    this.commandOverlayStatus = 'running';
    this.commandOverlayProcess = null;
  }

  buildSelectionUI() {
    // Remove old containers if they exist - use destroyRecursively to clean up all children
    if (this.selectionContainer) {
      this.renderer.root.remove(this.selectionContainer);
      this.selectionContainer.destroyRecursively();
      this.selectionContainer = null;
      this.scriptLines = null;
      this.headerText = null;
    }
    if (this.settingsContainer) {
      this.renderer.root.remove(this.settingsContainer);
      this.settingsContainer.destroyRecursively();
      this.settingsContainer = null;
    }
    if (this.runningContainer) {
      this.renderer.root.remove(this.runningContainer);
      this.runningContainer.destroyRecursively();
      this.runningContainer = null;
      this.outputBox = null;
    }
    
    // Create main container - full screen with dark background
    this.selectionContainer = new BoxRenderable(this.renderer, {
      id: 'selection-container',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      backgroundColor: COLORS.bg,
    });
    
    // Scripts panel - compact with background for focused item
    const scriptsPanel = new BoxRenderable(this.renderer, {
      id: 'scripts-panel',
      flexDirection: 'column',
      flexGrow: 1,
      paddingLeft: 1,
      paddingTop: 1,
    });
    
    // Track Y positions for mouse clicks
    let currentY = 1; // start of scripts
    this.scriptLinePositions = [];
    
    this.scriptLines = this.scripts.map((script, index) => {
      const isSelected = this.selectedScripts.has(script.name);
      const isFocused = index === this.selectedIndex;
      const processColor = this.processColors.get(script.name) || COLORS.text;
      const nameColor = isFocused ? COLORS.text : processColor;
      const numberColor = processColor;
      const bracketColor = processColor;
      const bgColor = isFocused ? COLORS.bgHighlight : null;
      
      // Show number for first 9 scripts
      const numberLabel = index < 9 ? ` ${index + 1}` : '  ';
      
      // Build checkbox with colored brackets and white x (like running screen)
      let content;
      if (isSelected) {
        content = t`${fg(numberColor)(numberLabel)} ${fg(bracketColor)('[')}${fg(COLORS.text)('x')}${fg(bracketColor)(']')} ${fg(nameColor)(script.displayName)}`;
      } else {
        content = t`${fg(numberColor)(numberLabel)} ${fg(bracketColor)('[ ]')} ${fg(nameColor)(script.displayName)}`;
      }
      
      const lineContainer = new BoxRenderable(this.renderer, {
        id: `script-box-${index}`,
        backgroundColor: bgColor,
        paddingLeft: 1,
        width: '100%',
      });
      
      const line = new TextRenderable(this.renderer, {
        id: `script-${index}`,
        content: content,
      });
      lineContainer.add(line);
      scriptsPanel.add(lineContainer);
      this.scriptLinePositions.push(currentY);
      currentY++;
      return lineContainer;
    });
    
    this.selectionContainer.add(scriptsPanel);
    
    // Footer bar with title, countdown, and shortcuts
    const footerBar = new BoxRenderable(this.renderer, {
      id: 'footer-bar',
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: '100%',
      backgroundColor: COLORS.bgLight,
      paddingLeft: 1,
      paddingRight: 1,
    });
    
    // Left side: title and countdown
    const leftSide = new BoxRenderable(this.renderer, {
      id: 'footer-left',
      flexDirection: 'row',
      gap: 2,
    });
    
    const titleText = new TextRenderable(this.renderer, {
      id: 'title',
      content: t`${fg(COLORS.accent)('startall')} ${fg(COLORS.warning)(this.countdown + 's')}`,
    });
    leftSide.add(titleText);
    this.headerText = titleText; // Save reference for countdown updates
    
    // VS Code hint
    if (IS_VSCODE) {
      const vscodeHint = new TextRenderable(this.renderer, {
        id: 'vscode-hint',
        content: t`${fg(COLORS.textDim)('(vscode)')}`,
      });
      leftSide.add(vscodeHint);
    }
    
    footerBar.add(leftSide);
    
    // Right side: shortcuts
    const rightSide = new BoxRenderable(this.renderer, {
      id: 'footer-right',
      flexDirection: 'row',
      gap: 2,
    });
    
    const shortcuts = [
      { key: 'spc', desc: 'sel', color: COLORS.success },
      { key: 'ret', desc: 'go', color: COLORS.accent },
      { key: 'o', desc: 'cfg', color: COLORS.magenta },
    ];
    
    shortcuts.forEach(({ key, desc, color }) => {
      const shortcut = new TextRenderable(this.renderer, {
        id: `shortcut-${key}`,
        content: t`${fg(color)(key)}${fg(COLORS.textDim)(':' + desc)}`,
      });
      rightSide.add(shortcut);
    });
    
    footerBar.add(rightSide);
    this.selectionContainer.add(footerBar);
    
    this.renderer.root.add(this.selectionContainer);
  }
  
  getHeaderText() {
    return `Starting in ${this.countdown}s...`;
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
    // Rebuild UI each time - simpler and more reliable with the new structure
    this.buildSelectionUI();
  }
  
  render() {
    // Don't render if destroyed
    if (this.destroyed) return;
    
    if (this.phase === 'selection') {
      // For selection phase, just update the text content
      this.updateSelectionUI();
    } else if (this.phase === 'settings') {
      // Settings UI is rebuilt on each input
      // No-op here as buildSettingsUI handles everything
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
    // Update existing panes incrementally, or rebuild if needed
    if (this.paneScrollBoxes.size > 0) {
      // Incremental update - just append new lines to existing panes
      let hasNewContent = false;
      
      for (const [paneId, scrollBox] of this.paneScrollBoxes.entries()) {
        const pane = findPaneById(this.paneRoot, paneId);
        if (pane && scrollBox && scrollBox.content) {
          const lines = this.getOutputLinesForPane(pane);
          const lastRenderedLineNumber = this.paneLineCount.get(paneId) || 0;
          
          // Find lines that haven't been rendered yet (based on absolute line number)
          const newLines = lines.filter(line => line.lineNumber > lastRenderedLineNumber);
          
          if (newLines.length > 0) {
            hasNewContent = true;
            
            for (let i = 0; i < newLines.length; i++) {
              const line = newLines[i];
              const processColor = this.processColors.get(line.process) || COLORS.text;
              const trimmedText = line.text.trim();
              
              // Build content with proper template literal
              const lineNumber = this.showLineNumbers ? String(line.lineNumber).padStart(4, ' ') : '';
              const timestamp = this.showTimestamps ? new Date(line.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '';
              
              let content;
              if (this.showLineNumbers && this.showTimestamps) {
                content = t`${fg(COLORS.textDim)(lineNumber)} ${fg(COLORS.textDim)(`[${timestamp}]`)} ${fg(processColor)(`[${line.process}]`)} ${trimmedText}`;
              } else if (this.showLineNumbers) {
                content = t`${fg(COLORS.textDim)(lineNumber)} ${fg(processColor)(`[${line.process}]`)} ${trimmedText}`;
              } else if (this.showTimestamps) {
                content = t`${fg(COLORS.textDim)(`[${timestamp}]`)} ${fg(processColor)(`[${line.process}]`)} ${trimmedText}`;
              } else {
                content = t`${fg(processColor)(`[${line.process}]`)} ${trimmedText}`;
              }
              
              const outputLine = new TextRenderable(this.renderer, {
                id: `output-${pane.id}-${line.lineNumber}`,
                content: content,
                bg: '#000000',
              });
              
              scrollBox.content.add(outputLine);
              
              // Remove oldest line if we exceed maxOutputLines to maintain rolling window
              if (scrollBox.content.children && scrollBox.content.children.length > this.maxOutputLines) {
                const oldestChild = scrollBox.content.children[0];
                scrollBox.content.remove(oldestChild);
              }
            }
            
            // Update to track the last absolute line number we rendered
            this.paneLineCount.set(paneId, newLines[newLines.length - 1].lineNumber);
            
            // Auto-scroll to bottom if not paused
            if (!this.isPaused && scrollBox.scrollTo) {
              scrollBox.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
            }
          }
        }
      }
    } else {
      // First time or no panes exist - do full rebuild
      this.buildRunningUI();
    }
  }
  
  // Build a single pane's output area
  buildPaneOutput(pane, container, height) {
    const isFocused = pane.id === this.focusedPaneId;
    const lines = this.getOutputLinesForPane(pane);
    
    // Don't slice - show all lines and let ScrollBox handle scrolling
    const linesToShow = lines;
    
    // Add lines (oldest first, so newest is at bottom)
    for (let i = 0; i < linesToShow.length; i++) {
      const line = linesToShow[i];
      const processColor = this.processColors.get(line.process) || COLORS.text;
      
      // Trim whitespace and let text wrap naturally - ScrollBox will handle overflow
      const trimmedText = line.text.trim();
      
      // Build content with proper template literal
      const lineNumber = this.showLineNumbers ? String(line.lineNumber).padStart(4, ' ') : '';
      const timestamp = this.showTimestamps ? new Date(line.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '';
      
      let content;
      if (this.showLineNumbers && this.showTimestamps) {
        content = t`${fg(COLORS.textDim)(lineNumber)} ${fg(COLORS.textDim)(`[${timestamp}]`)} ${fg(processColor)(`[${line.process}]`)} ${trimmedText}`;
      } else if (this.showLineNumbers) {
        content = t`${fg(COLORS.textDim)(lineNumber)} ${fg(processColor)(`[${line.process}]`)} ${trimmedText}`;
      } else if (this.showTimestamps) {
        content = t`${fg(COLORS.textDim)(`[${timestamp}]`)} ${fg(processColor)(`[${line.process}]`)} ${trimmedText}`;
      } else {
        content = t`${fg(processColor)(`[${line.process}]`)} ${trimmedText}`;
      }
      
      const outputLine = new TextRenderable(this.renderer, {
        id: `output-${pane.id}-${i}`,
        content: content,
        bg: '#000000', // Black background for pane content
      });
      
      container.add(outputLine);
    }
  }
  
  // Count how many vertical panes exist (for width calculation)
  countVerticalPanes(node) {
    if (!node) return 1;
    if (node.type === 'pane') return 1;
    if (node.direction === 'vertical') {
      // Vertical split means panes side by side
      return node.children.reduce((sum, child) => sum + this.countVerticalPanes(child), 0);
    } else {
      // Horizontal split means panes stacked, count the max
      return Math.max(...node.children.map(child => this.countVerticalPanes(child)));
    }
  }
  
  // Build a pane panel with title bar
  buildPanePanel(pane, flexGrow = 1, availableHeight = null) {
    const isFocused = pane.id === this.focusedPaneId;
    const borderColor = isFocused ? COLORS.borderFocused : COLORS.border;
    
    // Title shows custom name (if set), or assigned processes or "All", plus filter and hidden count
    const customName = pane.name ? pane.name : null;
    const processLabel = customName || (pane.processes.length > 0 
      ? pane.processes.join(', ')
      : 'All');
    const focusLabel = isFocused ? '*' : '';
    const hiddenCount = pane.hidden?.length || 0;
    const hiddenLabel = hiddenCount > 0 ? ` -${hiddenCount}` : '';
    const filterLabel = pane.filter ? ` /${pane.filter}` : '';
    const namingInputLabel = (isFocused && this.isNamingMode) ? `Name: ${this.namingModeText}_` : '';
    const filterInputLabel = (isFocused && this.isFilterMode) ? `/${pane.filter || ''}_` : '';
    const title = ` ${focusLabel}${namingInputLabel || processLabel}${hiddenLabel}${filterInputLabel || filterLabel} `;
    
    const paneContainer = new BoxRenderable(this.renderer, {
      id: `pane-${pane.id}`,
      flexDirection: 'column',
      flexGrow: flexGrow,
      flexShrink: 0, // Prevent shrinking - maintain 50/50 split
      flexBasis: 0, // Use flexGrow ratio for sizing, not content size
      border: true,
      borderStyle: 'rounded',
      borderColor: borderColor,
      title: title,
      titleAlignment: 'left',
      padding: 0,
      overflow: 'hidden',
      backgroundColor: '#000000', // Black background for pane container
    });
    
    // Output content - use ScrollBox to handle text wrapping properly
    // Use passed height or calculate default for line count calculation
    const height = availableHeight ? Math.max(5, availableHeight - 2) : Math.max(5, this.renderer.height - 6);
    
    const outputBox = new ScrollBoxRenderable(this.renderer, {
      id: `pane-output-${pane.id}`,
      height: height,
      scrollX: false, // Disable horizontal scrollbar entirely
      scrollY: true,  // Enable vertical scrolling
      focusable: true, // Enable mouse interactions and keyboard scrolling
      style: {
        rootOptions: {
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 0,
          paddingLeft: 1,
          backgroundColor: '#000000',
        },
        contentOptions: {
          backgroundColor: '#000000',
          width: '100%', // Fill container width for proper text wrapping
        },
      },
    });
    
    // Show scrollbar when paused, hide when not paused
    if (outputBox.verticalScrollBar) {
      outputBox.verticalScrollBar.width = this.isPaused ? 1 : 0;
    }
    
    // Store ScrollBox reference for this pane
    this.paneScrollBoxes.set(pane.id, outputBox);
    
    this.buildPaneOutput(pane, outputBox.content, height);
    
    // Restore or set scroll position immediately
    if (outputBox && outputBox.scrollTo) {
      if (this.isPaused && this.paneScrollPositions.has(pane.id)) {
        // Restore saved scroll position when paused
        const savedPos = this.paneScrollPositions.get(pane.id);
        outputBox.scrollTo(savedPos);
      } else if (!this.isPaused) {
        // Auto-scroll to bottom when not paused
        outputBox.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
      }
    }
    
    paneContainer.add(outputBox);
    return paneContainer;
  }
  
  // Recursively build the pane layout, passing available height down
  buildPaneLayout(node, flexGrow = 1, availableHeight = null) {
    if (!node) return null;
    
    // Default available height (screen minus header/footer)
    if (availableHeight === null) {
      availableHeight = this.renderer.height - 2;
    }
    
    if (node.type === 'pane') {
      return this.buildPanePanel(node, flexGrow, availableHeight);
    }
    
    // It's a split node
    const container = new BoxRenderable(this.renderer, {
      id: `split-${node.direction}`,
      flexDirection: node.direction === 'vertical' ? 'row' : 'column',
      flexGrow: flexGrow,
      flexShrink: 0,
      flexBasis: 0,
      gap: 0,
    });
    
    // Calculate child heights - only horizontal splits divide height
    const childCount = node.children.length;
    const childHeight = node.direction === 'horizontal' 
      ? Math.floor(availableHeight / childCount)
      : availableHeight; // vertical splits don't reduce height
    
    node.children.forEach((child, idx) => {
      const childElement = this.buildPaneLayout(child, node.sizes[idx], childHeight);
      if (childElement) {
        container.add(childElement);
      }
    });
    
    return container;
  }
  
  // Build command palette overlay
  buildSplitMenuOverlay(parent) {
    const menuItems = this.getSplitMenuItems();
    
    // Create centered overlay
    const overlay = new BoxRenderable(this.renderer, {
      id: 'split-menu-overlay',
      position: 'absolute',
      top: '30%',
      left: '30%',
      width: '40%',
      backgroundColor: COLORS.bgLight,
      border: true,
      borderStyle: 'rounded',
      borderColor: COLORS.accent,
      title: ' Command Palette ',
      padding: 1,
      flexDirection: 'column',
    });
    
    menuItems.forEach((item, idx) => {
      const isFocused = idx === this.splitMenuIndex;
      const indicator = isFocused ? '>' : ' ';
      const bgColor = isFocused ? COLORS.bgHighlight : null;
      
      const itemContainer = new BoxRenderable(this.renderer, {
        id: `menu-item-${idx}`,
        backgroundColor: bgColor,
        paddingLeft: 1,
      });
      
      const itemText = new TextRenderable(this.renderer, {
        id: `menu-text-${idx}`,
        content: t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(COLORS.text)(item.label)} ${fg(COLORS.textDim)(`(${item.shortcut})`)}`,
      });
      
      itemContainer.add(itemText);
      overlay.add(itemContainer);
    });
    
    // Footer hint
    const hint = new TextRenderable(this.renderer, {
      id: 'menu-hint',
      content: t`${fg(COLORS.textDim)('Enter to select, Esc to close')}`,
    });
    overlay.add(hint);
    
    parent.add(overlay);
  }
  
  // Build command output overlay
  buildCommandOverlay(parent) {
    const statusIcon = this.commandOverlayStatus === 'running' ? '●' : 
                      this.commandOverlayStatus === 'exited' ? '✓' : '✖';
    const statusColor = this.commandOverlayStatus === 'running' ? COLORS.warning : 
                       this.commandOverlayStatus === 'exited' ? COLORS.success : COLORS.error;
    const title = ` ${statusIcon} ${this.commandOverlayScript} `;
    
    // Create centered overlay with scrollable content
    const overlay = new BoxRenderable(this.renderer, {
      id: 'command-overlay',
      position: 'absolute',
      top: '10%',
      left: '10%',
      width: '80%',
      height: '80%',
      backgroundColor: COLORS.bg,
      border: true,
      borderStyle: 'rounded',
      borderColor: statusColor,
      title: title,
      padding: 0,
      flexDirection: 'column',
    });
    
    // Scrollable output content
    const outputBox = new ScrollBoxRenderable(this.renderer, {
      id: 'command-output',
      height: Math.floor(this.renderer.height * 0.8) - 4,
      scrollX: false,
      scrollY: true,
      focusable: true,
      style: {
        rootOptions: {
          flexGrow: 1,
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: COLORS.bg,
        },
        contentOptions: {
          backgroundColor: COLORS.bg,
          width: '100%',
        },
      },
    });
    
    // Add output lines
    this.commandOverlayOutput.forEach((line, idx) => {
      const outputLine = new TextRenderable(this.renderer, {
        id: `cmd-output-${idx}`,
        content: line,
      });
      outputBox.content.add(outputLine);
    });
    
    // Auto-scroll to bottom
    if (outputBox.scrollTo) {
      outputBox.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
    }
    
    overlay.add(outputBox);
    
    // Footer hint
    const hintBar = new BoxRenderable(this.renderer, {
      id: 'command-hint-bar',
      border: ['top'],
      borderStyle: 'single',
      borderColor: COLORS.border,
      paddingTop: 1,
      paddingLeft: 1,
    });
    
    const hint = new TextRenderable(this.renderer, {
      id: 'command-hint',
      content: t`${fg(COLORS.textDim)('Press')} ${fg(COLORS.accent)('Esc')} ${fg(COLORS.textDim)('to close')}`,
    });
    hintBar.add(hint);
    overlay.add(hintBar);
    
    parent.add(overlay);
  }
  
  // Build run command picker modal
  buildRunCommandModal(parent) {
    // Create centered overlay
    const overlay = new BoxRenderable(this.renderer, {
      id: 'run-command-modal',
      position: 'absolute',
      top: '20%',
      left: '25%',
      width: '50%',
      height: '60%',
      backgroundColor: COLORS.bgLight,
      border: true,
      borderStyle: 'rounded',
      borderColor: COLORS.accent,
      title: ' Run Command ',
      padding: 1,
      flexDirection: 'column',
    });
    
    // Scrollable list of scripts
    const listBox = new ScrollBoxRenderable(this.renderer, {
      id: 'run-command-list',
      height: Math.floor(this.renderer.height * 0.6) - 4,
      scrollX: false,
      scrollY: true,
      focusable: true,
      style: {
        rootOptions: {
          flexGrow: 1,
          backgroundColor: COLORS.bgLight,
        },
        contentOptions: {
          backgroundColor: COLORS.bgLight,
          width: '100%',
        },
      },
    });
    
    this.allScripts.forEach((script, idx) => {
      const isFocused = idx === this.runCommandModalIndex;
      const indicator = isFocused ? '>' : ' ';
      const bgColor = isFocused ? COLORS.bgHighlight : null;
      const processColor = this.processColors.get(script.name) || COLORS.text;
      
      // Check if this script has a shortcut
      const shortcuts = this.config.shortcuts || {};
      let shortcutKey = null;
      for (const [key, scriptName] of Object.entries(shortcuts)) {
        if (scriptName === script.name) {
          shortcutKey = key;
          break;
        }
      }
      
      const itemContainer = new BoxRenderable(this.renderer, {
        id: `run-cmd-item-${idx}`,
        backgroundColor: bgColor,
        paddingLeft: 1,
      });
      
      let content;
      if (shortcutKey) {
        content = t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(processColor)(script.displayName)} ${fg(COLORS.textDim)(`(${shortcutKey})`)}`;
      } else {
        content = t`${fg(isFocused ? COLORS.accent : COLORS.textDim)(indicator)} ${fg(processColor)(script.displayName)}`;
      }
      
      const itemText = new TextRenderable(this.renderer, {
        id: `run-cmd-text-${idx}`,
        content: content,
      });
      
      itemContainer.add(itemText);
      listBox.content.add(itemContainer);
    });
    
    // Auto-scroll to focused item
    if (listBox.scrollTo) {
      const lineHeight = 1;
      const viewportHeight = Math.floor(this.renderer.height * 0.6) - 4;
      const focusedY = this.runCommandModalIndex * lineHeight;
      if (focusedY < listBox.scrollTop || focusedY >= listBox.scrollTop + viewportHeight) {
        listBox.scrollTo({ x: 0, y: Math.max(0, focusedY - Math.floor(viewportHeight / 2)) });
      }
    }
    
    overlay.add(listBox);
    
    // Footer hint
    const hintBar = new BoxRenderable(this.renderer, {
      id: 'run-cmd-hint-bar',
      border: ['top'],
      borderStyle: 'single',
      borderColor: COLORS.border,
      paddingTop: 1,
      paddingLeft: 1,
    });
    
    const hint = new TextRenderable(this.renderer, {
      id: 'run-cmd-hint',
      content: t`${fg(COLORS.textDim)('↑/↓ navigate')}  ${fg(COLORS.accent)('Enter')} ${fg(COLORS.textDim)('run')}  ${fg(COLORS.accent)('Esc')} ${fg(COLORS.textDim)('close')}`,
    });
    hintBar.add(hint);
    overlay.add(hintBar);
    
    parent.add(overlay);
  }
  
  buildRunningUI() {
    // Save scroll positions before destroying
    for (const [paneId, scrollBox] of this.paneScrollBoxes.entries()) {
      if (scrollBox) {
        this.paneScrollPositions.set(paneId, {
          x: scrollBox.scrollLeft || 0,
          y: scrollBox.scrollTop || 0,
        });
      }
    }
    
    // Remove old containers if they exist - use destroyRecursively to clean up all children
    if (this.selectionContainer) {
      this.renderer.root.remove(this.selectionContainer);
      this.selectionContainer.destroyRecursively();
      this.selectionContainer = null;
      this.scriptLines = null;
      this.headerText = null;
    }
    if (this.settingsContainer) {
      this.renderer.root.remove(this.settingsContainer);
      this.settingsContainer.destroyRecursively();
      this.settingsContainer = null;
    }
    if (this.runningContainer) {
      this.renderer.root.remove(this.runningContainer);
      this.runningContainer.destroyRecursively();
      this.runningContainer = null;
    }
    // Clear outputBox reference and scrollbox map since they were destroyed
    this.outputBox = null;
    this.paneScrollBoxes.clear();
    
    // Create main container - full screen with black background
    const mainContainer = new BoxRenderable(this.renderer, {
      id: 'running-container',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      backgroundColor: '#000000',
    });
    
    // Process tabs at top
    const processBar = new BoxRenderable(this.renderer, {
      id: 'process-bar',
      flexDirection: 'row',
      width: '100%',
      backgroundColor: COLORS.bgLight,
      paddingLeft: 1,
    });
    

    
    // Add each process with checkbox showing visibility in focused pane
    const focusedPane = findPaneById(this.paneRoot, this.focusedPaneId);
    
    this.scripts.forEach((script, index) => {
      const proc = this.processes.get(script.name);
      const status = proc?.status || 'stopped';
      const statusIcon = status === 'running' ? '●' : status === 'crashed' ? '!' : '○';
      const statusColor = status === 'running' ? COLORS.success : status === 'crashed' ? COLORS.error : COLORS.textDim;
      const processColor = this.processColors.get(script.name) || COLORS.text;
      const isSelected = this.selectedIndex === index;
      const isVisible = this.isProcessVisibleInPane(script.name, focusedPane);
      const nameColor = isSelected ? COLORS.accent : (isVisible ? processColor : COLORS.textDim);
      const numberColor = isVisible ? processColor : COLORS.textDim;
      const indicator = isSelected ? '>' : ' ';
      const bracketColor = isVisible ? processColor : COLORS.textDim;
      
      // Show number for first 9 processes
      const numberLabel = index < 9 ? `${index + 1}` : ' ';
      
      // Build content - can't nest template literals, so build entire thing at once
      let content;
      if (isVisible) {
        content = t`${fg(numberColor)(numberLabel)} ${fg(isSelected ? COLORS.accent : COLORS.textDim)(indicator)}${fg(bracketColor)('[')}${fg(COLORS.text)('x')}${fg(bracketColor)(']')} ${fg(statusColor)(statusIcon)} ${fg(nameColor)(script.displayName)}`;
      } else {
        content = t`${fg(numberColor)(numberLabel)} ${fg(isSelected ? COLORS.accent : COLORS.textDim)(indicator)}${fg(bracketColor)('[ ]')} ${fg(statusColor)(statusIcon)} ${fg(nameColor)(script.displayName)}`;
      }
      
      const processItem = new TextRenderable(this.renderer, {
        id: `process-item-${index}`,
        content: content,
      });
      processBar.add(processItem);
    });
    
    this.processListRenderable = processBar;
    mainContainer.add(processBar);
    
    // Build pane layout
    const paneArea = new BoxRenderable(this.renderer, {
      id: 'pane-area',
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 0,
      flexBasis: 0,
      backgroundColor: '#000000',
    });
    
    const paneLayout = this.buildPaneLayout(this.paneRoot);
    if (paneLayout) {
      paneArea.add(paneLayout);
    }
    
    mainContainer.add(paneArea);
    
    // Footer bar - compact style matching selection UI
    const footerBar = new BoxRenderable(this.renderer, {
      id: 'footer-bar',
      flexDirection: 'row',
      width: '100%',
      backgroundColor: COLORS.bgLight,
      paddingLeft: 1,
      paddingRight: 1,
      justifyContent: 'space-between',
    });
    
    // Left side: status indicator and filter
    const leftSide = new BoxRenderable(this.renderer, {
      id: 'footer-left',
      flexDirection: 'row',
      gap: 2,
    });
    
    // Status (LIVE/PAUSED)
    const statusText = this.isPaused ? 'PAUSED' : 'LIVE';
    const statusColor = this.isPaused ? COLORS.warning : COLORS.success;
    const statusIndicator = new TextRenderable(this.renderer, {
      id: 'status-indicator',
      content: t`${fg(statusColor)(statusText)}`,
    });
    leftSide.add(statusIndicator);
    
    // VS Code hint
    if (IS_VSCODE) {
      const vscodeHint = new TextRenderable(this.renderer, {
        id: 'vscode-hint',
        content: t`${fg(COLORS.textDim)('(vscode)')}`,
      });
      leftSide.add(vscodeHint);
    }
    
    // Filter indicator if active
    if (this.filter || this.isFilterMode) {
      const filterText = this.isFilterMode ? `/${this.filter}_` : `/${this.filter}`;
      const filterIndicator = new TextRenderable(this.renderer, {
        id: 'filter-indicator',
        content: t`${fg(COLORS.cyan)(filterText)}`,
      });
      leftSide.add(filterIndicator);
    }
    
    // Input mode indicator if active
    if (this.isInputMode) {
      const scriptName = this.scripts[this.selectedIndex]?.displayName || '';
      const inputText = `[${scriptName}]> ${this.inputModeText}_`;
      const inputIndicator = new TextRenderable(this.renderer, {
        id: 'input-indicator',
        content: t`${fg(COLORS.success)(inputText)}`,
      });
      leftSide.add(inputIndicator);
    }
    
    // Color filter indicator if active on focused pane
    if (focusedPane?.colorFilter) {
      const colorMap = {
        red: COLORS.error,
        yellow: COLORS.warning,
        green: COLORS.success,
        blue: COLORS.accent,
        cyan: COLORS.cyan,
        magenta: COLORS.magenta,
      };
      const colorIndicator = new TextRenderable(this.renderer, {
        id: 'color-filter-indicator',
        content: t`${fg(colorMap[focusedPane.colorFilter] || COLORS.text)(`[${focusedPane.colorFilter}]`)}`,
      });
      leftSide.add(colorIndicator);
    }
    
    footerBar.add(leftSide);
    
    // Right side: shortcuts and title
    const rightSide = new BoxRenderable(this.renderer, {
      id: 'footer-right',
      flexDirection: 'row',
      gap: 2,
    });
    
    const shortcuts = [
      { key: '\\', desc: 'panes', color: COLORS.cyan },
      { key: '1-9', desc: 'toggle', color: COLORS.success },
      { key: 'i', desc: 'input', color: COLORS.success },
      { key: 'n', desc: 'name', color: COLORS.accent },
      { key: 'p', desc: 'pause', color: COLORS.warning },
      { key: '/', desc: 'filter', color: COLORS.cyan },
      { key: 'c', desc: 'color', color: COLORS.magenta },
      { key: 's', desc: 'stop', color: COLORS.error },
      { key: 'r', desc: 'restart', color: COLORS.success },
      { key: 'o', desc: 'settings', color: COLORS.magenta },
      { key: 'q', desc: 'quit', color: COLORS.error },
    ];
    
    shortcuts.forEach(({ key, desc, color }) => {
      const shortcut = new TextRenderable(this.renderer, {
        id: `shortcut-${key}`,
        content: t`${fg(color)(key)}${fg(COLORS.textDim)(':' + desc)}`,
      });
      rightSide.add(shortcut);
    });
    
    // Title and version on far right
    const titleText = new TextRenderable(this.renderer, {
      id: 'footer-title',
      content: t`${fg(COLORS.accent)('running')} ${fg(COLORS.textDim)(APP_VERSION)}`,
    });
    rightSide.add(titleText);
    
    footerBar.add(rightSide);
    mainContainer.add(footerBar);
    
    // Add command palette overlay if active
    if (this.showSplitMenu) {
      this.buildSplitMenuOverlay(mainContainer);
    }
    
    // Add run command modal if active
    if (this.showRunCommandModal) {
      this.buildRunCommandModal(mainContainer);
    }
    
    // Add command output overlay if active
    if (this.showCommandOverlay) {
      this.buildCommandOverlay(mainContainer);
    }
    
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
  renderer.start(); // Start the automatic render loop
  const manager = new ProcessManager(renderer, scripts);
  
  // Handle cleanup on exit
  const handleExit = () => {
    manager.cleanup();
    renderer.destroy();
  };
  
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
