#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/forma-indexer-agent-utils.sh"

LABEL="com.formaoffice.indexer"
DOMAIN="gui/$(id -u)"
for label in "$LABEL-reconcile" "$LABEL"; do
  stop_indexer_agent "$DOMAIN/$label"
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
echo "Uninstalled Forma file-change indexing and daily reconciliation. Forma index data remains available."
