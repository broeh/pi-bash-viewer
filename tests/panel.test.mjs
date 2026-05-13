import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelController } from '../panel.ts';

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

function makeSession(command, text, overrides = {}) {
  return {
    id: `session-${Date.now()}-${Math.random()}`,
    command,
    startedAt: Date.now(),
    rows: 4,
    visible: false,
    disposed: false,
    session: {
      exited: false,
      getViewportSnapshot: () => makeSnapshot(text),
      resize: () => {},
    },
    ...overrides,
  };
}

function attachPanel(controller) {
  let component;
  let handleHidden = false;
  let hideCalled = false;
  let renders = 0;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory, options) {
        assert.equal(options.overlay, true);
        const overlayOptions = options.overlayOptions();
        assert.equal(overlayOptions.anchor, 'right-center');
        assert.equal(overlayOptions.width, '30%');
        assert.equal(overlayOptions.maxHeight, '80%');
        assert.equal(overlayOptions.nonCapturing, true);
        assert.equal(overlayOptions.visible(100, 30), true);
        component = factory({ requestRender() { renders += 1; }, terminal: { rows: 20 } }, undefined, {}, () => {});
        options.onHandle({
          hide() { hideCalled = true; },
          setHidden(value) { handleHidden = value; },
          isHidden() { return handleHidden; },
          focus() {},
          unfocus() {},
          isFocused() { return false; },
        });
        return Promise.resolve();
      },
    },
  };
  controller.attach(ctx);
  return { component, get renders() { return renders; }, get hideCalled() { return hideCalled; } };
}

test('panel renders event log mode when no live PTY is active', () => {
  const controller = createPanelController(() => ({ splitView: true, panelWidth: '30%', minTermWidth: 80 }));
  const attached = attachPanel(controller);

  controller.logEvent('read', 'file.ts completed');
  const lines = attached.component.render(50);

  assert.match(lines.join('\n'), /Live viewer/);
  assert.match(lines.join('\n'), /read/);
  assert.match(lines.join('\n'), /file\.ts completed/);
  assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, '').length <= 50));
  assert.ok(attached.renders >= 1);
});

test('panel renders newest live PTY and does not fall back when disposed/removed', () => {
  const controller = createPanelController(() => ({ splitView: true, panelWidth: '30%', minTermWidth: 80 }));
  const attached = attachPanel(controller);

  const oldSession = makeSession('printf old', 'old-output');
  const cleanupOld = controller.addLivePty(oldSession);
  const newSession = makeSession('printf new', 'new-output');
  const cleanupNew = controller.addLivePty(newSession);

  assert.match(attached.component.render(60).join('\n'), /new-output/);
  assert.doesNotMatch(attached.component.render(60).join('\n'), /old-output/);

  newSession.disposed = true;
  // Now it just shows the new session's final snapshot because it's disposed
  assert.match(attached.component.render(60).join('\n'), /new-output/);

  cleanupNew();
  assert.match(attached.component.render(60).join('\n'), /Waiting for live output/);
});

test('panel detach hides overlay handle', () => {
  const controller = createPanelController(() => ({ splitView: true, panelWidth: '30%', minTermWidth: 80 }));
  const attached = attachPanel(controller);
  assert.equal(controller.isAttached(), true);
  controller.detach();
  assert.equal(attached.hideCalled, true);
  assert.equal(controller.isAttached(), false);
});
