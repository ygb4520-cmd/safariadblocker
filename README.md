# Ad & Tracker Blocker (Safari Web Extension)

A personal-use Safari Web Extension for macOS that blocks ads, trackers, and
malware/phishing sites via `declarativeNetRequest`, with five independently
toggleable categories (Ads, Trackers, Malware/Phishing, Custom rules,
Pop-ups/Redirects), real cosmetic filtering (not just network blocking),
YouTube ad mitigation, a per-site "pause" whitelist, and a popup UI for
managing it all. Built for local use through Xcode with a free Apple ID —
no paid Developer Program, no App Store.

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

- No iCloud sync of toggle/whitelist/custom-pattern state — it's local to
  this Mac via `chrome.storage.local`.
- No automatic filter-list updates by default — refreshing is a manual
  re-run of `convert_filterlists.py` followed by a rebuild, unless you opt
  into the daily `launchd` job described below.
- YouTube ad handling is speed-up + mute, not a true skip — see the
  **YouTube ad mitigation** section for why, and the real limitation that
  comes with it (YouTube's player markup can change and silently break it).

## Project layout

```
safariadblocker/
├── ExtensionSource/              # canonical extension source (edit these)
│   ├── manifest.json
│   ├── background.js             # service worker: all declarativeNetRequest logic
│   ├── content.js                 # cosmetic filtering, pop-up/redirect protection
│   ├── youtube-skip.js            # YouTube-only: ad speed-up/mute (see README section)
│   ├── popup.html / popup.css / popup.js
│   ├── icons/                    # toolbar icons
│   └── rules/
│       ├── ads.json               # EasyList + Peter Lowe's list
│       ├── trackers.json          # EasyPrivacy
│       ├── malware.json           # URLhaus + phishing-filter
│       └── cosmetic.json          # ##/#@# element-hiding rules from all of the above
├── Ad Tracker Blocker/            # the Xcode project (open this in Xcode)
│   ├── Ad Tracker Blocker.xcodeproj
│   ├── Ad Tracker Blocker/                  # SwiftUI container app
│   └── Ad Tracker Blocker Extension/        # Safari Web Extension target
│       └── Resources/             # COPY of ExtensionSource — see note below
├── WindowsExtension/               # COPY of ExtensionSource for Chrome/Edge, no build step
└── scripts/
    ├── convert_filterlists.py    # regenerates rules/*.json from all upstream sources
    └── generate_icons.py         # regenerates the toolbar icon PNGs
```

**Important:** the Xcode project was generated with Apple's
`safari-web-extension-converter --copy-resources`, which *copies*
`ExtensionSource/` into `Ad Tracker Blocker Extension/Resources/` rather than
referencing it in place, and `WindowsExtension/` is a separate copy too. If
you edit `ExtensionSource/` by hand later, copy your changes into both (or
just re-run `convert_filterlists.py` for the `rules/*.json` files, which
writes to all three locations automatically — see below; hand-edited `.js`
files still need a manual copy).

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

- Click the toolbar icon to open the popup. You should see six toggles
  (**Ads**, **Trackers**, **Malware/Phishing**, **Custom rules**,
  **Pop-ups/Redirects**, **YouTube Ad Skip**), a **Pause on this site**
  toggle, and a text box for custom patterns.
- Visit a page known to be full of ads/trackers (e.g. a news site) with all
  toggles on, then open Safari's **Develop > Show Web Inspector >
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

- **Ads** / **Trackers** / **Malware/Phishing**: static `declarativeNetRequest`
  rulesets bundled at build time (`rules/ads.json` / `rules/trackers.json` /
  `rules/malware.json`), toggled on/off via
  `chrome.declarativeNetRequest.updateEnabledRulesets`. Malware/Phishing is
  its own category (not folded into Ads) since it's a different kind of
  decision — sourced from [URLhaus](https://urlhaus.abuse.ch/) and
  [phishing-filter](https://gitlab.com/malware-filter/phishing-filter) via
  the [malware-filter](https://gitlab.com/malware-filter) project, both
  refreshed twice daily upstream.
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
often still reserves space for it, which shows up as a blank/white box.
There are two layers here now:

1. **Real cosmetic filtering** (`rules/cosmetic.json`): EasyList/EasyPrivacy
   contain `##selector` element-hiding lines alongside their network-block
   lines — the exact same per-site selectors uBlock Origin itself uses,
   authored and maintained by the filter-list authors, not guessed. The
   converter script parses these (including domain-scoped rules like
   `youtube.com##.masthead-ad` and `#@#` exceptions) into a JSON map of
   `{generic: [...], domains: {domain: [...]}, exceptions: {domain: [...]}}`.
   `content.js` fetches it once per page load, resolves it against the
   current hostname (checking the hostname and each of its parent domains,
   so a rule for `example.com` also applies on `sub.example.com`), and
   injects the matching selectors as chunked CSS (~200 selectors per rule,
   so one unsupported/invalid selector can only drop its own chunk, not the
   whole ruleset) scoped behind an `atb-hide-ads` class on `<html>`. Applied
   in the top frame only — ad-hiding rules target the main page, not each
   nested ad iframe, and this avoids redundant fetch/parse work on
   frame-heavy pages.
2. **Heuristic fallback** (`cosmetic.css` + `content.js`), for gaps the real
   filter data doesn't cover: `cosmetic.css` hides common generic ad-container
   patterns (`[id^="div-gpt-ad"]`, `ins.adsbygoogle`, known ad iframe hosts,
   etc.); `content.js` also collapses any `<img>`/`<iframe>`/`<embed>`/`<video>`
   that actually fails to load (plus its parent, if that parent exists solely
   to wrap it) and runs a periodic sweep that collapses empty containers sized
   like a standard IAB ad unit, and hides elements whose only content is an
   "ADVERTISEMENT"/"Sponsored" disclosure label (climbing to the enclosing
   slot, with guards so it can't swallow real article content).

Both layers are gated behind the same Ads/Trackers/pause state via the
`atb-hide-ads` class — if a page ever looks broken, turning off Ads/Trackers
or using Pause on this site removes it immediately. Neither layer is
perfect (the real filter data still won't cover every site, and the
heuristic layer is a heuristic), but between the two, coverage should be
close to what a mainstream ad blocker achieves for cosmetic hiding.

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

### YouTube ad mitigation

`youtube-skip.js` runs only on `youtube.com`/`m.youtube.com` and does
**not** attempt network blocking — YouTube serves ads from the same domains
as real video content, so a domain-based block would be both fragile and
likely to break playback. Full ad-stream blocking and the anti-adblock
detection arms race were explicitly considered and ruled out as out of
scope for this project (too fragile, too high-maintenance for a
personal-use tool with no auto-updating filter lists by default).

What it actually does, and why, is worth spelling out precisely because the
obvious approach doesn't work:

- **Clicking the "Skip Ad" button does not work.** This was tried first and
  verified live against a real ad: 100 synthetic `skipBtn.click()` calls
  over 24 seconds had zero effect, and the ad played out its full natural
  duration regardless. This isn't a selector problem — `.click()` /
  `dispatchEvent()` always produce `isTrusted: false` events, and YouTube's
  handler evidently ignores those. No content-script technique can fake a
  real user click; this is a hard browser security boundary, true in every
  browser. The skip-button click is still attempted each tick (harmless,
  free, in case a future YouTube change ever makes it effective) but it is
  not what the feature depends on.
- **What does reliably work, also verified live against a real ad**: setting
  `video.playbackRate` and `video.muted`. Property assignments aren't
  `Event`s, so `isTrusted` doesn't apply to them. The actual mechanism is:
  detect an ad via the `ad-showing`/`ad-interrupting` classes
  `#movie_player` gets while one plays, then set `playbackRate` to 16 and
  mute — a 30-second ad finishes in under 2 seconds, silently. Normal speed
  and volume are restored the instant the ad-showing class clears, with a
  90-second safety-net timeout in case that class ever gets stuck (so a
  markup change can't leave real content muted/sped-up indefinitely).
- **Real, known risk**: YouTube's player markup changes periodically (A/B
  tests, redesigns), and the class-based ad detection above can silently
  stop working when it does — no error, it just quietly stops helping.
  Selectors were verified against YouTube's live markup as of writing.
- Independently toggleable ("YouTube Ad Skip" in the popup) and respects
  Pause on this site, same as everything else.

### Refreshing the seed rule lists

The bundled `rules/{ads,trackers,malware,cosmetic}.json` were generated once
from live upstream sources — they are **not** auto-updated by default. To
pull the latest versions and regenerate all four:

```bash
python3 scripts/convert_filterlists.py
```

Sources, all fetched fresh each run:
[EasyList](https://easylist.to/easylist/easylist.txt) +
[Peter Lowe's list](https://pgl.yoyo.org/adservers/) → `ads.json`;
[EasyPrivacy](https://easylist.to/easylist/easyprivacy.txt) → `trackers.json`;
[URLhaus](https://urlhaus.abuse.ch/) +
[phishing-filter](https://gitlab.com/malware-filter/phishing-filter) →
`malware.json`; the `##`/`#@#` element-hiding lines from all of the above →
`cosmetic.json`. Writes to `ExtensionSource/rules/`, the Xcode project's
copied `Resources/rules/`, and `WindowsExtension/rules/` — so a plain
rebuild in Xcode (Cmd+B) or just reloading the unpacked Chrome/Edge folder
picks up the change.

Useful flags:

- `--max-rules N` — cap rules for `ads.json`/`trackers.json` each (default
  `20000`). Important: `declarativeNetRequest`'s `GUARANTEED_MINIMUM_STATIC_RULES`
  (30,000) is a **combined** total across every enabled static ruleset, not
  per-ruleset — with 3 rulesets (ads/trackers/malware) enabled by default,
  raising this significantly pushes the combined total past what's
  strictly guaranteed and into the browser's shared "extra" pool. The
  current defaults (20000 + 20000 + 10000 malware) have been tested working
  in practice; raise with the combined total in mind, and check current
  limits in Apple's WebExtensions documentation first.
- `--max-malware-rules N` — cap for `malware.json` (default `10000`,
  deliberately smaller — URLhaus/phishing-filter are current-threats-only
  lists refreshed twice daily upstream, not broad EasyList-scale coverage).
- `--max-cosmetic-rules N` — cap combined generic + domain-scoped cosmetic
  selectors (default `40000`). Not subject to DNR limits (it's just CSS
  selectors in a JSON file), kept bounded for bundle size and per-page
  injection cost.
- `--offline` — reuse the previously downloaded raw lists in `scripts/raw/`
  instead of re-downloading (useful for iterating on the converter itself).

What the converter does and doesn't translate (network rules):

- Skips regex filters and any filter option it can't safely translate (e.g.
  `$csp`, `$redirect`, `$removeparam`).
- Supports domain/tracker block rules, `@@` exceptions, `$domain=`,
  `$third-party`, and resource-type options (`$script`, `$image`, etc.).

Cosmetic rules (`##`/`#@#`) are parsed separately (see **Cosmetic cleanup**
above) — `#?#`/`#$#` (extended-CSS/snippets) are skipped, since they use
syntax plain CSS can't express safely.

#### Automatic daily refresh (optional)

By default rules only update when you manually run the command above. If
you'd rather not think about it, `scripts/install_weekly_refresh.sh` (name
predates the switch from weekly to daily) installs a `launchd` user agent
(macOS's built-in scheduler) that runs every day at 9:00 AM: it re-downloads
all four sources above, regenerates all four rule files, and rebuilds the
app with `xcodebuild` — all unattended, using the same signing settings
already configured in Xcode.

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
its own; if a day goes by and things seem stale, a manual quit-and-reopen
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
