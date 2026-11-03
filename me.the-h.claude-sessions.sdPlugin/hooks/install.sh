#!/bin/sh
# Adds the Claude Code Sessions hook to one or more Claude Code config folders, or removes it.
#
#   install.sh [--remove] [CONFIG_DIR ...]     (default: ~/.claude)
#
# Each folder's settings.json is backed up to settings.json.bak first. Other hooks and settings are
# kept; running it again doesn't add the hook twice. Needs jq.

set -eu

hook="$(cd "$(dirname "$0")" && pwd)/session-state.sh"
events='["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PostToolUseFailure","PermissionRequest","PermissionDenied","Notification","Elicitation","ElicitationResult","Stop","StopFailure","SessionEnd"]'

remove=false
if [ "${1:-}" = "--remove" ]; then remove=true; shift; fi
[ $# -gt 0 ] || set -- "$HOME/.claude"

command -v jq >/dev/null || { echo "install.sh: jq is needed" >&2; exit 1; }

for dir in "$@"; do
  file="$dir/settings.json"
  if [ ! -d "$dir" ]; then echo "skipping $dir: no such folder" >&2; continue; fi
  [ -s "$file" ] || echo '{}' > "$file"
  cp -p "$file" "$file.bak"
  jq --arg cmd "$hook" --argjson events "$events" --argjson remove "$remove" '
    # Drop this hook wherever it is (any install path), then add it back unless removing.
    def mine: (.command // "") | endswith("/session-state.sh") and test("claude-sessions");
    .hooks = ((.hooks // {})
      | with_entries(.value |= (map(.hooks |= map(select(mine | not))) | map(select((.hooks | length) > 0))))
      | with_entries(select((.value | length) > 0)))
    | if $remove then . else
        reduce $events[] as $e (.; .hooks[$e] = ((.hooks[$e] // []) + [{hooks: [{type: "command", command: $cmd, async: true}]}]))
      end
    | if (.hooks | length) == 0 then del(.hooks) else . end
  ' "$file.bak" > "$file.tmp"
  mv "$file.tmp" "$file"
  if $remove; then echo "removed the hook from $file"; else echo "added the hook to $file"; fi
done
echo "Restart running Claude Code sessions (or open /hooks) for the change to apply."
