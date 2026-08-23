// Cosmetic cleanup: network blocking (declarativeNetRequest) stops an ad's
// request, but the page's own layout often still reserves space for it --
// an iframe/img that fails to load, or an empty container a script never
// got to fill in. This script closes that gap without a full cosmetic
// filter-list engine:
//   1. cosmetic.css (injected alongside this file) hides common ad-slot
//      containers by id/class pattern, gated behind the `atb-hide-ads`
//      class this script puts on <html>.
//   2. Any img/iframe/embed/video/object that actually fails to load gets
//      collapsed, along with a lone wrapper element around it, so a failed
//      load doesn't leave a blank box.
//   3. A periodic sweep collapses empty containers sized like a standard
//      IAB ad unit (300x250, 728x90, etc.) as a fallback for sites whose ad
//      slots don't carry any recognizable class/id name for cosmetic.css to
//      match.
//   4. Pop-up/pop-under and forced-redirect protection: blocks window.open()
//      calls that aren't the direct result of a real click/tap (the classic
//      ad-network pop-under technique) and strips <meta http-equiv=refresh>
//      forced-redirect tags. Deliberately does NOT touch location.href/
//      location.replace -- too many legitimate flows (OAuth, checkout, SSO)
//      rely on those to safely block generically.
//   5. A name-agnostic fallback: some ad slots only pick up an
//      ad-network-specific class once the (now-blocked) ad script
//      initializes, so they can get stuck showing a raw "ADVERTISEMENT"
//      disclosure label and loading placeholder forever. This finds that
//      label text directly and hides its enclosing slot, with guards so it
//      can't climb into and hide real article content.

