#!/usr/bin/env bash
set -eu
[ -z "${CODEZILLA_THREAD_ID:-}" ] && exit 0
[ -z "${CODEZILLA_EVENT_LOG:-}" ] && exit 0

ts=$(/bin/date +%s.%N)

stdin_payload=$(cat || true)
tool_name=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_name":"\([^"]*\)".*/\1/p' | head -1)

# Mirrors pre-tool-use.sh extraction — see comments there. Codex has no
# TaskUpdate / TodoWrite analogues so plan-progress fields are omitted.
tool_target=""
case "$tool_name" in
  Bash)
    tool_target=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{[^}]*"command":"\([^"]*\)".*/\1/p' | head -1)
    ;;
esac

if [ -n "$tool_target" ] && [ ${#tool_target} -gt 200 ]; then
  tool_target=$(printf '%s' "$tool_target" | cut -c1-200)
fi

escape_json() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

extra='{}'
if [ -n "$tool_name" ]; then
  extra='{"tool_name":"'"$tool_name"'"'
  if [ -n "$tool_target" ]; then
    extra="$extra"',"tool_target":"'"$(escape_json "$tool_target")"'"'
  fi
  extra="$extra"'}'
fi

printf '{"event":"tool_use","thread_id":"%s","ts":%s,"producer":"codex","extra":%s}\n' \
  "$CODEZILLA_THREAD_ID" "$ts" "$extra" \
  >> "$CODEZILLA_EVENT_LOG"
