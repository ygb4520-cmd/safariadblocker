// YouTube ad mitigation -- deliberately NOT network blocking (see README
// for why: YouTube serves ads from the same domains as real video content,
// making domain-based blocking both fragile and likely to break playback).
//
// IMPORTANT, learned the hard way while building this: clicking the "Skip
// Ad" button via skipBtn.click() does NOT work. Verified live against a
// real ad -- 100 synthetic clicks over 24 seconds had zero effect; the ad
// played out its full natural duration regardless. This is a hard browser
// security boundary, not a bug to fix: click()/dispatchEvent() always
// produce isTrusted:false events, and YouTube's handler evidently ignores
// those. No content-script technique can fake a real user click -- this is
// true in every browser, not just the one tested in.
//
// What DOES reliably work, verified live: setting video.playbackRate and
// video.muted. Property assignments aren't Events, so isTrusted doesn't
// apply to them -- confirmed the mute/unmute cycle fires correctly the
// instant the player's "ad-showing" class appears/clears. So the actual
// strategy here is to speed through ads at high playbackRate (a 30s ad
// finishes in under 2s) while muted, restoring normal speed/volume the
// moment real content resumes. The skip-button click is still attempted
// too, in case a future YouTube change ever makes it effective -- it's
// harmless either way -- but it is not what this feature depends on.
//
// Known risk (discussed before this was built): YouTube's player markup
// changes periodically, and the ad-state detection below can silently stop
// working when it does -- no error, it just quietly stops helping. Verified
// against YouTube's live markup as of writing: #movie_player gets classes
// "ad-showing"/"ad-interrupting" while an ad plays.

(function () {
  const api = window.browser || window.chrome;

  const SKIP_SELECTOR = ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern";
  const AD_SHOWING_CLASSES = ["ad-showing", "ad-interrupting"];
  const AD_PLAYBACK_RATE = 16;
  const MAX_ALTERED_MS = 90000; // safety net: never leave real content sped-up/muted because a stale class never cleared

  let enabled = false;
  let altered = false; // true while we've changed rate/mute for an ad
  let alteredAt = 0;
  let previousMuted = false;
  let previousRate = 1;

  const STATE_KEYS = ["youtubeAdSkip", "pausedDomains"];

  function computeEnabled(state) {
    const paused = (state.pausedDomains || []).includes(location.hostname);
    return state.youtubeAdSkip !== false && !paused;
  }

  function restore() {
    const video = document.querySelector("#movie_player video");
    if (video) {
      video.muted = previousMuted;
      video.playbackRate = previousRate;
    }
    altered = false;
  }

  function applyState(state) {
    enabled = computeEnabled(state);
    if (!enabled && altered) restore();
  }

  api.storage.local.get(STATE_KEYS).then(applyState);
  api.storage.onChanged.addListener((_changes, area) => {
    if (area !== "local") return;
    api.storage.local.get(STATE_KEYS).then(applyState);
  });

  function tick() {
    if (!enabled) return;

    const player = document.getElementById("movie_player");
    if (!player) return;

    // Best-effort, not load-bearing -- see file header. Kept because it's
    // free and harmless even though it isn't what actually gets you
    // through the ad.
    const skipBtn = player.querySelector(SKIP_SELECTOR);
    if (skipBtn && skipBtn.offsetParent !== null && !skipBtn.disabled) {
      skipBtn.click();
    }

    const video = player.querySelector("video");
    if (!video) return;

    const adShowing = AD_SHOWING_CLASSES.some((c) => player.classList.contains(c));

    if (adShowing) {
      if (!altered) {
        previousMuted = video.muted;
        previousRate = video.playbackRate;
        video.muted = true;
        video.playbackRate = AD_PLAYBACK_RATE;
        altered = true;
        alteredAt = Date.now();
      } else if (Date.now() - alteredAt > MAX_ALTERED_MS) {
        restore(); // stale "ad-showing" class safety net
      }
    } else if (altered) {
      restore();
    }
  }

  // Plain polling rather than MutationObserver: #movie_player persists
  // across YouTube's in-app SPA navigation between videos, so re-querying
  // it fresh each tick (instead of caching a reference) naturally survives
  // navigation too, and a cheap 250ms class-check poll is simpler and more
  // robust than reasoning about which mutations to watch for.
  setInterval(tick, 250);
})();
