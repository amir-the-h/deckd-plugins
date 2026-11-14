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
| [GitHub Pull Requests](#github-pull-requests) | Open pull requests that need you, per organization |
| [Meeting Countdown](#meeting-countdown) | Countdown to your next meeting from a calendar feed, with one-press join |
| [Claude Code Sessions](#claude-code-sessions) | Which Claude Code sessions are working, need you or are done |
| [Docker Control](#docker-control) | Health of compose stacks and containers, with start, stop and restart |
| [Home Assistant](#home-assistant) | Live entity states, one-press control, dial adjustments and service calls |
| [DCS World Cockpit](#dcs-world-cockpit) | Cockpit switches, lights and knobs of the DCS World aircraft you're flying, live |

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
The connection stays open after you leave a page with OBS buttons, so OBS
doesn't announce a new connection every time you come back. To turn those
announcements off entirely, untick **Enable System Tray Alerts** in OBS's
WebSocket Server Settings.

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

## GitHub Pull Requests

Counts the open pull requests that need you, optionally limited to one or more
organizations:

- **Review Requests**: PRs where your review is requested, either from you or
  from a team you're on. The key shows how many came to you and how many to a team.
- **Needs My Attention**: your PRs with failed CI, a merge conflict or
  requested changes.
- **Waiting for Approvals**: your PRs with fewer approvals than the minimum
  you set (only reviews from people with write access count).
- **Ready to Merge**: your PRs that have enough approvals, passing CI and no
  conflicts.
- **Pull Request Overview**: all four counts on one key or dial.

Press a key to refresh it. On a dial, turn to step through the PRs; push or
tap the strip to refresh.

It signs in with the [GitHub CLI](https://cli.github.com)'s login
(`gh auth login`) unless you enter a token in any button's settings. Draft PRs
are never counted. Everything refreshes every 60 seconds, with
one request for all buttons.

## Meeting Countdown

Shows the meeting that's on now or up next from any calendar that offers an
iCal (`.ics`) address, with a live countdown that turns amber 10 minutes and red
2 minutes before it starts. While a meeting runs it shows the time left, until
the next one is 5 minutes away.

- **Key**: press to join when the meeting has a video link (Zoom, Google Meet,
  Teams, Webex, Whereby or Jitsi) and starts within 15 minutes or is on now;
  otherwise a press refreshes.
- **Dial**: turn to step through the meetings of the coming week, push to join
  the one shown, tap the strip to refresh.
- **Position** (per button): 1 shows the meeting on now or up next, 2 the one
  after it, and so on, so keys set to 1, 2 and 3 show your next three meetings.

Enter the calendar's private address in any button's settings. In Google
Calendar it's under **Settings → your calendar → Secret address in iCal
format**. Anyone with that address can read the calendar, so it is kept only in
deckd's plugin data on your computer. Meetings you declined and all-day events
are left out, and a `?` marks invites you haven't answered. The feed refreshes
every 10 minutes.

## Claude Code Sessions

Shows what each running [Claude Code](https://claude.com/claude-code) session
is doing: **working**, **needs you** (a permission prompt, a question or a plan
to approve; it blinks), **done** (your turn), **idle** or **error**, with how
long it has been that way.

- **Session**: one session's conversation title (the name you gave it with
  `/rename`, else the one Claude Code generates; the project folder until it
  has one), state and time. Position 1 is the oldest running session, 2 the
  next, and so on.
- **Sessions Overview**: how many need you, are working or are done. On a dial
  it lists the sessions; turn to pick one.

Press to bring a session up: its tmux window and pane are selected (switching
the attached tmux client if needed), and on Hyprland its terminal window is
focused. The overview key brings up the session that has needed you longest.
Each button can be limited to one Claude Code login by its config folder.

The plugin learns about sessions from a Claude Code hook. Add it to each config
folder you use (it backs up `settings.json` and keeps your other hooks):

```bash
~/.config/deckd/plugins/me.the-h.claude-sessions.sdPlugin/hooks/install.sh ~/.claude
```

Pass `--remove` to take it out again. The hook runs in the background and only
writes a small state file per session to a private folder under
`$XDG_RUNTIME_DIR`; nothing leaves your machine. Linux only.

## Docker Control

Health of your Docker compose stacks and containers, locally or on a server
through Portainer.

- **Stack**: how many of a compose project's containers run (`8/9`), and which
  are down or unhealthy. On a dial, turn to pick the whole stack or one of its
  containers.
- **Container**: up, unhealthy, starting or stopped, and for how long.
- **Docker Overview**: how many containers run, are down or are unhealthy.

Press a stack or container to stop it when anything in it runs, or start it
when it's all stopped (a button can be set to just refresh instead). Hold it for
a second to restart it; leave the slot's gestures unset in deckd so the plugin
can time the hold. Containers that join another container's network
(`network_mode: container:…`, e.g. apps behind a VPN gateway) start after it,
stop before it, and are restarted along with it. When connected through
Portainer, the Portainer container itself is never stopped.

In any button's settings, set the Docker address: a socket
(`unix:///var/run/docker.sock`, the default), a Docker API URL such as a socket
proxy, or your Portainer URL together with a Portainer access token (**My
account → Access tokens**). Containers you keep stopped on purpose can be listed
under Ignore so they don't count as down.

## Home Assistant

Live states from [Home Assistant](https://www.home-assistant.io) over its
WebSocket API, so buttons change the moment something changes in the house.

- **Entity**: any entity's state, with a level bar where it has one
  (brightness, fan speed, volume, cover position, battery). Pressing does what
  suits it: toggles lights, switches, fans, covers and booleans, runs scripts,
  activates scenes, presses buttons, locks or unlocks, plays or pauses media,
  starts or docks a vacuum. On a dial, turning adjusts brightness, fan speed,
  volume, target temperature, cover position or a number. A button can show one
  of the entity's attributes instead of its state (e.g. `battery_level`).
- **Service Call**: calls any service, with JSON data and an optional target
  entity, and can show an entity's state while it waits for the next press.
- **Vacuum**: a robot vacuum's state, battery and charging, plus cleaned area
  and time while it cleans. Press to start, or to pause and resume; hold for a
  second to stop it and send it to its dock (or, if set, stop where it is). On
  a dial, turn to pick a room from the vacuum's map, then press to clean just
  that room. Rooms come from the vacuum's `rooms` attribute; the room-cleaning
  call is found automatically for Dreame, Roborock and Xiaomi integrations, or
  can be set by hand with `"$room"` standing for the room's id. Leave the slot's
  gestures unset so the plugin can time the hold.

Enter Home Assistant's address and a long-lived access token (your profile →
**Security → Long-lived access tokens**) in any button's settings; the panel
then offers your entities and services to pick from.

## DCS World Cockpit

Keys and dials that work like the real controls of the DCS World aircraft
you're in: switches flip, buttons are held while the key is, knobs turn, and
everything shows its live position. Works with every aircraft that has a
clickable cockpit; Flaming Cliffs aircraft (Su-25T, F-15C…) have none.

- **Cockpit Switch**: any clickable control. A press does what clicking it
  does: flips a toggle, steps a multi-position switch round, or holds a button
  or spring-loaded switch while the key is held. It can also be set to step
  one way, go to one position, or use one side of a switch (e.g. engine crank
  LEFT or RIGHT). Shows the position, with an optional lamp in the corner.
- **Cockpit Knob**: a knob on a dial. Turn to adjust volume, brightness, a
  multi-position knob or a relative knob (radio channels, altimeter setting);
  push for the knob's own button. The touch strip shows the value and can
  span several segments.
- **Cockpit Light**: a warning, caution or indicator light, lit when it's lit
  in the cockpit, in its own colour. It can also press a control, e.g. a
  master caution light that resets when pressed.
- **DCS Status**: whether DCS is connected and which aircraft you're in; press
  to open that aircraft's page. Its settings hold the setup.
- **Key Command**: one of DCS's own input commands, the kind you'd bind to a
  keyboard key (throttle to IDLE or OFF, say). Put two in one slot with the tap
  and hold gestures for two commands on one key.
- **Button Picker**: a dial for a row of buttons, such as one side of a
  display's frame or the UFC keypad: turn to pick one, push to press it, or tap
  it on the touch strip. It can show a display's text too, like the UFC
  scratchpad, and for a display's frame buttons it labels each with the legend
  the display shows next to it right now (RDR, SURF, MENU…), placed using the
  aircraft's own display page scripts.
- **Read-out**: values from a cockpit display on a key or the touch strip,
  such as engine RPM, temperatures or fuel from the F/A-18C's IFEI.

**Setup.** Put a DCS Status button on a page and open its settings. The plugin
finds DCS through Steam's library list (or the paths you give it), including
the Proton prefix on Linux. Click **Install / repair hook**: this copies a small
script to `Saved Games/DCS/Scripts/deckd/` and adds one line to
`Scripts/Export.lua` that loads it. Your other export scripts keep working, an
existing `Export.lua` is backed up first, and **Remove hook** takes out only
that line and folder. Restart the mission afterwards.

**Controls come from your own install.** The plugin reads each aircraft's
cockpit scripts (`Mods/aircraft/<name>/Cockpit/Scripts/`) and lists every
clickable control and lamp, grouped by system and searchable. This needs a Lua
interpreter (`luajit` or `lua5.1`); without one the hook does the same scan
inside DCS the first time you fly an aircraft. Nothing from the game is
included in this plugin. Files in `overlays/` only add short labels, position
names and lamp colours for a few aircraft.

**Pages.** When you get into an aircraft the deck switches to the page named
after it (`FA-18C_hornet` or, with the overlay, `Hornet`; you can map others in
the settings), and back to a landing page (`DCS`) when you get out. Give that
landing page a Steam auto-switch rule for DCS (app 223750) so the deck goes
there when the game is focused.

**Following the flight.** An aircraft's overlay can name a page for each
phase (parked, taxiing, airborne) and a page to jump to while a warning or
caution light is on; the deck follows the phase once it has held for a few
seconds, jumps to the lights at once, and goes back to where you were when they
clear. On the ground or in the air comes from height above ground, or, where a
server hides it, from ground speed, which the hook works out from your own
position. Switching off "Follow aircraft" turns all of this off.

**How it talks to DCS.** The hook sends the cockpit values the deck needs over
UDP on localhost (port 7790) and takes clicks back on 7791, the same way a
mouse click in the cockpit works. Multiplayer servers can hide flight and
sensor data from export scripts, but cockpit switches aren't part of that.

To show text from a cockpit display (a radio channel on the UFC, say), click
**Write display list** while flying: it writes every display's elements to
`Saved Games/DCS/Logs/deckd-indicators.txt`, and a switch or knob can then
show one of them.

## Trademarks

These plugins are independent and not affiliated with or endorsed by Elgato,
Corsair, the OBS Project, Discord, qBittorrent, GitHub, Docker, Portainer, Home
Assistant, Eagle Dynamics or Anthropic. DCS World is a trademark of Eagle
Dynamics. Product names are used only to say what each plugin works with.

## Writing your own

deckd's repository includes a plugin template and a guide to the protocol as
deckd implements it: see `.claude/skills/deckd-plugin-dev/` there.

## License

[MIT](LICENSE). Icons drawn from Material Design Icons are Apache 2.0.
