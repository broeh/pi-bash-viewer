# pi-bash-viewer

When agents emit tool calls calls for build systems, those calls can take a long time.
Often they have really nice visualizations of progress.
I cannot see those in pi, making me blind to what is happening.

This extension upgrades model-initiated `bash` calls with an optional PTY-backed live terminal view, and routes interactive `!` and `!!` commands through the same PTY live view.

[![Demo](assets/demo.gif)](https://github.com/lucasmeijer/pi-bash-live-view/releases/download/readme-assets/Screen.Recording.2026-03-20.at.22.27.36.web.mp4)

_Open the full demo video:_
https://github.com/lucasmeijer/pi-bash-live-view/releases/download/readme-assets/Screen.Recording.2026-03-20.at.22.27.36.web.mp4

## Install

```bash
pi install npm:pi-bash-viewer
```

## Split view mode

Use `/liveview` to toggle a persistent right-side live viewer panel. When enabled, model-initiated `bash` calls are automatically run with `usePTY=true`, and `!` / `!!` user bash commands stream into the same panel.

Use `/liveview-config` to adjust the panel width (`30%`, `40%`, `50%`) and minimum terminal width. Settings are stored project-locally in `.pi/settings.json` under the `liveview` key:

```json
{
  "liveview": {
    "splitView": true,
    "panelWidth": "30%",
    "minTermWidth": 80
  }
}
```

The panel height is currently configured in code via `panel.ts` (`maxHeight: '80%'`). Change that value and run `/reload` to test different heights.

Note: Pi does not currently expose an API to reserve terminal columns for extensions. The panel is a non-capturing right-anchored overlay, so the main Pi chat still renders at full width underneath it. Disable with `/liveview` if the visual overlap is undesirable.

