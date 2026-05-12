# Split-View Live Viewer Plan

## Implementation status

Implemented in this extension as an overlay-based split view.

Current behavior:

- `/liveview` toggles persistent split-view mode.
- `/liveview-config` edits project-local `.pi/settings.json` values for `splitView`, `panelWidth`, and `minTermWidth`.
- When split view is enabled, model `bash` calls are forced to `usePTY=true`.
- `!` / `!!` user bash commands use the same PTY panel path.
- The panel is a right-anchored, non-capturing overlay with default width `30%`.
- Panel height is currently hardcoded in `panel.ts` as `maxHeight: '80%'`, giving roughly 10% vertical margin at top and bottom.
- `read`, `write`, and `edit` tool completions are logged as one-line events when no live PTY is active.

Important limitation remains: Pi still does not expose a viewport-reservation API, so the main chat is not reflowed to the left column. The panel visually overlays the right side.

## Goal

Replace the transient popup with a persistent right-side panel that is always visible while enabled. Left ~60% is normal Pi UI, right ~40% is the live viewer. Toggleable from settings. When enabled, the `bash` tool's `usePTY` is forced to `true`. Architected so future event sources (read/write/edit tool calls) can feed the same panel.

## Findings on Pi

- Extensions register via `pi.registerTool`, `pi.registerCommand`, `pi.on(event, ...)`. The current extension already does both.
- UI surfaces available to extensions:
  - `ctx.ui.setWidget(id, factory, { placement: "aboveEditor" | "belowEditor" })` — line-array widgets above or below the editor only. No "right side" placement.
  - `ctx.ui.custom(factory, { overlay: true, overlayOptions })` — floating overlay. Supports `anchor`, `width: "40%"`, `minWidth`, `maxHeight: "100%"`, `margin`, `visible(termWidth, termHeight)`, `onHandle`, and `nonCapturing: true`.
  - `ctx.ui.setFooter`, `setHeader`, `setEditorComponent`, `setWorkingIndicator` — none allow a column split.
  - `tui.showOverlay(component, { nonCapturing: true, ... })` from inside a `custom` callback returns an `OverlayHandle` for show/hide/focus.
- No documented API to shrink Pi's main render width. The main UI always renders at full terminal width.
- No "registerSetting" API. Extensions read JSON themselves (e.g. `.pi/settings.json` or own file) and provide their own command or `SettingsList` to mutate it.
- Tool event hooks exist for any tool: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`. Plus `tool_call` / `tool_result` for pre/post hooks.

## Feasibility verdict

Achievable as a right-anchored, full-height, non-capturing overlay. Pi itself does **not** support reflowing its main content into a narrower column, so a true split where Pi's chat wraps inside 60% width is **not** possible without modifying Pi. The compromise:

- The overlay floats on top. Pi continues to wrap text against the full terminal width.
- Output that would render in the right ~40% is visually covered by the panel. New Pi messages still write through underneath — they are not lost, just hidden where the panel sits.
- Long lines in Pi chat get clipped behind the panel. Soft-wrap by Pi will not avoid the panel.

Acceptable tradeoffs:
- Tail-style live output the panel shows is generally redundant with the chat's own tool output region.
- The panel is opt-in via a toggle. Users who can't tolerate the overlap turn it off.
- If a stricter split is needed later, it requires upstream Pi work (a viewport-shrink hook or "reserve right column" API). Out of scope here.

`nonCapturing: true` is critical — it lets the panel stay open while the user still types into Pi normally.

`usePTY` forcing is trivial: the existing `pi.registerTool({ name: "bash" })` override already wraps the original. Add a check on the persisted toggle and overwrite `params.usePTY` to `true` before dispatching.

## Architecture

A single long-lived "panel session" object owns:

1. A **panel handle** (`OverlayHandle`) created via `ctx.ui.custom({ overlay: true, overlayOptions: { anchor: "right-center", width: "40%", maxHeight: "100%", margin: 0, nonCapturing: true, visible: termWidth => termWidth >= 80 } })`.
2. A **feed model**: an ordered list of "panes" the panel can display. Initial pane types:
   - `live-pty` — the PTY snapshot for the active bash command. Replaces the current popup content.
   - `event` — append-only one-liners (placeholder for future read/write/edit entries).
3. A **renderer** that picks the active pane (current strategy: most recent live-pty wins; otherwise event log) and emits lines for the panel width.

The existing `widget.ts` already contains the rendering primitives (`buildWidgetAnsiLines`, `snapshotToAnsiContentLines`, `fitAnsiLine`, `formatElapsed`). Reuse them.

A new module owns the persistent panel lifecycle and the feed; existing PTY code feeds into the panel instead of opening its own overlay.

## File-level plan

### 1. `settings.ts` (new)

Read/write extension config in `.pi/settings.json` under a `liveview` key. Single source of truth.

```ts
export type LiveViewSettings = {
  splitView: boolean;      // master toggle
  panelWidth: string;      // default "40%"
  minTermWidth: number;    // default 80
};

