# Liveview - AI Handover Document

## Project Overview
`liveview` (`pi-bash-viewer`) is a Pi coding agent extension that provides a PTY-backed live terminal rendering for bash tool calls. When the AI agent runs long build commands (or when the user runs bash commands via `!`), this extension captures the output via `node-pty`, processes it through an `xterm-headless` emulator to handle ANSI sequences and cursor movements, and renders it in a live, auto-updating TUI.

## UI Modes
The extension supports two rendering modes:
1. **Split View Panel (Default/Preferred):** A persistent, right-aligned TUI panel. When enabled (via `/liveview`), the `bash` tool is forced to use the PTY, and all output streams into this dedicated panel.
2. **Transient Overlay:** If the split view is disabled, the extension falls back to rendering a temporary popup overlay that appears only while a specific bash command is running.

## Core Architecture & Key Files

* **`index.ts`**: The extension entry point. Registers commands (`/liveview`, `/bash-pty`, `/liveview-config`), listens to Pi events (`tool_execution_start/end`, `user_bash`), and wraps the built-in `bash` tool to route it through the PTY.
* **`settings.ts`**: Manages reading and writing user preferences (like split-view enablement and panel width) to `.pi/settings.json`.
* **`pty-execute.ts` & `pty-session.ts`**: Handles the lifecycle of the execution: spawning the `node-pty` process, capturing stdout, managing timeouts, and triggering renders.
* **`terminal-emulator.ts`**: Wraps `@xterm/headless`. Feeds raw PTY stdout into the virtual terminal and extracts visible grid snapshots (for the UI) and full stripped text (for the AI's context).
* **`panel.ts`**: Manages the persistent right-aligned split-view TUI panel. It can render both active live PTY sessions and a log of other tool events (like file reads/writes).
* **`overlay.ts`**: Manages the transient popup TUI overlay used when split view is disabled.
* **`widget.ts`**: Contains the lower-level ANSI rendering logic. It converts the terminal's viewport snapshot grid into an array of styled ANSI strings that the Pi UI can draw to the screen.

## Current Status
* **Stable:** The application is functionally complete regarding its core rendering and layout features. Dynamic resizing of the terminal emulator correctly tracks the UI available space.
* **Recent Fixes:** The initial terminal sizing bug was resolved (now defaulting to 40x120), a "Word Wrap" option was added to `/liveview-config` (defaulting to false to crop rather than wrap lines), and a global `F4` shortcut was added to toggle the split view.
* **Tests:** **All tests are currently passing and stable.** Recent adjustments were made to the test suite to handle known `node-pty` race conditions where rapid process exits during automated testing could drop buffered data. (No core code needed reverting; artificial test delays resolved the flakiness).

## Next Steps for AI
* **Read Only First:** Please review the current state of the codebase. The tests are green, and the layout engine is functioning. 
* **Wait for Instructions:** Do NOT initiate debugging loops or speculative refactoring. Wait for the user to provide specific feature requests or architectural directions.
