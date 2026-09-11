# Ad & Tracker Blocker (Safari Web Extension)

A personal-use Safari Web Extension for macOS that blocks ads and trackers via
`declarativeNetRequest`, with three independently toggleable categories
(Ads, Trackers, Custom rules), a per-site "pause" whitelist, and a popup UI
for managing it all. Built for local use through Xcode with a free Apple ID
— no paid Developer Program, no App Store.

## There's no download button for this one

Unlike the other apps, this repo doesn't publish a compiled installer —
both versions run from source:

- **Mac (Safari)**: build it yourself via Xcode — free, ~5 minutes, no paid
  account needed. See **Quick start** right below.
- **Windows (Edge/Chrome)**: no build step at all — see
  **[`WindowsExtension/README-WINDOWS.md`](WindowsExtension/README-WINDOWS.md)**
  for how to load it directly into your browser.

## Quick start

1. Open `Ad Tracker Blocker/Ad Tracker Blocker.xcodeproj` in Xcode, sign both
   targets with your free Apple ID ("Personal Team"), and build/run (**Cmd+R**).
2. In Safari, turn on **Settings > Advanced > Show features for web
   developers**, then **Develop > Allow Unsigned Extensions**.
3. Enable the extension in **Safari > Settings > Extensions**.
4. Click the toolbar icon and confirm ads/trackers are blocked on a test page.

Full details, troubleshooting, and how it all works internally are below.

## Known limitations (v1, by design)

- No cosmetic/element-hiding (ad slots leave blank space rather than being
  hidden via CSS injection) — network blocking only.
- No iCloud sync of toggle/whitelist/custom-pattern state — it's local to
  this Mac via `chrome.storage.local`.
- No automatic filter-list updates — refreshing is a manual re-run of
  `convert_filterlists.py` followed by a rebuild (or the optional weekly
  `launchd` job described below).

## Project layout

```
safariadblocker/
├── ExtensionSource/              # canonical extension source (edit these)
│   ├── manifest.json
│   ├── background.js             # service worker: all declarativeNetRequest logic
│   ├── popup.html / popup.css / popup.js
│   ├── icons/                    # toolbar icons
│   └── rules/
│       ├── ads.json              # generated from EasyList
│       └── trackers.json         # generated from EasyPrivacy
├── Ad Tracker Blocker/            # the Xcode project (open this in Xcode)
│   ├── Ad Tracker Blocker.xcodeproj
│   ├── Ad Tracker Blocker/                  # SwiftUI container app
│   └── Ad Tracker Blocker Extension/        # Safari Web Extension target
│       └── Resources/             # COPY of ExtensionSource — see note below
└── scripts/
    ├── convert_filterlists.py    # regenerates rules/*.json from EasyList/EasyPrivacy
    └── generate_icons.py         # regenerates the toolbar icon PNGs
```

**Important:** the Xcode project was generated with Apple's
`safari-web-extension-converter --copy-resources`, which *copies*
`ExtensionSource/` into `Ad Tracker Blocker Extension/Resources/` rather than
referencing it in place. If you edit `ExtensionSource/` by hand later, copy
your changes into `Ad Tracker Blocker Extension/Resources/` too (or just
re-run `convert_filterlists.py`, which writes to both locations
automatically — see below).

## Setup & Usage

### 1. Open the project in Xcode

```bash
open "Ad Tracker Blocker/Ad Tracker Blocker.xcodeproj"
```

#### Sign the app with your free Apple ID (no paid Developer Program needed)

1. In Xcode, go to **Xcode > Settings > Accounts**, click **+**, and add your
   Apple ID if it isn't there already. This creates a free "Personal Team".
2. Select the project in the navigator, then for **both** targets
   ("Ad Tracker Blocker" and "Ad Tracker Blocker Extension"):
   - Open the **Signing & Capabilities** tab.
   - Check **Automatically manage signing**.
   - Set **Team** to your personal team (your name, "(Personal Team)").
3. Build and run with **Cmd+R**. The first time, Xcode will prompt to
   register your device/team — accept it. The container app window opens;
   you can quit it once the extension is installed (the extension itself
   runs inside Safari, not inside this app).

A free personal team can only sign apps that run locally for development —
which is exactly what you want here.

### 2. Enable unsigned extensions in Safari

Personal-team (free) signed extensions aren't notarized, so Safari won't
load them unless you explicitly allow local/unsigned extensions:

1. Open **Safari > Settings > Advanced**, and turn on
   **"Show features for web developers"** (this reveals a Developer menu).
2. Open the new **Developer** menu in Safari's menu bar, and enable
   **"Allow Unsigned Extensions"**. (You'll need to redo this each time you
   relaunch Safari — it's a per-launch developer setting.)

### 3. Enable the extension in Safari

1. With the app built and run once from Xcode (step 1), open
   **Safari > Settings > Extensions**.
2. Check the box next to **"Ad & Tracker Blocker"** to enable it.
3. Safari will ask you to confirm — click **Turn On**.
4. Optionally pin its icon to the toolbar via the toolbar customization menu
   or the extensions puzzle-piece icon.

The container app's window (SwiftUI) has an **"Open Safari Extensions
Preferences…"** button that jumps straight to this screen if you'd rather
launch it from there.

### 4. Test that it's working

- Click the toolbar icon to open the popup. You should see three toggles
  (**Ads**, **Trackers**, **Custom rules**), a **Pause on this site** toggle,
  and a text box for custom patterns.
- Visit a page known to be full of ads/trackers (e.g. a news site) with all
  three toggles on, then open Safari's **Develop > Show Web Inspector >
  Network** tab and reload — you should see many fewer third-party requests
  (doubleclick.net, google-analytics.com, etc.) compared to toggling Ads and
  Trackers off and reloading again.
- Turn **Trackers** off, reload, and confirm analytics requests reappear in
  the Network tab (crude but effective way to confirm the toggle does
  something).
- Add a custom pattern (e.g. `example.com`) in the popup, reload a page on
  that domain, and confirm it's blocked; remove it and confirm it loads
  again.
- Turn on **Pause on this site** on a site you use daily and confirm nothing
  breaks that the blocker was previously interfering with, then turn it back
  off.

If nothing seems blocked at all, double check "Allow Unsigned Extensions" is
still on (Safari resets it on relaunch) and that the extension toggle in
Safari's Extensions settings is on.

## How it works / Architecture

### How the categories work

- **Ads** / **Trackers**: static `declarativeNetRequest` rulesets bundled at
  build time (`rules/ads.json` / `rules/trackers.json`), toggled on/off via
  `chrome.declarativeNetRequest.updateEnabledRulesets`.
- **Custom rules**: static rulesets are immutable once packaged into the
  extension — there's no API to append rules to a bundled `.json` file at
  runtime. So custom user patterns are implemented as **dynamic rules**
  (`chrome.declarativeNetRequest.updateDynamicRules`) instead, which the
  extension is free to add, remove, and toggle at any time. Functionally
  this behaves exactly like the third toggleable category the popup exposes
  — it's just implemented differently under the hood than the two static
  ones. See `background.js` for details.
- **Pause on this site**: adds a single high-priority dynamic `allow` rule
  scoped to the current tab's domain, which overrides every block rule
  (static or dynamic) regardless of which categories are enabled.

### Cosmetic cleanup (closing the blank space left by blocked ads)

Network blocking alone stops an ad's request, but the page's own layout
often still reserves space for it (an `<iframe>`/`<img>` that fails to load,
or an empty container a script never got around to filling in), which shows
up as a blank/white box. `content.js` + `cosmetic.css` close that gap
without a full EasyList-style cosmetic filter engine:

- `cosmetic.css` hides common ad-container patterns (`[id^="div-gpt-ad"]`,
  `ins.adsbygoogle`, `[class*="ad-slot"]`, known ad iframe hosts, etc.),
  scoped behind an `atb-hide-ads` class on `<html>`.
- `content.js` toggles that class based on the current Ads/Trackers/pause
  state, and also listens for any `<img>`/`<iframe>`/`<embed>`/`<video>`
  that actually fails to load (which is what a blocked network request
  looks like from the page's perspective) and collapses it — plus its
  parent, if that parent exists solely to wrap it — so a blocked ad closes
  up instead of leaving a blank slot.

This is a heuristic, not a real cosmetic filter list, so it won't catch
every ad container on every site, and on rare sites a legitimately-named
element (e.g. a non-ad `.ad-hoc-banner` class) could get hit by a
false-positive selector — if a page ever looks broken, turning off Ads/
Trackers or using Pause on this site removes the `atb-hide-ads` class
immediately.

### Pop-up and forced-redirect protection

`content.js` also blocks two classic "hijack the tab" ad techniques:

- **Pop-under `window.open()` calls**: ad scripts often call `window.open()`
  from a timer or a generic event rather than a real click, to spawn an
  unwanted tab/window behind the current one. The extension overrides
  `window.open` in the page's own JS context (injected as an inline
  `<script>`, since a content script's isolated world can't touch the
  page's real `window.open`) and blocks calls that aren't backed by genuine
  [user activation](https://developer.mozilla.org/en-US/docs/Web/API/UserActivation).
- **`<meta http-equiv="refresh">` forced redirects**: a low-tech but still
  common scam-page redirect vector; these tags get stripped before they can
  fire.

Not blocked, deliberately:

- **`location.href` / `location.replace()` reassignment** — used by too many
  legitimate flows (OAuth, checkout, SSO redirects) to safely intercept
  without breaking real sites, so this project only targets the two vectors
  above.
- A good chunk of forced-redirect protection also already comes "for free"
  from the Ads/Trackers rulesets, since many redirect scripts are served
  from domains already in `rules/ads.json`.

### Refreshing the seed rule lists

The bundled `rules/ads.json` and `rules/trackers.json` were generated once
from the live [EasyList](https://easylist.to/easylist/easylist.txt) and
[EasyPrivacy](https://easylist.to/easylist/easyprivacy.txt) filter lists —
they are **not** auto-updated. To pull the latest versions and regenerate:

```bash
python3 scripts/convert_filterlists.py
```

This downloads both lists fresh, converts Adblock Plus filter syntax into
`declarativeNetRequest` JSON rules, and writes the result to both
`ExtensionSource/rules/` and (if present) the Xcode project's copied
`Resources/rules/` folder, so a plain rebuild in Xcode (Cmd+B) picks up the
change. Then rebuild/run in Xcode.

Useful flags:

- `--max-rules N` — cap rules per category (default `20000`). Safari's
  `declarativeNetRequest` static-ruleset limits can change between OS
  versions; 20,000/category is comfortably under the commonly documented
  `GUARANTEED_MINIMUM_STATIC_RULES` floor (30,000), but if you raise this,
  check current limits in Apple's WebExtensions documentation first. Safari
  silently ignores rules beyond its cap rather than failing to load, so an
  overly high number degrades gracefully but wastes ruleset space.
- `--offline` — reuse the previously downloaded raw lists in `scripts/raw/`
  instead of re-downloading (useful for iterating on the converter itself).

What the converter does and doesn't translate:

- Skips cosmetic/element-hiding rules (`##...`), regex filters, and any
  filter option it can't safely translate (e.g. `$csp`, `$redirect`,
  `$removeparam`) — these are non-goals for v1's pure network-blocking
  approach.
- Supports domain/tracker block rules, `@@` exceptions, `$domain=`,
  `$third-party`, and resource-type options (`$script`, `$image`, etc.).

#### Automatic weekly refresh (optional)

By default rules only update when you manually run the command above. If
you'd rather not think about it, `scripts/install_weekly_refresh.sh` installs
a `launchd` user agent (macOS's built-in scheduler) that runs every Sunday at
9:00 AM: it re-downloads EasyList/EasyPrivacy, regenerates both rule files,
and rebuilds the app with `xcodebuild` — all unattended, using the same
signing settings already configured in Xcode.

```bash
scripts/install_weekly_refresh.sh    # installs it
scripts/run_refresh_now.sh           # triggers a run immediately, to test
scripts/uninstall_weekly_refresh.sh  # removes it
```

Logs land in `scripts/logs/` (one file per day it runs, pruned after 90
days) — check there if you want to confirm it's actually running or debug a
failure.

**What this does not do:** quit or relaunch Safari. Doing that unattended
would kill whatever tabs you have open, so the job only refreshes the rules
and rebuilds the app binary. Safari usually notices the updated extension on
its own; if a week goes by and things seem stale, a manual quit-and-reopen
of Safari (see the testing section above) forces it to pick up the rebuilt
version.

### Regenerating icons

The toolbar icons are simple placeholder PNGs (blue "no entry" glyph)
generated with pure Python (no ImageMagick/PIL dependency):

```bash
python3 scripts/generate_icons.py
```

Feel free to replace `ExtensionSource/icons/icon-*.png` (and the copies
under `Ad Tracker Blocker Extension/Resources/icons/`) with your own artwork
at 16/32/48/128px.

## Support / Feedback

Found a bug or have a question? Open an issue: https://github.com/ygb4520-cmd/safariadblocker/issues
