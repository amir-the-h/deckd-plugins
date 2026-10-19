# deckd-plugins

Plugins for [deckd](https://github.com/amir-the-h/deckd), the Linux daemon for
Elgato Stream Deck hardware. They use the standard Elgato plugin format
(`.sdPlugin`), are plain Node.js with no dependencies and no build step, and
need Node.js ≥ 22.

| Plugin | What it does |
|---|---|
| [OBS Control](#obs-control) | Scenes, recording, streaming, replay buffer, audio inputs and stats in OBS Studio |
| [Discord Voice](#discord-voice) | Mute, deafen, push-to-talk and voice volume in the Discord app |
| [Key Light Control](#key-light-control) | Power, brightness and colour temperature of Elgato Key Lights |
| [Hyprland Shader](#hyprland-shader) | Cycle or toggle Hyprland screen shaders |
| [Server Monitor](#server-monitor) | Prometheus metrics and web service health checks |
| [qBittorrent](#qbittorrent) | Transfer speeds and controls for your qBittorrent client |
| [Claude Usage](#claude-usage) | Claude Code plan limits and token counts |

## Install

In deckd's UI, go to **Plugins → Plugin sources** and add this repository:

```
https://github.com/amir-the-h/deckd-plugins
```

Every plugin here is then listed with an **Install** button, and new releases
show up as updates. Single plugins can also be installed from a release's
download link (**Plugins**, paste the link) or with
`deckd install <link>`.

To work on a plugin, link its folder into deckd instead, so edits apply without
reinstalling:

```bash
git clone https://github.com/amir-the-h/deckd-plugins
ln -s "$PWD/deckd-plugins/me.the-h.obs.sdPlugin" ~/.config/deckd/plugins/
systemctl --user restart deckd
```

`scripts/pack.sh` builds `dist/<uuid>.streamDeckPlugin` for every plugin plus
the `dist/index.json` deckd reads; pushing a `v*` tag publishes both as a
release.

Each plugin then appears in the **Actions** tab of the deckd UI. Drag an action
onto a key or dial and click it to open its settings. Settings marked "all
buttons" (server addresses, passwords) are shared by every button of that
plugin and stored in `~/.config/deckd/plugin-data/<plugin>.json`.

## OBS Control

Talks to the WebSocket server built into OBS Studio 28 and newer. Enable it in
OBS under **Tools → WebSocket Server Settings**, then enter the port and, if
authentication is on, the password in any OBS button's settings.

- **Scene**: switch to a scene; the key is outlined while that scene is live.
- **Record**, **Stream**, **Replay Buffer**: start or stop; outlined while on.
- **Save Replay**: save the replay buffer.
- **Audio Input**: mute or unmute an input; on a dial, turn to change its
  volume in dB.
- **Stats**: frame rate, CPU use and dropped frames.

Buttons follow changes made in OBS itself, and reconnect when OBS restarts.

## Discord Voice

Talks to the Discord desktop app (native, Flatpak or Snap) over its local RPC
socket.

- **Mute**, **Deafen**: toggle; outlined in red while on.
- **Push to Talk**: unmutes while the key is held.
- **Voice Volume**: output or microphone volume; on a dial, turn to change it
  and push to deafen or mute.

Discord only allows voice control for apps you own, so this needs a free app
of your own:

1. Create an application at <https://discord.com/developers/applications>.
2. Under **OAuth2**, copy the client ID and client secret into any Discord
   button's settings.
3. Under **OAuth2 → Redirects**, add `http://localhost`.
4. With Discord open, accept the **Authorize** prompt it shows once.

The secret and the sign-in token are stored in plain text in deckd's plugin
data.

## Key Light Control

Controls Elgato Key Light, Key Light Air, Ring Light and Light Strip over
their local HTTP API.

- **Light On/Off** (key): toggle; hold to make the light blink.
- **Light Brightness**, **Light Temperature** (dials): turn to adjust; push for
  50% / neutral, hold for 100% / coolest.
- **Choose Light** (dial): turn to pick which light the other actions control;
  push to search again.
- **Blink Light** (key): make the selected light blink so you can tell which
  one it is.

Lights are found with mDNS (`avahi-browse`, from Avahi). If yours aren't found,
list their IP addresses in the settings. Each button's colours can be changed
there too.

## Hyprland Shader

Applies the `.glsl` screen shaders in `~/.config/hypr/shaders` (or its
`animated/` folder) through `hyprctl`.

- **Cycle** (dial): turn to pick a shader, push or tap the strip to turn it on
  or off. The strip shows its name, ON/OFF and its position in the folder.
- **One shader** (key or dial): press to turn a chosen shader on or off.

Works with both Lua (`hyprctl eval`) and classic hyprlang configs. While a
shader is on, damage tracking is turned off so the whole screen stays shaded.

## Server Monitor

- **Prometheus stat**: the result of any PromQL query as a number or gauge,
  with warn/critical thresholds (above or below), units, formats (percent,
  bytes, bit rates, OK/FAIL), an optional second query for the bottom line, and
  a link to open on press. Use **Test query** in its settings to check it.
- **Service health**: up/down dots for a list of `Name=URL` lines. Anything
  answering below HTTP 500, redirects and login pages included, counts as up.

Set the **Default server** once in any stat button's settings; it falls back to
`http://localhost:9090`. Services with certificates from a private CA work as
long as the CA is in the system trust store.

## qBittorrent

A remote for the qBittorrent client you run, through its built-in WebUI. It
shows what the client is doing and offers the same controls as the WebUI's
toolbar; it doesn't search for or add anything.

- **Transfer Status**: download and upload speed and the number of active
  torrents. Press to stop or start all of them; on a dial, tap the strip to
  toggle the alternative speed limits.

Enable the WebUI in qBittorrent under **Tools → Options → Web UI** and set its
address as the **Default URL** (falls back to `http://localhost:8080`). The
username and password are only needed when the WebUI doesn't bypass
authentication for your network; they're stored in plain text in deckd's page
files.

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
Code's local transcripts and never leave your machine.

## Trademarks

These plugins are independent and not affiliated with or endorsed by Elgato,
Corsair, the OBS Project, Discord, qBittorrent or Anthropic. Product names are
used only to say what each plugin works with.

## Writing your own

deckd's repository includes a plugin template and a guide to the protocol as
deckd implements it: see `.claude/skills/deckd-plugin-dev/` there.

## License

[MIT](LICENSE). Icons drawn from Material Design Icons are Apache 2.0.
