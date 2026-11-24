#!/usr/bin/env bash

stop_indexer_agent() {
  local service="$1"
  local pid attempt
  pid="$(launchctl print "$service" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }')" || true
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    # Give the Swift CLI time to finish its current request and release its owned model.
    launchctl kill SIGTERM "$service" 2>/dev/null || true
    for ((attempt = 0; attempt < 220; attempt++)); do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "The Forma indexer is still shutting down. Its LaunchAgent is still registered." >&2
      return 1
    fi
  fi

  launchctl bootout "$service" 2>/dev/null || true
  for ((attempt = 0; attempt < 20; attempt++)); do
    if ! launchctl print "$service" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "launchd is still removing the Forma indexing job." >&2
  return 1
}