export function loadSettings(cwd: string): LiveViewSettings;
export function saveSettings(cwd: string, settings: LiveViewSettings): void;
```

Storage: project-local `.pi/settings.json`. Read `liveview` object; merge with defaults. Fall back to global `~/.pi/agent/settings.json` if project file lacks the key. Write only the project file when toggled (least surprise).

### 2. `panel.ts` (new)

Owns the persistent panel.

```ts
export type PanelEntry =
  | { kind: "live-pty"; id: string; session: LiveSession }
  | { kind: "event"; id: string; tool: string; text: string; ts: number };

export type PanelController = {
  attach(ctx: ExtensionContext): Promise<void>;
  detach(): void;
  isAttached(): boolean;
  addLivePty(session: LiveSession): () => void;   // returns remove fn
  logEvent(tool: string, text: string): void;
  requestRender(): void;
};

export function createPanelController(getSettings: () => LiveViewSettings): PanelController;
```

`attach(ctx)` opens the overlay via `ctx.ui.custom(factory, { overlay: true, overlayOptions: () => ({...}), onHandle: h => ... })`. The factory returns the panel component (below). Uses `nonCapturing: true`. Stores the `OverlayHandle` for `setHidden`/`hide`. Uses a function-form `overlayOptions` so width/visibility recompute on terminal resize.

`detach()` calls `handle.hide()` and clears state.

Renders highest-priority entry: the most recent live-pty that is not yet disposed; otherwise the recent events list, newest at top. Title shows command for live-pty, or "Live viewer" otherwise. Footer shows hint text. Reuses `buildWidgetAnsiLines` for live-pty mode; for the event log mode it builds a simple bordered list with the same accent.

### 3. `panel-component.ts` (new) — or inline in `panel.ts`

```ts
class LivePanelComponent {
  constructor(tui, theme, controller) { ... }
  invalidate() {}
  handleInput(_data) {}      // nonCapturing => never called, kept for type
  render(width: number): string[]
}
```

### 4. `pty-execute.ts` (modify)

- Replace the `showLiveTerminal` / `hideLiveTerminal` calls with `panel.addLivePty(session)` / disposer.
- Keep the existing fallback to popup overlay only when split view is **disabled** (`settings.splitView === false`). This preserves current behavior when the user turns split view off.
- Keep all PTY lifecycle (kill, timeout, abort, idle, dispose) unchanged.

Sketch of the branch:

```ts
const settings = getSettings();
const cleanup = settings.splitView
  ? panel.addLivePty(session)
  : startPopupView(ctx, session);
