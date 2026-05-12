#!/usr/bin/env bash
set -eu
[ -z "${CODEZILLA_THREAD_ID:-}" ] && exit 0
[ -z "${CODEZILLA_EVENT_LOG:-}" ] && exit 0

ts=$(/bin/date +%s.%N)
printf '{"event":"turn_end","thread_id":"%s","ts":%s,"producer":"codex","extra":{}}\n' \
  "$CODEZILLA_THREAD_ID" "$ts" \
  >> "$CODEZILLA_EVENT_LOG"
