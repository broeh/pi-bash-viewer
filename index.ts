import { createBashTool, getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, SettingsList, Text, type SettingItem } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { createPtyBashOperations, executePtyCommand } from './pty-execute.ts';
import { ensureSpawnHelperExecutable } from './spawn-helper.ts';
import { loadSettings, saveSettings, type LiveViewSettings } from './settings.ts';
import { createPanelController, type PanelController } from './panel.ts';

const bashViewerParams = Type.Object({
  command: Type.String({ description: 'Command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' })),
  usePTY: Type.Optional(Type.Boolean({ description: 'Run inside a PTY with a live terminal widget the user can see while its running. Use this when you suspect the program being ran has interesting ansi progress output, like buildsystems.' })),
});

ensureSpawnHelperExecutable();

function getSettingsFor(cwd: string): LiveViewSettings {
  return loadSettings(cwd);
}

function ptyOptions(settings: LiveViewSettings, panel: PanelController) {
  return settings.splitView ? { splitView: true, panel } : {};
}

async function runSlashCommand(args: string, ctx: ExtensionCommandContext, panel: PanelController) {
  const command = args.trim();
  if (!command) {
    ctx.ui.notify('Usage: /bash-pty <command>', 'error');
    return;
  }
  const settings = getSettingsFor(ctx.cwd);
  if (settings.splitView) panel.attach(ctx as unknown as ExtensionContext);
  const result = await executePtyCommand(
    `slash-${Date.now()}`,
    { command },
    new AbortController().signal,
    ctx as unknown as ExtensionContext,
    ptyOptions(settings, panel),
  );
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '(no output)';
  ctx.ui.notify(text.slice(0, 4000), 'info');
}

function summarizeToolEvent(ev: { toolName: string; args?: unknown; result?: unknown; isError?: boolean }, argsInput?: unknown): string {
  const args = argsInput && typeof argsInput === 'object' ? argsInput as Record<string, unknown> : {};
  const path = typeof args.path === 'string' ? args.path : undefined;
  const status = ev.isError ? 'failed' : 'completed';
  if (path) return `${path} ${status}`;
  return status;
}

async function openLiveviewConfig(ctx: ExtensionCommandContext, panel: PanelController) {
  let settings = getSettingsFor(ctx.cwd);

  const buildItems = (): SettingItem[] => [
    { id: 'splitView', label: 'Split view', currentValue: settings.splitView ? 'enabled' : 'disabled', values: ['enabled', 'disabled'] },
    { id: 'panelWidth', label: 'Panel width', currentValue: settings.panelWidth, values: ['30%', '40%', '50%'] },
    { id: 'minTermWidth', label: 'Minimum terminal width', currentValue: String(settings.minTermWidth), values: ['80', '100', '120'] },
  ];

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg('accent', theme.bold('Live Viewer Settings')), 1, 1));

    const settingsList = new SettingsList(
      buildItems(),
      8,
      getSettingsListTheme(),
      (id, newValue) => {
        if (id === 'splitView') settings = { ...settings, splitView: newValue === 'enabled' };
        if (id === 'panelWidth') settings = { ...settings, panelWidth: newValue };
        if (id === 'minTermWidth') settings = { ...settings, minTermWidth: Number(newValue) };
        saveSettings(ctx.cwd, settings);
        if (settings.splitView) panel.attach(ctx as unknown as ExtensionContext);
        else panel.detach();
        ctx.ui.notify(`liveview ${id} = ${newValue}`, 'info');
      },
      () => done(undefined),
      { enableSearch: false },
    );

    container.addChild(settingsList);
    return {
      render(width: number) { return container.render(width); },
      invalidate() { container.invalidate(); },
      handleInput(data: string) { settingsList.handleInput?.(data); _tui.requestRender(); },
    };
  });
}

export default function bashViewer(pi: ExtensionAPI) {
  const originalBash = createBashTool(process.cwd());
  let currentSettings = getSettingsFor(process.cwd());
  const panel = createPanelController(() => currentSettings);
  const toolArgs = new Map<string, unknown>();

  function refreshSettings(cwd: string) {
    currentSettings = getSettingsFor(cwd);
    return currentSettings;
  }

  pi.registerTool({
    name: 'bash',
    label: 'bash',
    description: `${originalBash.description} Supports optional usePTY=true live terminal rendering for terminal-style programs and richer progress UIs. When liveview split view is enabled, usePTY is forced to true.`,
    parameters: bashViewerParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const settings = refreshSettings(ctx.cwd);
      const effectiveParams = settings.splitView ? { ...params, usePTY: true } : params;
      if (settings.splitView) panel.attach(ctx);
      if (effectiveParams.usePTY !== true) {
        return originalBash.execute(toolCallId, effectiveParams, signal, onUpdate);
      }
      return executePtyCommand(toolCallId, effectiveParams, signal, ctx, ptyOptions(settings, panel));
    },
  });

  pi.on('session_start', (_event, ctx) => {
    const settings = refreshSettings(ctx.cwd);
    if (settings.splitView) panel.attach(ctx);
  });

  pi.on('session_shutdown', () => {
    panel.detach();
  });

  pi.on('tool_execution_start', (ev) => {
    toolArgs.set(ev.toolCallId, ev.args);
  });

  pi.on('tool_execution_end', (ev, ctx) => {
    const args = toolArgs.get(ev.toolCallId);
    toolArgs.delete(ev.toolCallId);
    const settings = refreshSettings(ctx.cwd);
    if (!settings.splitView) return;
    if (ev.toolName === 'bash') return;
    if (!['read', 'write', 'edit'].includes(ev.toolName)) return;
    panel.logEvent(ev.toolName, summarizeToolEvent(ev, args));
  });

  pi.on('user_bash', (_event, ctx) => {
    const settings = refreshSettings(ctx.cwd);
    if (settings.splitView) panel.attach(ctx);
    return {
      operations: createPtyBashOperations(ctx, ptyOptions(settings, panel)),
    };
  });

  pi.registerCommand('bash-pty', {
    description: 'Run a command through the PTY-backed bash path',
    handler: async (args, ctx) => {
      await runSlashCommand(args, ctx, panel);
    },
  });

  pi.registerCommand('liveview', {
    description: 'Toggle the persistent live viewer split-view panel',
    handler: async (_args, ctx) => {
      const next = { ...refreshSettings(ctx.cwd), splitView: !currentSettings.splitView };
      currentSettings = next;
      saveSettings(ctx.cwd, next);
      if (next.splitView) panel.attach(ctx as unknown as ExtensionContext);
      else panel.detach();
      ctx.ui.notify(`Live viewer split view ${next.splitView ? 'enabled' : 'disabled'}`, 'info');
    },
  });

  pi.registerCommand('liveview-config', {
    description: 'Configure the persistent live viewer panel',
    handler: async (_args, ctx) => {
      await openLiveviewConfig(ctx, panel);
    },
  });
}
