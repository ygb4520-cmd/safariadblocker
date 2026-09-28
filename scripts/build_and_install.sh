#!/bin/bash
# Rebuilds the extension via xcodebuild and cleans up the DerivedData copy
# it leaves behind afterward.
#
# The Xcode scheme's own Build post-action already copies the signed app to
# ~/Applications on every build (Xcode GUI or CLI) -- that part's shared and
# always safe. This script's extra cleanup step is deliberately NOT part of
# that shared scheme: deleting the DerivedData copy is only safe for CLI-only
# builds like this one, which never launch anything afterward. A build
# triggered by Cmd+R in Xcode needs that DerivedData copy to still exist
# right after the build finishes, so Xcode's own Launch step can actually
# start the app -- deleting it there would break Cmd+R. This script is for
# terminal-only rebuilds (e.g. by Claude, iterating on source changes)
# where nothing launches afterward, so cleanup is safe.
set -euo pipefail

REPO_ROOT="/Users/tziporabrownstein/claude apps/Extensions/safariadblocker"
PROJECT_DIR="$REPO_ROOT/Ad Tracker Blocker"
DERIVED_DATA_APP="$HOME/Library/Developer/Xcode/DerivedData/Ad_Tracker_Blocker-cbndxuajqtnoigezzlqghcmyqkzq/Build/Products/Debug/Ad Tracker Blocker.app"

cd "$PROJECT_DIR"
xcodebuild -project "Ad Tracker Blocker.xcodeproj" -scheme "Ad Tracker Blocker" -configuration Debug build

if [ -e "$DERIVED_DATA_APP" ]; then
  rm -rf "$DERIVED_DATA_APP"
  echo "build_and_install: removed DerivedData copy (~/Applications copy is the only one left)"
fi
