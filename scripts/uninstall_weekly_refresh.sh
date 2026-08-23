#!/bin/bash
# Removes the weekly refresh launchd agent installed by install_weekly_refresh.sh.
set -euo pipefail

PLIST_NAME="org.yasw.adtrackerblocker.refresh.plist"
DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

launchctl bootout "gui/$(id -u)" "$DEST" 2>/dev/null || true
rm -f "$DEST"

echo "Removed. The weekly rule refresh will no longer run automatically."
