import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings } from '../settings.ts';

test('liveview settings default when no project settings exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveview-settings-'));
  try {
    assert.deepEqual(loadSettings(dir), {
      splitView: false,
      panelWidth: '30%',
      minTermWidth: 80,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('liveview settings merge project .pi/settings.json with defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveview-settings-'));
  try {
    fs.mkdirSync(path.join(dir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'settings.json'), JSON.stringify({ liveview: { splitView: true, panelWidth: '50%' } }));

    assert.deepEqual(loadSettings(dir), {
      splitView: true,
      panelWidth: '50%',
      minTermWidth: 80,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveSettings preserves unrelated settings keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveview-settings-'));
  try {
    fs.mkdirSync(path.join(dir, '.pi'), { recursive: true });
    const settingsPath = path.join(dir, '.pi', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'x', liveview: { splitView: false } }));

    saveSettings(dir, { splitView: true, panelWidth: '30%', minTermWidth: 100 });

    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(parsed.model, 'x');
    assert.deepEqual(parsed.liveview, { splitView: true, panelWidth: '30%', minTermWidth: 100 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
