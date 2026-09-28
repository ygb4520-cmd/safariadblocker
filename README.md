# Ad & Tracker Blocker (Safari Web Extension)

A personal-use Safari Web Extension for macOS that blocks ads, trackers, and
malware/phishing sites via `declarativeNetRequest`, with eight independently
toggleable categories (Ads, Trackers, Malware/Phishing, Annoyances,
Anti-Adblock, Custom rules, Pop-ups/Redirects, Referrer Privacy), real
cosmetic filtering (not just network blocking) plus a point-and-click element
picker for hiding anything else yourself, YouTube ad mitigation, a per-site
"pause" whitelist, settings export/import, a live blocked-request counter,
and a popup UI for managing it all. Built for local use through Xcode with a
free Apple ID — no paid Developer Program, no App Store.

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
│   ├── stats.html / stats.js      # the small "How we're doing" window opened from the popup
│   ├── icons/                    # toolbar icons
│   └── rules/
│       ├── ads.json               # EasyList + Peter Lowe's list
│       ├── trackers.json          # EasyPrivacy
│       ├── malware.json           # URLhaus + phishing-filter
│       ├── annoyances.json        # uBlock Origin's cookie-notice + other-annoyances lists
│       ├── antiadblock.json       # EasyList's Adblock Warning Removal List
│       ├── cosmetic.json          # ##/#@# element-hiding rules from all of the above
│       └── meta.json              # per-file "last updated" timestamps, for the popup's health line
├── Ad Tracker Blocker/            # the Xcode project (open this in Xcode)
│   ├── Ad Tracker Blocker.xcodeproj
│   ├── Ad Tracker Blocker/                  # SwiftUI container app
│   └── Ad Tracker Blocker Extension/        # Safari Web Extension target
│       └── Resources/             # COPY of ExtensionSource — see note below
├── WindowsExtension/               # COPY of ExtensionSource for Chrome/Edge, no build step
└── scripts/
    ├── convert_filterlists.py       # regenerates rules/*.json from all upstream sources
    ├── test_convert_filterlists.py  # automated tests for the parser functions above
    └── generate_icons.py            # regenerates the toolbar icon PNGs
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

#### Where the built app lives

Every build (Cmd+B or Cmd+R) also copies the finished, signed app into
`~/Applications` automatically — this is a Build post-action baked into the
Xcode scheme (see `Ad Tracker Blocker.xcodeproj/xcshareddata/xcschemes/`),
not something you need to set up. `~/Applications` is a stable folder Xcode
never touches; the raw output of a build normally lives under
`~/Library/Developer/Xcode/DerivedData/...`, which is scratch space Xcode
can delete or relocate at any time, and Safari can lose track of the
extension ("shows as not loaded") if it's still pointed there. Point Safari
at the `~/Applications` copy (step 3 below) and it'll always be the current
build, no manual copying needed.

If you ever end up with the extension showing twice in **Safari > Settings
> Extensions** with no way to tell which is which, it means an old copy of
the app is still sitting around somewhere (most often in DerivedData from
before this scheme existed) alongside the `~/Applications` one — Safari
lists a row per physical copy it's found, not per extension. Delete the
extra copy and relaunch Safari to clear the duplicate row.

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

- Click the toolbar icon to open the popup. You should see nine toggles
  (**Ads**, **Trackers**, **Malware/Phishing**, **Annoyances**,
  **Anti-Adblock**, **Custom rules**, **Pop-ups/Redirects**, **YouTube Ad
  Skip**, **Referrer Privacy**), a **Pause on this site** toggle, a text box
  for custom patterns with a pattern counter underneath, and **Export
  settings** / **Import settings** buttons at the bottom.
