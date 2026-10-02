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
//   6. Real cosmetic filtering: rules/cosmetic.json (built by
//      scripts/convert_filterlists.py from EasyList/EasyPrivacy's own ##
//      element-hiding lines) gets fetched once, resolved against the
//      current hostname, and injected as scoped CSS -- replacing guesswork
//      with the filter-list authors' own per-site selectors. Top frame
//      only: ad-hiding targets the main page, not each nested ad iframe.

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

  // --- Real cosmetic filtering (rules/cosmetic.json) ------------------
  // Scoped under html.atb-hide-ads, same as cosmetic.css, so it's inert
  // whenever Ads/Trackers are off or the site is paused -- no separate
  // enable check needed here.
  const COSMETIC_CHUNK_SIZE = 200;

  function hostnameSuffixes(hostname) {
    const parts = hostname.split(".");
    const suffixes = [];
    for (let i = 0; i < parts.length - 1; i++) {
      suffixes.push(parts.slice(i).join("."));
    }
    return suffixes;
  }

  function buildCosmeticCss(data) {
    const suffixes = hostnameSuffixes(location.hostname);
    const excluded = new Set();
    for (const suffix of suffixes) {
      for (const sel of (data.exceptions && data.exceptions[suffix]) || []) excluded.add(sel);
    }

    const selectors = new Set();
    for (const sel of data.generic || []) {
      if (!excluded.has(sel)) selectors.add(sel);
    }
    for (const suffix of suffixes) {
      for (const sel of (data.domains && data.domains[suffix]) || []) selectors.add(sel);
    }

    // Chunked rather than one giant selector list: if any single selector
    // is invalid or uses a pseudo-class this browser doesn't support, only
    // its chunk (<=200 selectors) is dropped by the CSS parser, not the
    // other ~150 chunks.
    const list = [...selectors];
    let css = "";
    for (let i = 0; i < list.length; i += COSMETIC_CHUNK_SIZE) {
      const scoped = list
        .slice(i, i + COSMETIC_CHUNK_SIZE)
        .map((sel) => `html.atb-hide-ads ${sel}`)
        .join(",");
      css += `${scoped}{display:none!important}`;
    }
    return css;
  }

  function loadCosmeticRules() {
    fetch(api.runtime.getURL("rules/cosmetic.json"))
      .then((r) => r.json())
      .then((data) => {
        const css = buildCosmeticCss(data);
        if (!css) return;
        const style = document.createElement("style");
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      })
      .catch(() => {}); // best-effort; a missing/broken file shouldn't break the page
  }

  // --- Custom cosmetic rules (user-picked via the popup's element picker) --
  // A short, per-user list, not filter-list-scale data -- one small <style>
  // block, no chunking needed. Rebuilt (not merely appended to) on every
  // storage change so a removed rule actually stops applying.
  let customCosmeticStyleEl = null;

  function applyCustomCosmeticRules(rules) {
    if (customCosmeticStyleEl) {
      customCosmeticStyleEl.remove();
      customCosmeticStyleEl = null;
    }
    const suffixes = new Set(hostnameSuffixes(location.hostname));
    const matching = (rules || []).filter((r) => suffixes.has(r.hostname));
    if (matching.length === 0) return;
    const css = matching
      .map((r) => `html.atb-hide-ads ${r.selector}{display:none!important}`)
      .join("");
    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    customCosmeticStyleEl = style;
  }

  function loadCustomCosmeticRules() {
    api.storage.local.get(["customCosmeticRules"]).then((s) => {
      applyCustomCosmeticRules(s.customCosmeticRules || []);
    });
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.customCosmeticRules) {
      applyCustomCosmeticRules(changes.customCosmeticRules.newValue || []);
    }
  });

  if (window.top === window.self) {
    loadCosmeticRules();
    loadCustomCosmeticRules();
  }

  // --- Element picker ---------------------------------------------------
  // Point-and-click "hide this" tool, triggered from the popup. Top frame
  // only (same reasoning as the cosmetic-rules loading above): picking an
  // element inside a nested ad iframe isn't supported.
  //
  // Selector strategy, in priority order: a real id > real classes >
  // a short structural (tag + nth-of-type) path. "Real" here means not
  // auto-generated -- CSS-in-JS/build-tool class and id names
  // (e.g. "css-1a2b3c", "sc-bZQynM") are unstable across reloads/deploys,
  // so a selector built from one would likely stop matching by the next
  // visit. The heuristic below is necessarily imperfect (there's no
  // reliable way to know for certain from the string alone), but it
  // catches the common patterns.
  function looksAutoGenerated(token) {
    if (!token) return true;
    if (/^[a-z]{1,4}-[0-9a-f]{4,}$/i.test(token)) return true; // css-1a2b3c
    if (/^(sc|css|jsx|emotion|styled|chakra|mui)-[a-zA-Z0-9]{4,}$/.test(token)) return true;
    if (/^_[a-zA-Z0-9]{5,}$/.test(token)) return true; // _2xK9f
    if (/[0-9]/.test(token) && /[a-f0-9]{6,}/i.test(token) && token.length > 10) return true;
    return false;
  }

  function generateSelector(el) {
    if (el.id && !looksAutoGenerated(el.id)) {
      return `#${CSS.escape(el.id)}`;
    }
    const classes = Array.from(el.classList || []).filter((c) => !looksAutoGenerated(c));
    if (classes.length > 0) {
      return `${el.tagName.toLowerCase()}.${classes.map((c) => CSS.escape(c)).join(".")}`;
    }
    const parts = [];
    let node = el;
    for (let depth = 0; depth < 4 && node && node.nodeType === 1 && node !== document.body; depth++) {
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
      node = parent;
    }
    return parts.length ? parts.join(" > ") : el.tagName.toLowerCase();
  }

  const PICKER_BAR_EVENTS = ["pointerdown", "mousedown", "mouseup", "touchstart", "click"];
  let pickerActive = false;
  let pickerOverlay = null;
  let pickerConfirmBar = null;
  let pickerConfirmBtn = null;
  let pickerCancelBtn = null;
  let pickerTarget = null;
  let pickerTargetPreviousDisplay = "";
  let pickerAwaitingConfirm = false; // true once a target's been clicked and the confirm bar is up

  function pickerHighlight(el) {
    const rect = el.getBoundingClientRect();
    pickerOverlay.style.display = "block";
    pickerOverlay.style.left = `${rect.left}px`;
    pickerOverlay.style.top = `${rect.top}px`;
    pickerOverlay.style.width = `${rect.width}px`;
    pickerOverlay.style.height = `${rect.height}px`;
  }

  function pickerIsOwnElement(el) {
    return el === pickerOverlay || el === pickerConfirmBar || pickerConfirmBar.contains(el);
  }

  function pickerOnMouseMove(event) {
    if (!pickerActive || pickerAwaitingConfirm) return; // don't keep re-highlighting once a target's been picked
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || pickerIsOwnElement(el)) return;
    pickerTarget = el;
    pickerHighlight(el);
  }

  // Once the confirm bar is up, route every pointer event by *coordinates*
  // rather than trusting event.target. On some sites (observed on mlb.com)
  // the bar's buttons stopped receiving clicks even though the bar was
  // visibly on top -- a page-level handler or an inherited pointer-events
  // rule can redirect the event elsewhere, so a plain button click listener
  // never fires. Registered on window in the capture phase so it runs as
  // early as the browser allows.
  function pickerPointInRect(event, el) {
    const r = el.getBoundingClientRect();
    return event.clientX >= r.left && event.clientX <= r.right &&
      event.clientY >= r.top && event.clientY <= r.bottom;
  }

  function pickerOnBarPointer(event) {
    if (!pickerAwaitingConfirm || !pickerConfirmBar) return;
    if (!pickerPointInRect(event, pickerConfirmBar)) return;
    event.stopImmediatePropagation();
    if (event.type !== "click") return;
    event.preventDefault();
    if (pickerPointInRect(event, pickerConfirmBtn)) pickerConfirm();
    else if (pickerPointInRect(event, pickerCancelBtn)) pickerCancel();
  }

  function pickerOnClick(event) {
    if (!pickerActive) return;
    // This runs on the capture phase, before the click reaches its actual
    // target -- if that target is our own confirm/cancel button, don't
    // preventDefault/stopPropagation here, or the button's own click
    // handler (added directly to it, bubble phase) would never receive
    // the event at all.
    if (pickerIsOwnElement(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    // pickerTarget is normally kept current by mousemove, but don't assume
    // one always preceded this click (e.g. a tap with no cursor movement) --
    // fall back to a direct hit-test at the click point.
    const target = pickerTarget || document.elementFromPoint(event.clientX, event.clientY);
    if (!target || pickerIsOwnElement(target)) return;
    pickerTarget = target;
    pickerTargetPreviousDisplay = pickerTarget.style.display;
    pickerTarget.style.setProperty("display", "none", "important");
    // Freeze the highlight rather than leaving it at a now-stale position --
    // the page just reflowed from hiding the target, so continuing to track
    // mousemove would highlight whatever happens to be under the cursor now,
    // not the element the confirm bar is actually asking about.
    pickerOverlay.style.display = "none";
    pickerAwaitingConfirm = true;
    pickerConfirmBar.style.display = "flex";
  }

  function pickerOnKeyDown(event) {
    if (!pickerActive) return;
    if (event.key === "Escape") pickerCancel();
    // Keyboard fallback so confirming never depends on the bar being clickable.
    else if (event.key === "Enter" && pickerAwaitingConfirm) {
      event.preventDefault();
      event.stopPropagation();
      pickerConfirm();
    }
  }

  function pickerCleanup() {
    pickerActive = false;
    pickerAwaitingConfirm = false;
    if (pickerOverlay) pickerOverlay.remove();
    if (pickerConfirmBar) pickerConfirmBar.remove();
    pickerOverlay = null;
    pickerConfirmBar = null;
    pickerConfirmBtn = null;
    pickerCancelBtn = null;
    pickerTarget = null;
  }

  function pickerCancel() {
    if (pickerTarget) {
      pickerTarget.style.display = pickerTargetPreviousDisplay;
    }
    pickerCleanup();
  }

  function pickerConfirm() {
    if (!pickerTarget) return;
    const selector = generateSelector(pickerTarget);
    api.runtime
      .sendMessage({ type: "ADD_CUSTOM_COSMETIC_RULE", hostname: location.hostname, selector })
      .catch(() => {});
    // Leave it hidden (the just-added storage entry will also re-apply it
    // via the storage.onChanged listener above on next load/navigation).
    pickerCleanup();
  }

  function startElementPicker() {
    if (pickerActive) return;
    pickerActive = true;

    pickerOverlay = document.createElement("div");
    pickerOverlay.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff3b30;" +
      "background:rgba(255,59,48,0.15);display:none;box-sizing:border-box;";
    document.documentElement.appendChild(pickerOverlay);

    pickerConfirmBar = document.createElement("div");
    pickerConfirmBar.style.cssText =
      "position:fixed;z-index:2147483647;bottom:20px;left:50%;transform:translateX(-50%);" +
      "background:#1c1c1e;color:#fff;padding:10px 14px;border-radius:10px;" +
      "font:13px -apple-system,BlinkMacSystemFont,sans-serif;display:none;align-items:center;gap:10px;" +
      "white-space:nowrap;width:max-content;max-width:94vw;box-shadow:0 4px 16px rgba(0,0,0,0.35);pointer-events:auto;";
    const label = document.createElement("span");
    label.textContent = "Hide this element on this site? (Enter = hide, Esc = cancel)";
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Hide it";
    confirmBtn.style.cssText =
      "background:#007aff;color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
      "background:transparent;color:#fff;border:1px solid #555;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit;";
    confirmBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      pickerConfirm();
    });
    cancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      pickerCancel();
    });
    pickerConfirmBtn = confirmBtn;
    pickerCancelBtn = cancelBtn;
    pickerConfirmBar.append(label, confirmBtn, cancelBtn);
    document.documentElement.appendChild(pickerConfirmBar);

  }

  // Registered once, at load, rather than per pick: this script runs at
  // document_start, so listeners added here sit *ahead of* any the page adds
  // later on window's capture phase. Registering them only when the picker
  // starts left them behind the page's own -- and a page that calls
  // stopImmediatePropagation on clicks (seen on mlb.com) then swallowed the
  // confirm bar's clicks before these ever ran. Both are no-ops unless a
  // pick is in progress.
  if (window.top === window.self) {
    for (const type of PICKER_BAR_EVENTS) window.addEventListener(type, pickerOnBarPointer, true);
    window.addEventListener("keydown", pickerOnKeyDown, true);
    window.addEventListener("mousemove", pickerOnMouseMove, true);
    window.addEventListener("click", pickerOnClick, true);
  }

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "START_ELEMENT_PICKER" && window.top === window.self) {
      startElementPicker();
    }
  });
})();
