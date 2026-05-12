#!/usr/bin/env bash
set -eu
[ -z "${CODEZILLA_THREAD_ID:-}" ] && exit 0
[ -z "${CODEZILLA_EVENT_LOG:-}" ] && exit 0

ts=$(/bin/date +%s.%N)

# Claude Code passes hook context as JSON on stdin. Extract tool_name with a
# minimal regex (avoid jq dependency).
stdin_payload=$(cat || true)
tool_name=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_name":"\([^"]*\)".*/\1/p' | head -1)

# Per-tool target: a short user-facing string identifying *what* the tool is
# acting on. Drives the "Reading package.json" / "Running npm test" subtitles.
# Meta tools (AskUserQuestion, *PlanMode, TodoWrite, TaskUpdate) have no
# meaningful target; the reducer ignores tool_target for those.
tool_target=""
case "$tool_name" in
  Read|Write|Edit)
    tool_target=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{[^}]*"file_path":"\([^"]*\)".*/\1/p' | head -1)
    ;;
  Bash)
    tool_target=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{[^}]*"command":"\([^"]*\)".*/\1/p' | head -1)
    ;;
  Grep|Glob)
    tool_target=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{[^}]*"pattern":"\([^"]*\)".*/\1/p' | head -1)
    ;;
  TaskCreate)
    tool_target=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{[^}]*"subject":"\([^"]*\)".*/\1/p' | head -1)
    ;;
  WebFetch)
    tool_target=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{[^}]*"url":"\([^"]*\)".*/\1/p' | head -1)
    ;;
esac

# Truncate so we don't ship megabyte values through the event log if a path
# or command happens to be enormous. Frontend can do its own further trim.
if [ -n "$tool_target" ] && [ ${#tool_target} -gt 200 ]; then
  tool_target=$(printf '%s' "$tool_target" | cut -c1-200)
fi

# Escape backslashes and double quotes so the captured value embeds cleanly
# into our JSON output. Doesn't fully cover all JSON edge cases (control
# chars, lone surrogates) but handles the common ones — file paths and
# bash commands. Worst case: a malformed line; the watcher skips it.
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

printf '{"event":"pre_tool_use","thread_id":"%s","ts":%s,"producer":"claude","extra":%s}\n' \
  "$CODEZILLA_THREAD_ID" "$ts" "$extra" \
  >> "$CODEZILLA_EVENT_LOG"