(function () {
  const api = window.browser || window.chrome;

  function shouldHide(state) {
    const categories = state.rulesetsEnabled || {};
    const paused = (state.pausedDomains || []).includes(location.hostname);
    return (categories.ads || categories.trackers) && !paused;
  }

  // Independent of the Ads/Trackers toggles -- its own switch in the popup
  // -- but still respects per-site pause like everything else here.
  function shouldBlockPopups(state) {
    const paused = (state.pausedDomains || []).includes(location.hostname);
    return state.popupRedirectProtection !== false && !paused;
  }

  function applyState(state) {
    const hide = shouldHide(state);
    const blockPopups = shouldBlockPopups(state);
    document.documentElement.classList.toggle("atb-hide-ads", hide);
    document.documentElement.classList.toggle("atb-block-popups", blockPopups);
    hidingEnabled = hide;
    popupProtectionEnabled = blockPopups;
    if (popupProtectionEnabled) stripMetaRefresh();
  }

  let hidingEnabled = false;
  let popupProtectionEnabled = false;

  const STATE_KEYS = ["rulesetsEnabled", "pausedDomains", "popupRedirectProtection"];

  api.storage.local.get(STATE_KEYS).then(applyState);

  api.storage.onChanged.addListener((_changes, area) => {
    if (area !== "local") return;
    api.storage.local.get(STATE_KEYS).then(applyState);
  });

  // window.open must be overridden in the page's own JS context (not the
  // isolated content-script world) to have any effect on the page's own
  // calls, so inject it as an inline <script> rather than run it here.
  // Gated at call-time via the atb-block-popups class (shared DOM, so
  // readable from either JS world) rather than piping storage state across
  // worlds.
  const MAIN_WORLD_GUARD = `(function () {
    if (window.__atbOpenGuarded) return;
    window.__atbOpenGuarded = true;
    const nativeOpen = window.open;
    window.open = function (...args) {
      const enabled = document.documentElement.classList.contains("atb-block-popups");
      const activation = navigator.userActivation;
      if (enabled && activation && !activation.isActive) {
        return null;
      }
      return nativeOpen.apply(window, args);
    };
  })();`;

  function injectMainWorldGuard() {
    const script = document.createElement("script");
    script.textContent = MAIN_WORLD_GUARD;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  injectMainWorldGuard();

  function stripMetaRefresh() {
    if (!popupProtectionEnabled) return;
    document.querySelectorAll('meta[http-equiv="refresh" i]').forEach((meta) => meta.remove());
  }

  const COLLAPSIBLE = new Set(["IMG", "IFRAME", "EMBED", "OBJECT", "VIDEO"]);

  // Media load-error events don't bubble, so listen on the capture phase.
  document.addEventListener(
    "error",
    (event) => {
      if (!hidingEnabled) return;
      const el = event.target;
      if (!el || !COLLAPSIBLE.has(el.tagName)) return;

      el.style.setProperty("display", "none", "important");

      const parent = el.parentElement;
      if (parent && parent.childElementCount === 1) {
        parent.style.setProperty("display", "none", "important");
      }
    },
    true
  );

  // Standard IAB ad-unit dimensions (width x height), +/- a few px tolerance.
  const AD_SIZES = [
    [300, 250], [336, 280], [300, 600], [300, 1050], [320, 50], [320, 100],
    [728, 90], [970, 250], [970, 90], [160, 600], [120, 600], [180, 150],
    [250, 250], [200, 200], [468, 60], [234, 60],
  ];

  function matchesAdSize(w, h) {
    return AD_SIZES.some(([aw, ah]) => Math.abs(w - aw) <= 4 && Math.abs(h - ah) <= 4);
  }

  function isEmptyContainer(el) {
    if (el.querySelector("img[src], iframe[src], video, canvas, svg")) return false;
    return el.textContent.trim().length === 0;
  }

  // Matches a leaf element's *entire* text -- not a substring match against
  // whole paragraphs -- so this only fires on a dedicated disclosure label,
  // never on a sentence that happens to mention "sponsored" in passing.
  const AD_LABEL_PATTERN = /^(advertisement|advertisment|sponsored content|sponsored)\b/i;

  function findAdSlotAncestor(labelEl) {
    let target = labelEl;
    let cur = labelEl.parentElement;
    for (let i = 0; i < 5 && cur; i++) {
      // Stop climbing as soon as an ancestor looks like real article
      // content rather than a small, dedicated ad-slot wrapper.
      const tooManyChildren = cur.childElementCount > 5;
      const hasRealParagraph = [...cur.querySelectorAll("p")].some(
        (p) => p.textContent.trim().length > 40
      );
      if (tooManyChildren || hasRealParagraph) break;
      target = cur;
      cur = cur.parentElement;
    }
    return target;
  }

  function hideByAdLabel() {
    const nodes = document.querySelectorAll("body *:not([data-atb-label-checked])");
    for (const el of nodes) {
      el.setAttribute("data-atb-label-checked", "1");
      if (el.children.length > 0) continue; // only leaf label nodes
      const text = (el.textContent || "").trim();
      if (text.length > 60 || !AD_LABEL_PATTERN.test(text)) continue;
      findAdSlotAncestor(el).style.setProperty("display", "none", "important");
    }
  }

  function sweep() {
    if (popupProtectionEnabled) stripMetaRefresh();
    if (!hidingEnabled) return;
    hideByAdLabel();
    const candidates = document.querySelectorAll("div:not([data-atb-swept]), section:not([data-atb-swept]), ins:not([data-atb-swept])");
    for (const el of candidates) {
      el.setAttribute("data-atb-swept", "1");
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w < 20 || h < 20 || !matchesAdSize(w, h)) continue;
      if (!isEmptyContainer(el)) continue;
      el.style.setProperty("display", "none", "important");
    }
  }

  let sweepTimer = null;
  function scheduleSweep(delay) {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, delay);
  }

  window.addEventListener("load", () => {
    scheduleSweep(300);
    scheduleSweep(1500);
    scheduleSweep(4000);
  });

  new MutationObserver(() => scheduleSweep(400)).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
