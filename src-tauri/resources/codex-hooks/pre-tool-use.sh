#!/usr/bin/env bash
set -eu
[ -z "${CODEZILLA_THREAD_ID:-}" ] && exit 0
[ -z "${CODEZILLA_EVENT_LOG:-}" ] && exit 0

ts=$(/bin/date +%s.%N)

# Codex passes hook context as JSON on stdin (same model as Claude). Extract
# fields with minimal regex — no jq dependency.
stdin_payload=$(cat || true)

# Codex registers this same script for both PreToolUse and PermissionRequest.
# `hook_event_name` distinguishes them. PermissionRequest -> synthetic tool
# name the frontend reducer maps to awaiting_input.
hook_event_name=$(printf '%s' "$stdin_payload" | sed -n 's/.*"hook_event_name":"\([^"]*\)".*/\1/p' | head -1)

if [ "$hook_event_name" = "PermissionRequest" ]; then
  tool_name="PermissionRequest"
  tool_target=""
else
  tool_name=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_name":"\([^"]*\)".*/\1/p' | head -1)

  # Per-tool target — drives the per-tool subtitle. Codex's built-in tools are
  # Bash + apply_patch only; apply_patch's patch field isn't documented well
  # enough to safely extract per-file paths, so we leave its target empty (the
  # frontend renders "Editing files"). MCP tools (mcp__server__tool) carry
  # opaque args we don't try to surface in v1.
  tool_target=""
  case "$tool_name" in
    Bash)
      tool_target=$(printf '%s' "$stdin_payload" | sed -n 's/.*"tool_input":{[^}]*"command":"\([^"]*\)".*/\1/p' | head -1)
      ;;
  esac
fi

# Truncate so we don't ship megabyte values through the event log.
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

printf '{"event":"pre_tool_use","thread_id":"%s","ts":%s,"producer":"codex","extra":%s}\n' \
  "$CODEZILLA_THREAD_ID" "$ts" "$extra" \
  >> "$CODEZILLA_EVENT_LOG"