- Visit any page and confirm a number appears on the toolbar icon's badge —
  that's the browser's own live count of blocked requests on that page.
  Turn on **Pause on this site**: the badge number should stop updating
  (nothing's being blocked there anymore) and the icon itself should switch
  to a grayed-out version; switch to a different, non-paused tab and
  confirm the icon goes back to normal.
- Click **Export settings**, confirm a `.json` file downloads, then click
  **Import settings** and pick that same file back — the popup should
  refresh with everything unchanged (a no-op round trip is the easiest way
  to confirm import/export both work without risking your real settings).
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
- Click **Pick element to hide**, hover over something on the page (you
  should see a red outline follow your cursor), click it (it should
  disappear immediately and a "Hide this element on this site?" bar should
  appear at the bottom), then click **Hide it**. Reload the page and
  confirm it's still hidden; find it listed under **Custom hidden
  elements** in the popup and click **Remove** to confirm it comes back.
- Turn on **Pause on this site** on a site you use daily and confirm nothing
  breaks that the blocker was previously interfering with (see the icon
  and badge check above for what "paused" looks like). Turn pause back off
  when done.

If nothing seems blocked at all, double check "Allow Unsigned Extensions" is
still on (Safari resets it on relaunch) and that the extension toggle in
Safari's Extensions settings is on.

## How it works / Architecture

### How the categories work

- **Ads** / **Trackers** / **Malware/Phishing** / **Annoyances** /
  **Anti-Adblock**: static `declarativeNetRequest` rulesets bundled at build
  time (`rules/ads.json` / `rules/trackers.json` / `rules/malware.json` /
  `rules/annoyances.json` / `rules/antiadblock.json`), toggled on/off via
  `chrome.declarativeNetRequest.updateEnabledRulesets`. Malware/Phishing is
  its own category (not folded into Ads) since it's a different kind of
  decision — sourced from [URLhaus](https://urlhaus.abuse.ch/) and
  [phishing-filter](https://gitlab.com/malware-filter/phishing-filter) via
  the [malware-filter](https://gitlab.com/malware-filter) project, both
  refreshed twice daily upstream. Annoyances (cookie-consent banners,
  newsletter/social overlays, etc.) is sourced from
  [uBlock Origin's own annoyances lists](https://github.com/uBlockOrigin/uAssets/tree/master/filters) —
  see **Adopting uBlock's lists without uBlock's scriptlet engine** below for
  why only some of uBlock's own list content could be used safely.
  Anti-Adblock is sourced from EasyList's own
  [Adblock Warning Removal List](https://github.com/easylist/antiadblockfilters) —
  it hides the *dismissible* "please disable your ad blocker" nags some
  sites show, not full lockouts that refuse to show content until you
  comply (a documented limitation of the upstream list itself, not
  something this extension adds on top).
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
- **Referrer Privacy**: one more fixed dynamic rule — strips the `Referer`
  header on third-party requests only (not first-party ones, to avoid
  breaking same-origin referer checks some sites legitimately rely on).
  Doesn't come from a downloaded filter list, so it's a plain
  `declarativeNetRequest` `modifyHeaders` rule rather than its own static
  ruleset.

**Custom-rule limit visibility**: the popup shows a live "N / 4999 patterns"
counter next to the custom-pattern list, and warns if you're over the limit
(patterns beyond it are silently dropped when synced to dynamic rules — see
`syncCustomDynamicRules` — previously with no warning anywhere).

**Settings export/import**: the popup's **Export settings** button downloads
your full current state (toggles, custom patterns, paused sites) as a
`.json` file; **Import settings** reads one back in. Import treats the file
as untrusted input — every field is individually type-checked in
`background.js`'s `IMPORT_STATE` handler before being applied, and anything
malformed or unrecognized is silently dropped rather than rejecting the
whole import over one bad field.

### Health visibility

A few things so you can tell the extension is actually working without
digging through logs:

- **Paused-state icon**: the toolbar icon itself switches to a grayed-out
  variant whenever the *current tab's* site is paused, so "did I leave this
  paused?" is answerable at a glance instead of having to open the popup.
  Updates automatically as you switch tabs or navigate. This is an icon
  swap rather than badge text deliberately — the badge text slot is owned
  by the blocked-request counter below, and the two would fight over it if
  both tried to use badge text.
- **Blocked-request counter**: the browser's own built-in per-tab count of
  matched block rules is shown as the badge number on the toolbar icon —
  turned on once via `declarativeNetRequest.setExtensionActionOptions`, no
  extension-side bookkeeping needed; the browser keeps it live as you
  browse.
- **"Rules updated" line in the popup**: shows how long ago the block lists
  were last successfully refreshed (e.g. "Rules updated 3 hrs ago"), read
  from `rules/meta.json` (written by `convert_filterlists.py`, see below).
  It shows the *oldest* of the tracked rule files' timestamps, not the
  newest — so if one category's refresh has been silently failing (see the
  self-healing check below) while the others keep updating fine, this line
  still reflects that and turns orange once it's more than 2 days stale.

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

### "See how we're doing" stats window

The popup's **See how we're doing** link closes the popup and opens a
separate small window (`stats.html`, via `windows.create` with
`type: "popup"`) showing: the blocked-request count for the page you were
on, each category's on/off state with its rule count and how long ago it
was refreshed (from `rules/meta.json` — the popup's single "oldest file"
line, broken out per file), and counts of your own custom patterns, hidden
elements, and paused sites.

Two details worth knowing: the new window's own "active tab" is itself, so
`background.js` passes the originating tab id and hostname through the URL
when it opens the window. And the blocked count is read back from the
toolbar badge text (the browser's own automatic per-tab count) rather than
`getMatchedRules`, which would need an extra permission and is restricted
to unpacked extensions in Chrome — if a browser doesn't report a count, it
shows a dash rather than a made-up zero.

**Why several popup buttons go through `background.js`:** the popup's JS
context can be torn down by `window.close()` before an in-flight message
actually reaches the browser's messaging layer, silently dropping it. Both
this and the element picker's button send a message to `background.js`
(long-lived, unaffected by the popup closing), wait for its response, and
only then close.

### Element picker (hide anything yourself, no CSS needed)

For whatever the two layers above don't catch, the popup's **Pick element to
hide** button lets you point-and-click your own hide rule directly on a
page, same idea as uBlock Origin's picker/zapper tool:

1. Click the button in the popup — it sends the page's content script a
   `START_ELEMENT_PICKER` message and closes itself (the popup can't reach
   into the page's DOM directly, and would just be in the way sitting on
   top of it).
2. Move your mouse over the page — content.js highlights whatever's under
   the cursor with a red outline (`document.elementFromPoint`, checked
   fresh on every `mousemove`).
3. Click the thing you want gone — it's hidden immediately (live preview)
   and a small confirm bar appears at the bottom of the page.
4. **Hide it** saves `{hostname, selector}` to `customCosmeticRules` in
   storage (sent to `background.js` as `ADD_CUSTOM_COSMETIC_RULE`) and the
   picker exits. **Cancel** (or Escape) restores the element and exits
   without saving anything.

Rules are per-site (matched against the current hostname and its parent
domains, same `hostnameSuffixes` logic as the real filter data), listed
under **Custom hidden elements** in the popup with a **Remove** button each,
and included in settings export/import like everything else. Top frame
only — an element inside a nested iframe can't be picked directly, same
limitation as the real cosmetic-filter loading above.

**How the selector gets picked**, in priority order: a real `id` on the
clicked element, then real class names, then a short structural
(`tag:nth-of-type`) fallback path. "Real" here specifically excludes
CSS-in-JS/build-tool-generated names (`css-1a2b3c`, `sc-bZQynM`, and
similar patterns) via a heuristic in `looksAutoGenerated()` — those change
across reloads/deploys, so a selector built from one would likely stop
matching by your next visit. The heuristic is necessarily imperfect (there's
no way to know for certain from the string alone), but it catches the
common patterns; if a picked rule ever stops matching, just pick it again.

### Adopting uBlock's lists without uBlock's scriptlet engine

This extension still only does plain CSS selector hiding — it does not run
uBlock/AdGuard-style "procedural" cosmetic filters (`##+js(...)` scriptlet
injection, `:has-text()`, `:upward()`, `:xpath()`, and similar) or evaluate
arbitrary JavaScript on the page. Building that is a real engine, not a
parser tweak, and was explicitly decided against — see **Known limitations**
in project history for why.

Adding uBlock Origin's own annoyances lists as a source (above) surfaced a
real, concrete version of that gap: uBlock's lists mix plain `##selector`
lines freely with scriptlet/procedural lines, sometimes for the *same site*.
Ingesting them as-is would have silently pushed invalid "selectors" (a
scriptlet directive, or a selector containing a pseudo-class no CSS engine
understands) into `cosmetic.json` — which, per the chunking described above,
would have silently broken the *other* ~199 legitimate selectors sharing
that scriptlet or procedural entry's chunk. `parse_cosmetic_line` now
rejects any selector containing a scriptlet directive (`+js(`) or a known
non-standard procedural pseudo-class (`:has-text(`, `:matches-css(`,
`:upward(`, `:xpath(`, `-abp-contains(`, and others), regardless of which
separator token (`##`, `#@#`) it arrives under — not just the already-
excluded `#?#`/`#$#` lines. This means uBlock's own list *sources* can be
folded in safely for their plain-CSS-compatible majority, without silently
degrading existing coverage — while still not adding any actual support for
the procedural/scriptlet minority those same lists contain.

(Also fixed while investigating this: ABP's `*##selector` / `~a.com,*##selector`
"applies everywhere" wildcard-domain syntax — used by ~19 lines in the
existing sources and pervasively in uBlock's cookie-notices list — was
previously being treated as a literal, never-matching domain named `"*"`
rather than normalized to "no domain restriction.")

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

The bundled `rules/{ads,trackers,malware,annoyances,antiadblock,cosmetic}.json`
were generated once from live upstream sources — they are **not**
auto-updated by default. To pull the latest versions and regenerate all of
them:

```bash
python3 scripts/convert_filterlists.py
```

Sources, all fetched fresh each run:
[EasyList](https://easylist.to/easylist/easylist.txt) +
[Peter Lowe's list](https://pgl.yoyo.org/adservers/) → `ads.json`;
[EasyPrivacy](https://easylist.to/easylist/easyprivacy.txt) → `trackers.json`;
[URLhaus](https://urlhaus.abuse.ch/) +
[phishing-filter](https://gitlab.com/malware-filter/phishing-filter) →
`malware.json`;
[uBlock Origin's cookie-notices + other-annoyances lists](https://github.com/uBlockOrigin/uAssets/tree/master/filters) →
`annoyances.json`;
[EasyList's Adblock Warning Removal List](https://github.com/easylist/antiadblockfilters) →
`antiadblock.json`; the `##`/`#@#` element-hiding lines from all of the above
→ `cosmetic.json`. Writes to `ExtensionSource/rules/`, the Xcode project's
copied `Resources/rules/`, and `WindowsExtension/rules/` — so a plain
rebuild in Xcode (Cmd+B) or just reloading the unpacked Chrome/Edge folder
picks up the change.

Self-healing: each output file is sanity-checked before being written. If a
freshly parsed file comes in under a fixed minimum size (e.g. `trackers.json`
needs at least 2,000 rules; `annoyances.json`'s floor is much lower, 50,
since uBlock's annoyances lists are overwhelmingly cosmetic entries and only
yield ~200 real network rules; `antiadblock.json`'s is 200, comfortably
below its real ~2,500), or drops more than 50% from whatever's currently
shipped, the script assumes the upstream fetch failed (a dead server
returning an HTML error page instead of the real list, a truncated download,
a changed URL) and **refuses to overwrite that one file** — the previous
good version stays in place — while still updating whichever other files
did parse normally. If anything gets refused this way, the script exits
with a non-zero status so the daily automated run (below) shows up as
failed in its log instead of silently shipping near-empty rules.

Useful flags:

- `--max-rules N` — cap rules for `ads.json`/`trackers.json` each (default
  `20000`). Important: `declarativeNetRequest`'s `GUARANTEED_MINIMUM_STATIC_RULES`
  (30,000) is a **combined** total across every enabled static ruleset, not
  per-ruleset — with 5 rulesets (ads/trackers/malware/annoyances/antiadblock)
  enabled by default, the real combined total (roughly 20000+20000+10000+
  ~200+~2,500 ≈ 52,700 at the time of writing) already sits well past the
  strictly-guaranteed 30,000 and into the browser's shared "extra" pool —
  this has been true since malware was added and has been tested working in
  practice each time a category was added since; raise `--max-rules` itself
  with that in mind, and check current limits in Apple's WebExtensions
  documentation first.
- `--max-malware-rules N` — cap for `malware.json` (default `10000`,
  deliberately smaller — URLhaus/phishing-filter are current-threats-only
  lists refreshed twice daily upstream, not broad EasyList-scale coverage).
- `--max-annoyances-rules N` — cap for `annoyances.json` (default `10000`,
  same reasoning as `--max-malware-rules`; in practice only ~200 of uBlock's
  annoyances-list entries are network rules, the rest are cosmetic).
- `--max-antiadblock-rules N` — cap for `antiadblock.json` (default `10000`;
  the Adblock Warning Removal List is a few thousand lines total, well under
  this cap in practice).
- `--max-cosmetic-rules N` — cap combined generic + domain-scoped cosmetic
  selectors (default `40000`). Not subject to DNR limits (it's just CSS
  selectors in a JSON file), kept bounded for bundle size and per-page
  injection cost.
- `--offline` — reuse the previously downloaded raw lists in `scripts/raw/`
  instead of re-downloading (useful for iterating on the converter itself).

### Running the tests

`convert_filterlists.py`'s parsing functions are pure (text in, structured
data out — no network or browser needed), so they have an actual automated
test suite instead of relying on catching bugs by eye:

```bash
python3 scripts/test_convert_filterlists.py
```

Includes a regression test for a real bug caught and fixed earlier in this
project's history (a `#@#` exception silently failing to counter a *generic*
selector, the common real-world case) and for the wildcard-domain and
procedural-selector fixes made while adding uBlock's annoyances lists.

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

The toolbar icons are simple placeholder PNGs (blue "no entry" glyph, plus a
grayed-out `icon-<size>-paused.png` variant used for the paused-state icon
swap described above) generated with pure Python (no ImageMagick/PIL
dependency):

```bash
python3 scripts/generate_icons.py
```

Feel free to replace `ExtensionSource/icons/icon-*.png` (and the copies
under `Ad Tracker Blocker Extension/Resources/icons/` and
`WindowsExtension/icons/`) with your own artwork at 16/32/48/128px — if you
do, make sure to also provide `-paused` variants at each size, or the
paused-state icon swap will silently fail to find them.

## Credits

This extension's own code is original, but the blocking data it ships with
is not — the network and cosmetic (element-hiding) rules in `rules/` are
derived from third-party filter lists maintained by their own communities,
free to use under their respective licenses:

- [EasyList](https://easylist.to/) — general ad blocking
- [EasyPrivacy](https://easylist.to/) — tracker blocking
- [Peter Lowe's Ad and tracking server list](https://pgl.yoyo.org/adservers/)
- [URLhaus](https://urlhaus.abuse.ch/) (abuse.ch) — malware URLs
- [phishing-filter](https://gitlab.com/malware-filter/phishing-filter) — phishing URLs

See each project's own site for its current license terms before
redistributing the generated `rules/*.json` files outside this project.

## Support / Feedback

Found a bug or have a question? Open an issue: https://github.com/ygb4520-cmd/safariadblocker/issues
