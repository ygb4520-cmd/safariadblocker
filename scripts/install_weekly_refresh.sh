#!/bin/bash
# Installs a launchd user agent that runs refresh_and_rebuild.sh every
# Sunday at 9am, refreshing rules/ads.json + rules/trackers.json from
# EasyList/EasyPrivacy and rebuilding the app. Safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_NAME="org.yasw.adtrackerblocker.refresh.plist"
DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$SCRIPT_DIR/logs"
cp "$SCRIPT_DIR/$PLIST_NAME" "$DEST"

# Unload first in case it's already installed (e.g. re-running after an edit).
launchctl bootout "gui/$(id -u)" "$DEST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "Installed. It will run every Sunday at 9:00 AM whenever this Mac is on."
echo "Logs land in: $SCRIPT_DIR/logs/"
echo ""
echo "To trigger a run right now (to test it): scripts/run_refresh_now.sh"
echo "To remove it later: scripts/uninstall_weekly_refresh.sh"