try { /* existing wait-for-exit */ } finally {
  cleanup();
  /* existing dispose */
}
```

Where `startPopupView` is the current `setTimeout(showLiveTerminal, ...)` plus its hide call, extracted for clarity.

### 5. `index.ts` (modify)

- On extension load, instantiate `panelController` with `loadSettings` accessor.
- On `session_start` (new handler): if `settings.splitView`, call `panelController.attach(ctx)`.
- On `session_shutdown`: call `panelController.detach()`.
- In `bash` tool `execute`: if `settings.splitView`, set `params.usePTY = true` before dispatch.
- In `user_bash` handler: nothing changes — it already returns PTY operations.
- Register commands:
  - `/liveview` — toggle `splitView`, persist, attach/detach panel, notify.
  - `/liveview-config` — open a `SettingsList` to toggle `splitView` and pick `panelWidth` (e.g. 30/40/50%). Persist on change.

Tool-event future-proofing — add a single subscription up front so the data path exists even if it does nothing useful yet:

```ts
pi.on("tool_execution_end", (ev, _ctx) => {
  if (!getSettings().splitView) return;
  if (ev.toolName === "bash") return;          // bash already streams via live-pty
  if (!["read", "write", "edit"].includes(ev.toolName)) return;
  panelController.logEvent(ev.toolName, summarize(ev.args, ev.result));
});
```

`summarize` produces a single-line description (e.g. `read file/path.ts (210 lines)`). Future panes (diff view for edits, contents preview for reads) replace `logEvent` with richer entry types without changing the public flow.

### 6. Tests

Add `tests/panel.test.mjs`:
- Renders within provided width.
- Renders title/elapsed when a live-pty entry is present.
- Falls back to event-log mode when no live-pty.
- Handles disposed sessions (skips them).
- Toggle on/off via command updates `.pi/settings.json` and attaches/detaches.

Reuse the existing harness from `tests/overlay.test.mjs` and `tests/widget-concurrency.test.mjs` — they already inject a stub `ctx`/`ui`. Mock the overlay handle.

Update `tests/config-docs-parity.test.mjs` if it asserts the README/docs settings list.

### 7. README + docs

- README section: "Split view mode" — toggle, behavior, the overlap caveat, minimum terminal width.
- `docs/development_log.md`: log the change.
- This file (`split-view-plan.md`) stays as the design doc.

## Lifecycle / edge cases

- **Resize**: function-form `overlayOptions` recomputes width; `visible(termWidth)` hides panel below `minTermWidth`. Pi automatically re-renders on resize.
- **Multiple concurrent PTYs**: panel tracks a stack of `live-pty` entries; newest active wins. When one finishes (disposed), the stack falls back to the previous one, then to event log.
- **Bash override interaction**: the model sees `usePTY` in the tool schema. When split view is on, the override silently coerces to `true`. Optionally also rewrite the tool description so the model knows. Not required for v1.
- **No UI mode (`ctx.hasUI === false`)**: `attach()` no-ops; bash still runs (just without panel) and `usePTY` forcing is irrelevant since there's no live view.
- **Custom overlay unsupported**: existing `overlay.ts` already has a `typeof custom !== 'function'` fallback path; keep that path for the popup variant. The split-view path requires `custom` and `nonCapturing`; if unavailable, log a warning via `ctx.ui.notify` and stay in popup mode.
- **Toggle during a running command**: when turning on, attach panel; the currently running PTY is not retroactively added unless we track it. Track active PTY sessions in `panelController` so toggle-on attaches all current ones.
- **Persistence across sessions**: settings live in `.pi/settings.json`; respected on next launch.

## Implementation order (suggested PR-sized slices)

1. Extract popup vs split into a `view-mode` shim; introduce `settings.ts` and `/liveview` toggle (no panel yet, defaults to popup).
2. Add `panel.ts` with attach/detach and a live-pty pane (single entry). Wire `pty-execute.ts`.
3. Add event log pane + `tool_execution_end` subscription for read/write/edit.
4. Add `/liveview-config` SettingsList view and width option.
5. Tests, docs, README.

## Risks / open questions

- **Visual overlap on the right**: confirm with one manual test how much breaks visually in normal Pi chat. If unacceptable, consider falling back to "auto-collapse panel while user is typing" (`handle.setHidden(true)` on `input` event, restore on idle).
- **`nonCapturing` and focus**: confirm that with `nonCapturing: true` the Pi editor still receives all keys including Esc/Ctrl+C abort. Examples (`overlay-passive`, `overlay-focus`) suggest yes.
- **Overlay lifecycle**: `ctx.ui.custom` returns a Promise resolving when the overlay closes. We need a long-lived overlay; `onHandle` lets us control without awaiting. Fire-and-forget the promise with `.catch` to avoid unhandled rejection (current `overlay.ts` already does this).
- **`overlayOptions` as a function**: re-evaluated on render. If it's only evaluated once at open time, dynamic resize won't track. If so, add a resize listener that calls `handle.setHidden`/recreate. Verify against `overlay-qa-tests.ts` or by experiment.
- **`tool_call` vs `tool_execution_*` timing**: `tool_execution_start/update/end` is the right surface — fires for the actual execution, not the model's request. Confirm `args` and `result` shapes per tool when implementing.
