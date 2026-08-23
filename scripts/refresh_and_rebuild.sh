#!/bin/bash
# Weekly maintenance job (invoked by the launchd agent installed via
# scripts/install_weekly_refresh.sh): re-downloads EasyList/EasyPrivacy,
# regenerates rules/ads.json + rules/trackers.json, and rebuilds the app so
# the refreshed rules are packaged in.
#
# Deliberately does NOT quit/relaunch Safari -- that would kill the user's
# open tabs unexpectedly during an unattended background run. Safari usually
# picks up a rebuilt extension on its own; if not, a manual quit+reopen (see
# README) forces it. This script only refreshes rules and rebuilds the app.

set -euo pipefail

REPO_ROOT="/Users/tziporabrownstein/claude apps:extensions/safariadblocker"
PROJECT_DIR="$REPO_ROOT/Ad Tracker Blocker"
LOG_DIR="$REPO_ROOT/scripts/logs"
LOG_FILE="$LOG_DIR/refresh-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
exec >> "$LOG_FILE" 2>&1

echo "=== $(date) : starting weekly refresh ==="

/usr/bin/python3 "$REPO_ROOT/scripts/convert_filterlists.py" --max-rules 20000

cd "$PROJECT_DIR"
/usr/bin/xcodebuild \
  -project "Ad Tracker Blocker.xcodeproj" \
  -scheme "Ad Tracker Blocker" \
  -configuration Debug \
  -destination "platform=macOS" \
  build

echo "=== $(date) : refresh + rebuild finished OK ==="

# Prune logs older than 90 days so this doesn't grow forever.
find "$LOG_DIR" -name "refresh-*.log" -mtime +90 -delete
