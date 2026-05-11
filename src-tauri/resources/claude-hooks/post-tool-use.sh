#!/usr/bin/env bash
set -eu
[ -z "${CODEZILLA_THREAD_ID:-}" ] && exit 0
[ -z "${CODEZILLA_EVENT_LOG:-}" ] && exit 0

ts=$(/bin/date +%s.%N)

# Claude Code passes hook context as JSON on stdin. Extract fields with
# minimal regex (avoid jq dependency).
stdin_payload=$(cat || true)
tool_name=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_name":"\([^"]*\)".*/\1/p' | head -1)

# Per-tool target (mirrors pre-tool-use.sh — see comments there).
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

if [ -n "$tool_target" ] && [ ${#tool_target} -gt 200 ]; then
  tool_target=$(printf '%s' "$tool_target" | cut -c1-200)
fi

escape_json() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Per-tool plan-progress fields. tool_input.status drives TaskUpdate
# transitions. For TodoWrite we count "status":"..." occurrences inside
# tool_input.todos[*].
task_status=""
todos_total=""
todos_done=""

case "$tool_name" in
  TaskUpdate)
    task_status=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{[^}]*"status":"\([^"]*\)".*/\1/p' | head -1)
    ;;
  TodoWrite)
    todos_section=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{"todos":\(\[[^]]*\]\).*/\1/p')
    if [ -n "$todos_section" ]; then
      todos_total=$(printf '%s' "$todos_section" | grep -o '"status":"[^"]*"' | wc -l | tr -d ' ')
      todos_done=$(printf '%s' "$todos_section" | grep -o '"status":"completed"' | wc -l | tr -d ' ')
    fi
    ;;
esac

# Build extra JSON inline.
extra='{}'
if [ -n "$tool_name" ]; then
  extra='{"tool_name":"'"$tool_name"'"'
  if [ -n "$tool_target" ]; then
    extra="$extra"',"tool_target":"'"$(escape_json "$tool_target")"'"'
  fi
  if [ -n "$task_status" ]; then
    extra="$extra"',"task_status":"'"$task_status"'"'
  fi
  if [ -n "$todos_total" ]; then
    extra="$extra"',"todos_total":'"$todos_total"',"todos_done":'"$todos_done"
  fi
  extra="$extra"'}'
fi

printf '{"event":"tool_use","thread_id":"%s","ts":%s,"producer":"codezilla","extra":%s}\n' \
  "$CODEZILLA_THREAD_ID" "$ts" "$extra" \
  >> "$CODEZILLA_EVENT_LOG"
