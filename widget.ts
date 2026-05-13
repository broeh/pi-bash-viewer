import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { snapshotToAnsiContentLines } from './terminal-emulator.ts';
import type { PtyTerminalSession } from './pty-session.ts';

export const WIDGET_PREFIX = 'pi-bash-viewer/live/';
const DEFAULT_TITLE = 'Live terminal';
const DEFAULT_ACCENT_COLOR = '77;163;255';

export type LiveSession = {
  id: string;
  command: string;
  startedAt: number;
  rows: number;
  visible: boolean;
  disposed: boolean;
  timer?: NodeJS.Timeout;
  session: PtyTerminalSession;
  requestRender?: () => void;
  closeView?: () => void;
  finalSnapshot?: ReturnType<PtyTerminalSession['getViewportSnapshot']>;
  finalElapsedMs?: number;
};

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function buildTopBorder(title: string, innerWidth: number, elapsedMs: number): string {
  const timer = ` ${formatElapsed(elapsedMs)} `;
  const rawTitle = title ? ` ${title} ` : '';
  const titleText = rawTitle.slice(0, Math.max(0, innerWidth - timer.length));
  const fill = '─'.repeat(Math.max(0, innerWidth - titleText.length - timer.length));
  return `${titleText}${fill}${timer}`.padEnd(innerWidth, '─').slice(0, innerWidth);
}

export function fitAnsiLine(line: string, width: number): string {
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < line.length && visible < width) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      const match = line.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += line[i];
    visible += 1;
    i += 1;
  }
  return `${out}\x1b[0m${' '.repeat(Math.max(0, width - visible))}`;
}

export function buildWidgetAnsiLines({
  title = DEFAULT_TITLE,
  footer,
  snapshot,
  width,
  rows,
  elapsedMs = 0,
  accentColor = DEFAULT_ACCENT_COLOR,
}: {
  title?: string;
  footer?: string;
  snapshot: ReturnType<PtyTerminalSession['getViewportSnapshot']>;
  width: number;
  rows: number;
  elapsedMs?: number;
  accentColor?: string;
}): string[] {
  const accent = `\x1b[38;2;${accentColor}m`;
  const reset = '\x1b[0m';
  const innerWidth = Math.max(10, width - 2);
  const top = `${accent}╭${buildTopBorder(title, innerWidth, elapsedMs)}╮${reset}`;
  const bottom = `${accent}╰${'─'.repeat(innerWidth)}╯${reset}`;
  const bodyRows = footer ? Math.max(0, rows - 1) : rows;
  const bodySource = snapshotToAnsiContentLines(snapshot).slice(-bodyRows);
  const body = [];
  for (let i = 0; i < bodyRows; i += 1) {
    const line = fitAnsiLine(bodySource[i] ?? '', innerWidth);
    body.push(`${accent}│${reset}${line}${accent}│${reset}`);
  }
  if (footer) {
    body.push(`${accent}│${reset}${fitAnsiLine(footer, innerWidth)}${accent}│${reset}`);
  }
  return [top, ...body, bottom];
}

function makeWidgetFactory(session: LiveSession) {
  return (tui: any) => {
    session.requestRender = () => tui.requestRender();
    return {
      invalidate() {},
      render(width: number) {
        const desiredCols = Math.max(10, width - 2);
        const desiredRows = session.rows;

        if (!session.session.exited && !session.disposed) {
          const effectiveCols = session.wordWrap === false ? session.session.cols : desiredCols;
          if (session.session.cols !== effectiveCols || session.session.rows !== desiredRows) {
            session.session.resize(effectiveCols, desiredRows);
          }
        }

        const snapshot = session.finalSnapshot || session.session.getViewportSnapshot();
        const elapsedMs = session.finalElapsedMs ?? (Date.now() - session.startedAt);

        return buildWidgetAnsiLines({
          snapshot,
          width,
          rows: desiredRows,
          elapsedMs,
        });
      },
    };
  };
}

export function showWidget(ctx: ExtensionContext, session: LiveSession) {
  if (!ctx.hasUI || session.visible || session.disposed) return;
  session.visible = true;
  ctx.ui.setWidget(`${WIDGET_PREFIX}${session.id}`, makeWidgetFactory(session));
}

export function hideWidget(ctx: ExtensionContext | null, session: LiveSession) {
  if (!ctx || !ctx.hasUI) return;
  ctx.ui.setWidget(`${WIDGET_PREFIX}${session.id}`, undefined);
}
