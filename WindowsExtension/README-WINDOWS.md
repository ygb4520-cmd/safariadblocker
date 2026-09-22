# Ad & Tracker Blocker — Windows (Edge / Chrome)

Same extension as the Mac/Safari version, unchanged — Chrome and Edge on
Windows both load Manifest V3 extensions like this directly, with **no
native container app, no code signing, and no Xcode-equivalent build step**.
You just point the browser at this folder.

## 1. Transfer this folder

Copy the whole `WindowsExtension` folder (or the zip it came in) to the
Windows machine — via Google Drive, a USB drive, whatever's convenient —
and unzip it somewhere permanent (e.g. `Documents\AdTrackerBlocker`). Don't
leave it in `Downloads` or a temp folder you might clear out later: the
browser loads the extension directly from wherever this folder lives, so if
you delete/move it, the extension breaks until you re-point the browser at
the new location.

## 2. Load it — Edge

1. Open Edge, go to `edge://extensions`.
2. Turn on **Developer mode** (toggle, bottom-left).
3. Click **Load unpacked**.
4. Select this `WindowsExtension` folder (the one containing `manifest.json`).
5. It should appear as "Ad & Tracker Blocker", already enabled.

## 3. Load it — Chrome

1. Open Chrome, go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked**.
4. Select this `WindowsExtension` folder.
5. Same result — it appears enabled immediately.

(You can load it into both browsers at once if you use both — each browser
keeps its own independent copy of the toggle states/custom rules/pause
list, same as how the Mac and Windows copies don't sync with each other.)

## 4. Pin the icon (optional but convenient)

Click the puzzle-piece icon in the toolbar → find "Ad & Tracker Blocker" →
click the pin icon so it's always visible.

## 5. Test it's working

Same idea as the Mac version:

- Open the popup (toolbar icon) — you should see **Ads**, **Trackers**,
  **Malware / Phishing**, **Custom rules**, **Pop-ups / Redirects**, and
  **YouTube Ad Skip** toggles, **Pause on this site**, and the
  custom-pattern box.
- Visit an ad-heavy site, open DevTools (**F12** or Ctrl+Shift+I) → **Network**
  tab, reload. With everything on, you should see far fewer third-party
  requests (`doubleclick.net`, `google-analytics.com`, etc.) than with
  **Pause on this site** turned on.

## Refreshing the rules later

`rules/{ads,trackers,malware,cosmetic}.json` here are the exact same files
generated on the Mac side — a snapshot, not auto-updating. If you want this
Windows copy to refresh independently later:

1. Install Python 3 from [python.org](https://www.python.org/downloads/) if
   it's not already on the machine.
2. Copy `scripts/convert_filterlists.py` from the main project over too (it
   wasn't included in this package since it's a dev tool, not part of the
   extension itself).
3. Run `python convert_filterlists.py` from a folder containing this
   `rules/` directory — it'll download fresh EasyList/EasyPrivacy/Peter
   Lowe's list/URLhaus/phishing-filter and regenerate all four files. See
   the main project's `README.md` for details; the script is plain Python
   with no OS-specific code, so it runs the same way on Windows.

## Differences from the Mac/Safari version

- No container app, no signing, no "Allow Unsigned Extensions" step — that
  whole category of setup is Safari-specific and doesn't apply here.
- Nothing syncs between the Mac and Windows copies — separate browsers,
  separate extension storage, independent toggle/rule state on each.
- Everything else (what gets blocked, the popup, real cosmetic filtering,
  the heuristic ad-slot cleanup, pop-up/redirect protection, YouTube ad
  mitigation) is identical — same source files.
