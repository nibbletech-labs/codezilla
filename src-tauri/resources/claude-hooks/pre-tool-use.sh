#!/usr/bin/env bash
set -eu
[ -z "${CODEZILLA_THREAD_ID:-}" ] && exit 0
[ -z "${CODEZILLA_EVENT_LOG:-}" ] && exit 0

ts=$(/bin/date +%s.%N)

# Claude Code passes hook context as JSON on stdin. Extract tool_name with a
# minimal regex (avoid jq dependency). Pattern: "tool_name":"<value>" — tool
# names are alphanumeric, so a simple capture works without full JSON parsing.
stdin_payload=$(cat || true)
tool_name=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_name":"\([^"]*\)".*/\1/p' | head -1)

if [ -n "$tool_name" ]; then
  printf '{"event":"pre_tool_use","thread_id":"%s","ts":%s,"producer":"codezilla","extra":{"tool_name":"%s"}}\n' \
    "$CODEZILLA_THREAD_ID" "$ts" "$tool_name" \
    >> "$CODEZILLA_EVENT_LOG"
else
  printf '{"event":"pre_tool_use","thread_id":"%s","ts":%s,"producer":"codezilla","extra":{}}\n' \
    "$CODEZILLA_THREAD_ID" "$ts" \
    >> "$CODEZILLA_EVENT_LOG"
fi
