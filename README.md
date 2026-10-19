# deckd-plugins

Plugins for [deckd](https://github.com/amir-the-h/deckd), the Linux daemon for
Elgato Stream Deck hardware. They use the standard Elgato plugin format
(`.sdPlugin`), are plain Node.js with no dependencies and no build step, and
need Node.js ≥ 22.

| Plugin | What it does |
|---|---|
| [Hyprland Shader](#hyprland-shader) | Cycle or toggle Hyprland screen shaders |
| [Homelab](#homelab) | Prometheus stats, web service health, qBittorrent |
| [Claude Usage](#claude-usage) | Claude Code plan limits and token counts |

## Install

Link a plugin into deckd while trying it out, so edits apply without
reinstalling:

```bash
git clone https://github.com/amir-the-h/deckd-plugins
ln -s "$PWD/deckd-plugins/me.the-h.homelab.sdPlugin" ~/.config/deckd/plugins/
systemctl --user restart deckd
```

Or build installable packages and add them from deckd's UI
(**Plugins → Install plugin or icon pack…**) or with `deckd install`:

```bash
scripts/pack.sh        # writes dist/<uuid>.streamDeckPlugin for every plugin
```

Each plugin then appears in the **Actions** tab of the deckd UI. Drag an action
onto a key or dial and click it to open its settings.

## Hyprland Shader

Applies the `.glsl` screen shaders in `~/.config/hypr/shaders` (or its
`animated/` folder) through `hyprctl`.

- **Cycle** (dial): turn to pick a shader, push or tap the strip to turn it on
  or off. The strip shows its name, ON/OFF and its position in the folder.
- **One shader** (key or dial): press to turn a chosen shader on or off.

Works with both Lua (`hyprctl eval`) and classic hyprlang configs. While a
shader is on, damage tracking is turned off so the whole screen stays shaded.

## Homelab

Three actions for self-hosted services; each works on keys and dials.

- **Prometheus stat**: the result of any PromQL query as a number or gauge,
  with warn/critical thresholds (above or below), units, formats (percent,
  bytes, bit rates, OK/FAIL), an optional second query for the bottom line, and
  a link to open on press. Use **Test query** in its settings to check it.
- **Service health**: up/down dots for a list of `Name=URL` lines. Anything
  answering below HTTP 500, redirects and login pages included, counts as up.
- **qBittorrent**: download and upload speed. Press to stop or start every
  torrent; tap the strip to toggle the alternative speed limits.

Set the **Default server** (Prometheus) and **Default URL** (qBittorrent) once
in any button's settings; every button uses them unless it has its own. They
fall back to `http://localhost:9090` and `http://localhost:8080`. Services with
certificates from a private CA work as long as the CA is in the system trust
store.

The qBittorrent username and password are only needed when the WebUI doesn't
bypass authentication for your network. They're stored in plain text in
deckd's page files.

## Claude Usage

Shows [Claude Code](https://claude.com/claude-code) plan usage:

- **Session limit** / **Weekly limit**: percentage used and time until reset.
- **Tokens**: tokens used this session, this week or today.
- **Overview** (dial or key): both limits as bars, plus tokens.

Each button can watch a different Claude Code login (config directory:
`~/.claude`, or another `CLAUDE_CONFIG_DIR`); logins found in your home
directory are listed in its settings.

Limits come from the same endpoint Claude Code's `/usage` command uses. It is
undocumented and may change or stop working. The plugin reads (and never
refreshes) the login token Claude Code stores in `.credentials.json`, so it
works on Linux but not on macOS, where Claude Code keeps the token in the
Keychain. Limits refresh every 5 minutes. Token counts are read from Claude
Code's local transcripts and never leave your machine. This plugin is not made
by or affiliated with Anthropic.

## Writing your own

deckd's repository includes a plugin template and a guide to the protocol as
deckd implements it: see `.claude/skills/deckd-plugin-dev/` there.

## License

[MIT](LICENSE)
