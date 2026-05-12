import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type LiveViewSettings = {
  splitView: boolean;
  panelWidth: string;
  minTermWidth: number;
};

export const DEFAULT_LIVEVIEW_SETTINGS: LiveViewSettings = {
  splitView: false,
  panelWidth: '30%',
  minTermWidth: 80,
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): JsonObject | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSettings(value: unknown): Partial<LiveViewSettings> {
  if (!isObject(value)) return {};
  const settings: Partial<LiveViewSettings> = {};
  if (typeof value.splitView === 'boolean') settings.splitView = value.splitView;
  if (typeof value.panelWidth === 'string' && /^\d+%$/.test(value.panelWidth)) settings.panelWidth = value.panelWidth;
  if (typeof value.minTermWidth === 'number' && Number.isFinite(value.minTermWidth) && value.minTermWidth > 0) {
    settings.minTermWidth = Math.floor(value.minTermWidth);
  }
  return settings;
}

function settingsPath(cwd: string) {
  return join(cwd, '.pi', 'settings.json');
}

function globalSettingsPath() {
  return join(homedir(), '.pi', 'agent', 'settings.json');
}

export function loadSettings(cwd: string): LiveViewSettings {
  const global = normalizeSettings(readJsonFile(globalSettingsPath())?.liveview);
  const project = normalizeSettings(readJsonFile(settingsPath(cwd))?.liveview);
  return {
    ...DEFAULT_LIVEVIEW_SETTINGS,
    ...global,
    ...project,
  };
}

export function saveSettings(cwd: string, settings: LiveViewSettings): void {
  const path = settingsPath(cwd);
  const current = readJsonFile(path) ?? {};
  const next = {
    ...current,
    liveview: {
      ...normalizeSettings(current.liveview),
      ...settings,
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
