import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTerminalOverlayComponent, showLiveTerminal, hideLiveTerminal } from '../overlay.ts';

function makeSnapshot(text = '', rowCount = 3) {
  const lines = text.split('\n');
  return Array.from({ length: rowCount }, (_, row) => {
    const chars = (lines[row] ?? '').padEnd(20, ' ').slice(0, 20);
    return [...chars].map((ch) => ({
      ch,
      style: {
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        inverse: false,
        invisible: false,
        strikethrough: false,
        fgMode: 'default',
        fg: 0,
        bgMode: 'default',
        bg: 0,
      },
    }));
  });
}

function makeSession(overrides = {}) {
  return {
    id: `test-${Date.now()}`,
    command: `printf 'hello world'`,
    startedAt: Date.now(),
    rows: 4,
    visible: false,
    disposed: false,
    session: {
      exited: false,
      getViewportSnapshot: () => makeSnapshot('hello\nworld'),
      resize: () => {},
    },
    ...overrides,
  };
}

test('overlay component renders title, elapsed frame, and width-bounded terminal output', () => {
  const session = makeSession();
  let renders = 0;
  let closed = false;
  const component = new LiveTerminalOverlayComponent({ requestRender: () => { renders += 1; } }, undefined, session, () => { closed = true; });

  const lines = component.render(50);
  assert.match(lines.join('\n'), /Running: printf/);
  assert.match(lines.join('\n'), /hello/);
  assert.match(lines.join('\n'), /Esc\/q hide overlay/);
  assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, '').length <= 50));

  component.requestRender();
  assert.equal(renders, 1);

  component.handleInput('\x1b');
  assert.equal(closed, true);
  assert.equal(session.visible, false);
});

test('overlay component uses terminal height to render a taller full-height panel', () => {
  const session = makeSession({
    rows: 15,
    session: {
      exited: false,
      getViewportSnapshot: () => makeSnapshot(Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n'), 40),
      resize: () => {},
    },
  });
  const component = new LiveTerminalOverlayComponent({ requestRender() {}, terminal: { rows: 30 } }, undefined, session, () => {});

  const lines = component.render(60);
  assert.equal(lines.length, 30, 'terminal height should drive overlay render height');
  assert.ok(lines.length > 17, 'dynamic overlay should render more than fixed 15 content rows plus frame');
  assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, '').length <= 60));
});

test('showLiveTerminal uses overlay custom UI and closes it through hideLiveTerminal', () => {
  const session = makeSession();
  let component;
  let doneCalled = false;
  const widgets = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget(key, factory) {
        widgets.push({ key, factory });
      },
      custom(factory, options) {
        assert.equal(options.overlay, true);
        assert.equal(options.overlayOptions.anchor, 'top-right');
        assert.equal(options.overlayOptions.width, '50%');
        assert.equal(options.overlayOptions.maxHeight, '100%');
        assert.deepEqual(options.overlayOptions.margin, { top: 0, right: 0, bottom: 0, left: 0 });
        component = factory({ requestRender() {}, terminal: { rows: 30 } }, {}, {}, () => { doneCalled = true; });
        return Promise.resolve();
      },
    },
  };

  const handle = showLiveTerminal(ctx, session);
  assert.ok(handle);
  assert.ok(component);
  assert.equal(session.visible, true);
  assert.equal(widgets.length, 0);

  hideLiveTerminal(ctx, session);
  assert.equal(doneCalled, true);
  assert.equal(widgets.length, 1, 'cleanup still clears any stale widget fallback key');
});

test('showLiveTerminal falls back to the existing widget path when custom UI is unavailable', () => {
  const session = makeSession();
  const widgets = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget(key, factory) {
        widgets.push({ key, factory });
      },
    },
  };

  showLiveTerminal(ctx, session);
  assert.equal(widgets.length, 1);
  assert.equal(typeof widgets[0].factory, 'function');
  assert.equal(session.visible, true);

  hideLiveTerminal(ctx, session);
  assert.equal(widgets.at(-1).factory, undefined);
});
