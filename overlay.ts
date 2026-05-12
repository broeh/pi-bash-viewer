import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { buildWidgetAnsiLines, showWidget, WIDGET_PREFIX, type LiveSession } from './widget.ts';

const OVERLAY_MIN_WIDTH = 60;
const OVERLAY_MIN_HEIGHT = 15;
const OVERLAY_FRAME_LINES = 2;
const OVERLAY_FOOTER_LINES = 1;
const OVERLAY_MIN_OUTPUT_ROWS = 3;

export type LiveTerminalViewHandle = {
  close(): void;
  requestRender(): void;
};

function shortCommand(command: string, max = 80): string {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

type LiveTerminalTui = {
  requestRender: () => void;
  terminal?: {
    rows?: number;
  };
};

function getDynamicOverlayRows(tui: LiveTerminalTui, fallbackRows: number): number {
  const terminalRows = tui.terminal?.rows;
  if (!Number.isFinite(terminalRows) || terminalRows <= 0) return fallbackRows;

  const outputRows = Math.max(
    OVERLAY_MIN_OUTPUT_ROWS,
    Math.floor(terminalRows) - OVERLAY_FRAME_LINES - OVERLAY_FOOTER_LINES,
  );
  return outputRows + OVERLAY_FOOTER_LINES;
}

export class LiveTerminalOverlayComponent {
  constructor(
    private readonly tui: LiveTerminalTui,
    private readonly theme: Theme | undefined,
    private readonly session: LiveSession,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (data === '\x1b' || data === 'q' || data === 'Q') {
      this.session.visible = false;
      this.done();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const status = this.session.session.exited ? 'Done' : 'Running';
    const title = `${status}: ${shortCommand(this.session.command, Math.max(12, width - 28))}`;
    const footer = this.session.session.exited
      ? 'Done'
      : 'Esc/q hide overlay · command keeps running';
    const accent = this.theme ? undefined : '77;163;255';
    return buildWidgetAnsiLines({
      title,
      footer,
      snapshot: this.session.session.getViewportSnapshot(),
      width,
      rows: getDynamicOverlayRows(this.tui, this.session.rows),
      elapsedMs: Date.now() - this.session.startedAt,
      ...(accent ? { accentColor: accent } : {}),
    });
  }

  requestRender(): void {
    this.tui.requestRender();
  }
}

export function showLiveTerminal(ctx: ExtensionContext, session: LiveSession): LiveTerminalViewHandle | undefined {
  if (!ctx.hasUI || session.visible || session.disposed) return undefined;

  const custom = (ctx.ui as unknown as { custom?: ExtensionContext['ui']['custom'] }).custom;
  if (typeof custom !== 'function') {
    showWidget(ctx, session);
    return {
      close: () => ctx.ui.setWidget(`${WIDGET_PREFIX}${session.id}`, undefined),
      requestRender: () => session.requestRender?.(),
    };
  }

  session.visible = true;
  let component: LiveTerminalOverlayComponent | undefined;
  let closeOnce: (() => void) | undefined;

  const close = () => {
    if (!closeOnce) return;
    const done = closeOnce;
    closeOnce = undefined;
    done();
  };

  session.closeView = close;

  try {
    const promise = custom.call(ctx.ui, (tui: LiveTerminalTui, theme: Theme, _keybindings: unknown, done: () => void) => {
      closeOnce = () => done();
      component = new LiveTerminalOverlayComponent(tui, theme, session, () => {
        closeOnce = undefined;
        done();
      });
      session.requestRender = () => component?.requestRender();
      return component;
    }, {
      overlay: true,
      overlayOptions: {
        anchor: 'top-right',
        width: '50%',
        minWidth: OVERLAY_MIN_WIDTH,
        maxHeight: '100%',
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        visible: (termWidth: number, termHeight: number) => termWidth >= OVERLAY_MIN_WIDTH && termHeight >= OVERLAY_MIN_HEIGHT,
      },
    });

    void Promise.resolve(promise).catch(() => {
      if (session.disposed) return;
      session.visible = false;
      session.closeView = undefined;
      showWidget(ctx, session);
    });

    return {
      close,
      requestRender: () => component?.requestRender(),
    };
  } catch {
    session.visible = false;
    session.closeView = undefined;
    showWidget(ctx, session);
    return {
      close: () => ctx.ui.setWidget(`${WIDGET_PREFIX}${session.id}`, undefined),
      requestRender: () => session.requestRender?.(),
    };
  }
}

export function hideLiveTerminal(ctx: ExtensionContext | null, session: LiveSession) {
  session.closeView?.();
  session.closeView = undefined;
  if (ctx?.hasUI) {
    ctx.ui.setWidget(`${WIDGET_PREFIX}${session.id}`, undefined);
  }
}
