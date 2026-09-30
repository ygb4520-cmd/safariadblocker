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
INSTALLED_APP="$HOME/Applications/Ad Tracker Blocker.app"

# Catch a file that was added to Resources/ but never wired into the Xcode
# project (the build would succeed and silently ship without it).
python3 "$REPO_ROOT/scripts/check_xcode_resources.py"

cd "$PROJECT_DIR"
xcodebuild -project "Ad Tracker Blocker.xcodeproj" -scheme "Ad Tracker Blocker" -configuration Debug build

if [ -e "$DERIVED_DATA_APP" ]; then
  rm -rf "$DERIVED_DATA_APP"
  echo "build_and_install: removed DerivedData copy (~/Applications copy is the only one left)"
fi

# Replacing the file at ~/Applications on every rebuild (rm -rf + ditto in
# the scheme's post-action) gives it a new inode each time. pluginkit's
# registration has been observed to silently NOT follow that -- the
# ~/Applications path having an app at it again doesn't guarantee macOS
# still considers the extension inside it registered. Re-register
# explicitly and verify, rather than assuming the build's own
# RegisterWithLaunchServices step was enough.
if [ -e "$INSTALLED_APP" ]; then
  # `pluginkit -a` reports success (exit 0) but was observed to NOT
  # actually register reliably -- even after waiting 10s+, polling. Actually
  # launching the container app is the mechanism that's reliably triggered
  # registration in practice, so use that instead: it opens a small SwiftUI
  # window (harmless, quit it manually if it's in the way).
  open "$INSTALLED_APP"
  registered=false
  # Registration timing after `open` has been observed to vary a lot (5s to
  # 15s+) -- poll generously rather than risk a false "not registered"
  # warning on a run that would have succeeded a few seconds later.
  for _ in $(seq 1 30); do
    if pluginkit -m -v 2>/dev/null | grep -q "org.yasw.adtrackerblocker.Extension"; then
      registered=true
      break
    fi
    sleep 1
  done
  if [ "$registered" = true ]; then
    echo "build_and_install: extension registration confirmed"
  else
    # Registration timing has been observed to occasionally exceed even
    # 30s -- this is NOT necessarily a real failure, just this check giving
    # up too early. Don't treat it as confirmed-broken; just say so.
    echo "build_and_install: registration not confirmed within 30s (this doesn't necessarily mean it failed -- timing has been inconsistent). Run: pluginkit -m -v | grep yasw"
  fi
fi
