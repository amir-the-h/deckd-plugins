#!/bin/sh
# Claude Code hook for the Claude Code Sessions deck plugin. Claude Code runs it on session and tool
# events with the event's JSON on stdin; it keeps one small state file per session in a private
# folder the plugin watches. Nothing leaves the machine. See the plugin's README for the hook setup.
# Hooks run in the background ("async"), so each write carries the time it was made in nanoseconds
# and never replaces a newer one.

seq=$(date +%s%N 2>/dev/null)
case $seq in *N | "") seq=$(date +%s)000000000 ;; esac

if [ -n "$XDG_RUNTIME_DIR" ]; then
  dir="$XDG_RUNTIME_DIR/claude-deck-sessions"
else
  dir="/tmp/claude-deck-sessions-$(id -u)"
fi

input=$(cat)

# get TEXT NAME: the value of a top-level string field. Names inside string values are escaped
# (\"name\"), so they never match.
get() {
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}
# raw TEXT NAME: a string field's value still JSON-escaped, so it can be written back as is.
raw() {
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\(\([^\"\\\\]\|\\\\.\)*\)\".*/\1/p" | head -n 1
}
# num TEXT NAME: the value of a numeric field.
num() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p" | head -n 1
}

sid=$(get "$input" session_id)
case $sid in "" | */* | .*) exit 0 ;; esac
file="$dir/$sid.json"

case $(get "$input" hook_event_name) in
  SessionStart) state=idle ;;
  UserPromptSubmit | PostToolUse | PostToolUseFailure | PermissionDenied | ElicitationResult) state=working ;;
  PreToolUse)
    case $(get "$input" tool_name) in
      AskUserQuestion | ExitPlanMode) state=waiting ;; # Claude is asking you something
      *) state=working ;;
    esac ;;
  PermissionRequest | Elicitation) state=waiting ;;
  Notification)
    case $(get "$input" notification_type) in
      permission_prompt | elicitation_dialog | elicitation_url_dialog | agent_needs_input) state=waiting ;;
      *) exit 0 ;;
    esac ;;
  Stop) state=done ;;
  StopFailure) state=error ;;
  SessionEnd) rm -f "$file"; exit 0 ;;
  *) exit 0 ;;
esac

umask 077
mkdir -p "$dir" || exit 0
now=${seq%?????????}

# Keep when the session started and since when it has been in this state. Where the session runs
# (its process, tmux pane, terminal) is worked out once and kept.
started=$now
since=$now
located=
if [ -r "$file" ]; then
  old=$(cat "$file")
  [ "$(num "$old" seq)" -gt "$seq" ] 2>/dev/null && exit 0 # a later event already wrote
  started=$(num "$old" started)
  [ "$(get "$old" state)" = "$state" ] && since=$(num "$old" since)
  [ -n "$started" ] || started=$now
  [ -n "$since" ] || since=$now
  [ "$(num "$old" hook)" = 2 ] && located=yes
fi

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if [ -n "$located" ]; then
  where=$(printf '%s' "$old" | sed -n 's/.*\("pid":.*"kittyListen":"\([^"\\]\|\\.\)*"\).*/\1/p')
else
  parent() { sed -n 's/^PPid:[[:space:]]*//p' "/proc/$1/status" 2>/dev/null; }
  # envof PID NAME: a variable from that process's environment.
  envof() { tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n "s/^$2=//p" | head -n 1; }

  # The Claude Code process: skip the shell running this hook, then climb through Claude's own
  # processes (it may run sessions under a background host) to the one started from your shell or
  # terminal. That one lives as long as the session and still has the terminal's environment, which
  # Claude Code strips from the processes below it.
  pid=$PPID
  while [ -r "/proc/$pid/comm" ]; do
    case $(cat "/proc/$pid/comm") in
      sh | bash | dash | zsh | fish | ksh) pid=$(parent "$pid") ;;
      *) break ;;
    esac
  done
  while :; do
    up=$(parent "$pid")
    [ -n "$up" ] && [ "$up" -gt 1 ] || break
    tr '\0' ' ' < "/proc/$up/cmdline" 2>/dev/null | grep -q claude || break
    pid=$up
  done
  pidstart=$(cut -d' ' -f22 "/proc/$pid/stat" 2>/dev/null)

  tmux_=${TMUX:-$(envof "$pid" TMUX)}
  pane=${TMUX_PANE:-$(envof "$pid" TMUX_PANE)}
  kwin=${KITTY_WINDOW_ID:-$(envof "$pid" KITTY_WINDOW_ID)}
  klisten=${KITTY_LISTEN_ON:-$(envof "$pid" KITTY_LISTEN_ON)}
  where=$(printf '"pid":%s,"pidStart":"%s","tmux":"%s","tmuxPane":"%s","kittyWindow":"%s","kittyListen":"%s"' \
    "${pid:-0}" "$pidstart" "$(esc "$tmux_")" "$(esc "$pane")" "$(esc "$kwin")" "$(esc "$klisten")")
fi

tmp="$file.$$"
printf '{"hook":2,"session":"%s","state":"%s","seq":%s,"since":%s,"started":%s,"cwd":"%s","account":"%s",%s}\n' \
  "$sid" "$state" "$seq" "$since" "$started" \
  "$(raw "$input" cwd)" \
  "$(esc "${CLAUDE_CONFIG_DIR:-$HOME/.claude}")" \
  "$where" > "$tmp" && mv -f "$tmp" "$file"
exit 0
