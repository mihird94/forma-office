#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/forma-indexer-agent-utils.sh"

LABEL="com.formaoffice.indexer"
RECONCILE_LABEL="$LABEL-reconcile"
AGENTS_DIR="$HOME/Library/LaunchAgents"
INDEXER="$HOME/Library/Application Support/FormaOffice/bin/forma-indexer"
LOG_DIR="$HOME/Library/Logs/FormaOffice"
DOMAIN="gui/$(id -u)"

if [ ! -x "$INDEXER" ]; then
  echo "Build and install forma-indexer first with npm run build:mac." >&2
  exit 1
fi

if [ -n "${FORMA_INDEX_INTERVAL_SECONDS:-}" ]; then
  case "$FORMA_INDEX_INTERVAL_SECONDS" in
    *[!0-9]*|0) echo "FORMA_INDEX_INTERVAL_SECONDS must be a positive integer." >&2; exit 1 ;;
  esac
fi

mkdir -p "$AGENTS_DIR" "$LOG_DIR"
chmod 700 "$LOG_DIR"
touch "$LOG_DIR/indexer.log"
chmod 600 "$LOG_DIR/indexer.log"
STAGING_DIR="$(mktemp -d "$AGENTS_DIR/.forma-indexer.XXXXXX")"
trap 'rm -f "$STAGING_DIR/$LABEL.plist" "$STAGING_DIR/$RECONCILE_LABEL.plist"; rmdir "$STAGING_DIR"' EXIT

set_plist() { /usr/bin/plutil -insert "$1" "$2" "$3" "$plist"; }
write_plist() {
  local label="$1" command="$2"
  local plist="$STAGING_DIR/$label.plist"
  /usr/bin/plutil -create xml1 "$plist"
  set_plist Label -string "$label"
  set_plist ProgramArguments -xml '<array/>'
  set_plist ProgramArguments.0 -string "$INDEXER"
  set_plist ProgramArguments.1 -string "$command"
  set_plist ProgramArguments.2 -string --json
  set_plist ProcessType -string Background
  set_plist LowPriorityIO -bool true
  set_plist Nice -integer 10
  set_plist StandardOutPath -string "$LOG_DIR/indexer.log"
  set_plist StandardErrorPath -string "$LOG_DIR/indexer.log"

  if [ "$command" = watch ]; then
    set_plist RunAtLoad -bool true
    set_plist KeepAlive -xml '<dict><key>SuccessfulExit</key><false/></dict>'
  else
    set_plist StartCalendarInterval -xml '<dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>'
    if [ -n "${FORMA_INDEX_INTERVAL_SECONDS:-}" ]; then
      set_plist StartInterval -integer "$FORMA_INDEX_INTERVAL_SECONDS"
    fi
  fi

  # Both jobs must use the same state directory for an isolated profile.
  local variable
  set_plist EnvironmentVariables -xml '<dict/>'
  for variable in FORMA_INDEX_SUPPORT_DIR FORMA_INDEX_EMBED_PORT FORMA_INDEX_RUNTIME_DIR; do
    if [ -n "${!variable:-}" ]; then set_plist "EnvironmentVariables.$variable" -string "${!variable}"; fi
  done
  /usr/bin/plutil -lint "$plist"
}

write_plist "$LABEL" watch
write_plist "$RECONCILE_LABEL" request-sync
stop_indexer_agent "$DOMAIN/$RECONCILE_LABEL"
stop_indexer_agent "$DOMAIN/$LABEL"
for label in "$LABEL" "$RECONCILE_LABEL"; do
  mv -f "$STAGING_DIR/$label.plist" "$AGENTS_DIR/$label.plist"
  launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$label.plist"
done
echo "Installed Forma file-change indexing and daily reconciliation at 02:00. Log $LOG_DIR/indexer.log"
