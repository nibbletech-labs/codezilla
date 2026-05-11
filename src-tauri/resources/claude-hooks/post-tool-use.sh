#!/usr/bin/env bash
set -eu
[ -z "${CODEZILLA_THREAD_ID:-}" ] && exit 0
[ -z "${CODEZILLA_EVENT_LOG:-}" ] && exit 0

ts=$(/bin/date +%s.%N)

# Claude Code passes hook context as JSON on stdin. Extract fields with
# minimal regex (avoid jq dependency). Patterns target specific keys that
# don't appear in user-provided strings during normal Claude operation.
stdin_payload=$(cat || true)
tool_name=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_name":"\([^"]*\)".*/\1/p' | head -1)

# Per-tool extra fields (only meaningful for the tools we care about; harmless
# otherwise). tool_input.status drives TaskUpdate transitions. For TodoWrite
# we count "status":"..." occurrences inside tool_input.todos[*].
task_status=""
todos_total=""
todos_done=""

case "$tool_name" in
  TaskUpdate)
    task_status=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{[^}]*"status":"\([^"]*\)".*/\1/p' | head -1)
    ;;
  TodoWrite)
    # tool_input.todos is an array of objects each with a "status" field.
    # Count by grepping "status":"<value>" entries — only present inside
    # the todos array under tool_input (tool_response status fields use
    # different keys like "statusChange").
    todos_section=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{"todos":\(\[[^]]*\]\).*/\1/p')
    if [ -n "$todos_section" ]; then
      todos_total=$(printf '%s' "$todos_section" | grep -o '"status":"[^"]*"' | wc -l | tr -d ' ')
      todos_done=$(printf '%s' "$todos_section" | grep -o '"status":"completed"' | wc -l | tr -d ' ')
    fi
    ;;
esac

# Build extra JSON inline (avoid temp files / jq). Always include tool_name
# when known; add per-tool fields when set.
extra='{}'
if [ -n "$tool_name" ]; then
  extra='{"tool_name":"'"$tool_name"'"'
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
