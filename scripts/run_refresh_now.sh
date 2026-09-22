#!/bin/bash
# Triggers an immediate run of the installed daily refresh job, useful for
# testing without waiting for the next scheduled run. Requires
# install_weekly_refresh.sh to have been run first.
set -euo pipefail

launchctl kickstart -k "gui/$(id -u)/org.yasw.adtrackerblocker.refresh"
echo "Triggered. Check scripts/logs/ for progress -- the rebuild can take a minute or two."
