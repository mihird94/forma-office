#!/usr/bin/env bash
set -euo pipefail

LABEL="com.formaoffice.search"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$AGENTS_DIR/$LABEL.plist"
APP_BUNDLE="/Applications/Forma Search.app"
APP_EXEC="$APP_BUNDLE/Contents/MacOS/FormaSearch"
LOG_DIR="$HOME/Library/Logs/FormaOffice"
DOMAIN="gui/$(id -u)"

mkdir -p "$AGENTS_DIR" "$LOG_DIR"
chmod 700 "$LOG_DIR"
touch "$LOG_DIR/search.log"
chmod 600 "$LOG_DIR/search.log"

STAGING_DIR="$(mktemp -d "$AGENTS_DIR/.forma-search.XXXXXX")"
trap 'rm -f "$STAGING_DIR/$LABEL.plist"; rmdir "$STAGING_DIR" 2>/dev/null || true' EXIT

PLIST_STAGE="$STAGING_DIR/$LABEL.plist"
set_plist() { /usr/bin/plutil -insert "$1" "$2" "$3" "$PLIST_STAGE"; }

/usr/bin/plutil -create xml1 "$PLIST_STAGE"
set_plist Label -string "$LABEL"
set_plist ProgramArguments -xml '<array/>'
set_plist ProgramArguments.0 -string "$APP_EXEC"
set_plist ProgramArguments.1 -string "--background"
set_plist RunAtLoad -bool true
set_plist KeepAlive -xml '<dict><key>SuccessfulExit</key><false/></dict>'
set_plist ProcessType -string Interactive
set_plist StandardOutPath -string "$LOG_DIR/search.log"
set_plist StandardErrorPath -string "$LOG_DIR/search.log"

set_plist EnvironmentVariables -xml '<dict/>'
for variable in FORMA_INDEX_SUPPORT_DIR FORMA_INDEX_EMBED_PORT FORMA_INDEX_RUNTIME_DIR; do
  if [ -n "${!variable:-}" ]; then
    set_plist "EnvironmentVariables.$variable" -string "${!variable}"
  fi
done

/usr/bin/plutil -lint "$PLIST_STAGE"
mv -f "$PLIST_STAGE" "$PLIST_PATH"

if [ ! -d "$APP_BUNDLE" ] || [ ! -x "$APP_EXEC" ]; then
  echo "Installed LaunchAgent plist at $PLIST_PATH, but $APP_BUNDLE is not installed yet."
  echo "Build and install Forma Search.app first, then re-run this script to load the agent."
  exit 0
fi

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for ((attempt = 0; attempt < 20; attempt++)); do
  if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
echo "Installed and loaded Forma Search LaunchAgent ($LABEL). Press ⌃Space to search. Log: $LOG_DIR/search.log"
