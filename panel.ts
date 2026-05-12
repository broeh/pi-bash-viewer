import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { OverlayHandle, TUI } from '@earendil-works/pi-tui';
import { buildWidgetAnsiLines, fitAnsiLine, type LiveSession } from './widget.ts';
import type { LiveViewSettings } from './settings.ts';

const MAX_EVENTS = 50;
const PANEL_MIN_HEIGHT = 10;

type PanelEvent = {
  kind: 'event';
  id: string;
  tool: string;
  text: string;
  ts: number;
};

type PanelEntry =
  | { kind: 'live-pty'; id: string; session: LiveSession; addedAt: number; seq: number }
  | PanelEvent;

export type PanelController = {
  attach(ctx: ExtensionContext): void;
  detach(): void;
  isAttached(): boolean;
  addLivePty(session: LiveSession): () => void;
  logEvent(tool: string, text: string): void;
  requestRender(): void;
};

type PanelTui = Pick<TUI, 'requestRender'> & { terminal?: { rows?: number } };

function shortCommand(command: string, max: number): string {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function visibleLength(line: string): number {
  return line.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function panelRows(tui: PanelTui, fallback = 20): number {
  const rows = tui.terminal?.rows;
  if (!Number.isFinite(rows) || !rows || rows <= 0) return fallback;
  return Math.max(PANEL_MIN_HEIGHT, Math.floor(rows));
}

class LivePanelComponent {
  constructor(
    private readonly tui: PanelTui,
    private readonly theme: Theme | undefined,
    private readonly getEntries: () => PanelEntry[],
  ) {}

  invalidate(): void {}
  handleInput(_data: string): void {}

  requestRender(): void {
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const entries = this.getEntries();
    const live = [...entries]
      .filter((entry): entry is Extract<PanelEntry, { kind: 'live-pty' }> => entry.kind === 'live-pty' && !entry.session.disposed)
      .sort((a, b) => b.addedAt - a.addedAt || b.seq - a.seq)[0];

    if (live) return this.renderLive(live, width);
    return this.renderEvents(entries.filter((entry): entry is PanelEvent => entry.kind === 'event'), width);
  }

  private renderLive(entry: Extract<PanelEntry, { kind: 'live-pty' }>, width: number): string[] {
    const session = entry.session;
    const status = session.session.exited ? 'Done' : 'Running';
    const title = `${status}: ${shortCommand(session.command, Math.max(12, width - 28))}`;
    const footer = 'Live viewer · /liveview toggles';
    const accent = this.theme ? undefined : '77;163;255';
    return buildWidgetAnsiLines({
      title,
      footer,
      snapshot: session.session.getViewportSnapshot(),
      width,
      rows: Math.max(1, panelRows(this.tui) - 2),
      elapsedMs: Date.now() - session.startedAt,
      ...(accent ? { accentColor: accent } : {}),
    });
  }

  private renderEvents(events: PanelEvent[], width: number): string[] {
    const accent = '\x1b[38;2;77;163;255m';
    const reset = '\x1b[0m';
    const innerWidth = Math.max(10, width - 2);
    const rows = Math.max(1, panelRows(this.tui) - 2);
    const title = ' Live viewer ';
    const topFill = '─'.repeat(Math.max(0, innerWidth - title.length));
    const lines = [`${accent}╭${title}${topFill}╮${reset}`];
    const body = [...events].sort((a, b) => b.ts - a.ts).slice(0, rows);
    if (body.length === 0) {
      lines.push(`${accent}│${reset}${fitAnsiLine('Waiting for live output…', innerWidth)}${accent}│${reset}`);
    } else {
      for (const event of body) {
        const age = Math.max(0, Math.floor((Date.now() - event.ts) / 1000));
        lines.push(`${accent}│${reset}${fitAnsiLine(`${event.tool} ${age}s ago · ${event.text}`, innerWidth)}${accent}│${reset}`);
      }
    }
    while (lines.length < rows + 1) {
      lines.push(`${accent}│${reset}${fitAnsiLine('', innerWidth)}${accent}│${reset}`);
    }
    lines.push(`${accent}╰${'─'.repeat(innerWidth)}╯${reset}`);
    return lines.map((line) => visibleLength(line) <= width ? line : fitAnsiLine(line, width));
  }
}

export function createPanelController(getSettings: () => LiveViewSettings): PanelController {
  const entries: PanelEntry[] = [];
  let ctx: ExtensionContext | undefined;
  let handle: OverlayHandle | undefined;
  let component: LivePanelComponent | undefined;
  let closeOverlay: (() => void) | undefined;
  let attaching = false;
  let nextSeq = 0;

  const requestRender = () => component?.requestRender();

  const controller: PanelController = {
    attach(nextCtx) {
      ctx = nextCtx;
      if (!nextCtx.hasUI || handle || attaching) return;
      const custom = (nextCtx.ui as unknown as { custom?: ExtensionContext['ui']['custom'] }).custom;
      if (typeof custom !== 'function') {
        nextCtx.ui.notify('Live split view requires custom overlay support; using popup mode.', 'warning');
        return;
      }

      attaching = true;
      try {
        const promise = custom.call(nextCtx.ui, (tui: TUI, theme: Theme, _keybindings: unknown, done: () => void) => {
          closeOverlay = () => done();
          component = new LivePanelComponent(tui, theme, () => entries);
          return component;
        }, {
          overlay: true,
          overlayOptions: () => {
            const settings = getSettings();
            return {
              anchor: 'right-center',
              width: settings.panelWidth,
              maxHeight: '80%',
              margin: 0,
              nonCapturing: true,
              visible: (termWidth: number) => termWidth >= settings.minTermWidth,
            };
          },
          onHandle: (nextHandle: OverlayHandle) => {
            handle = nextHandle;
          },
        });
        void Promise.resolve(promise).then(
          () => {
            handle = undefined;
            component = undefined;
            closeOverlay = undefined;
          },
          () => {
            handle = undefined;
            component = undefined;
            closeOverlay = undefined;
          },
        );
      } catch {
        nextCtx.ui.notify('Live split view failed to open; using popup mode.', 'warning');
      } finally {
        attaching = false;
      }
    },

    detach() {
      handle?.hide();
      closeOverlay?.();
      handle = undefined;
      component = undefined;
      closeOverlay = undefined;
      ctx = undefined;
    },

    isAttached() {
      return Boolean(handle || component);
    },

    addLivePty(session) {
      const entry = { kind: 'live-pty' as const, id: session.id, session, addedAt: Date.now(), seq: nextSeq++ };
      entries.push(entry);
      session.visible = true;
      session.requestRender = requestRender;
      if (ctx && getSettings().splitView) controller.attach(ctx);
      requestRender();
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
        if (session.requestRender === requestRender) session.requestRender = undefined;
        session.visible = false;
        requestRender();
      };
    },

    logEvent(tool, text) {
      entries.push({ kind: 'event', id: `event-${Date.now()}-${Math.random().toString(16).slice(2)}`, tool, text, ts: Date.now() });
      const eventEntries = entries.filter((entry) => entry.kind === 'event');
      for (const old of eventEntries.slice(0, Math.max(0, eventEntries.length - MAX_EVENTS))) {
        const index = entries.indexOf(old);
        if (index >= 0) entries.splice(index, 1);
      }
      requestRender();
    },

    requestRender,
  };

  return controller;
}
