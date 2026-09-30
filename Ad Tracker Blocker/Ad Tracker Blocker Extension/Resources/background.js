// Background service worker: owns all declarativeNetRequest state.
//
// Categories:
//  - "ads" / "trackers" / "malware" / "annoyances" / "antiadblock": static
//    rulesets bundled at build time (rules/ads.json, rules/trackers.json,
//    rules/malware.json, rules/annoyances.json, rules/antiadblock.json).
//    Toggled on/off via updateEnabledRulesets.
//  - "custom": static rulesets are immutable once packaged, so user-added
//    patterns can't be appended to a bundled rules/custom.json at runtime.
//    Instead, custom rules are implemented as *dynamic* rules
//    (chrome.declarativeNetRequest.updateDynamicRules), which the extension
//    is free to add/remove at any time. The "Custom rules" toggle simply
//    adds or removes all of them at once.
//  - "Pause on this site" also uses dynamic rules: a single high-priority
//    "allow" rule scoped to the site's domain, which beats every block rule
//    regardless of which categories are enabled.
//  - "Referrer Privacy" is one more dynamic rule (fixed ID, not list-derived
//    data so it doesn't need a whole static ruleset of its own): strips the
//    Referer header on third-party requests only, not first-party ones --
//    aggressive enough for real privacy benefit, conservative enough not to
//    break same-origin referer checks some sites legitimately rely on.
//  - Custom cosmetic (hide) rules are pure CSS, not declarativeNetRequest at
//    all -- content.js applies them directly, the same way it applies
//    rules/cosmetic.json. background.js only owns storing them
//    (customCosmeticRules: [{hostname, selector}]), added via the popup's
//    element picker (see content.js).

const api = globalThis.browser || globalThis.chrome;

const CUSTOM_RULE_ID_START = 1;
const CUSTOM_RULE_ID_END = 4999; // inclusive upper bound reserved for custom-pattern rules
const PAUSE_RULE_ID_START = 5000;
const PAUSE_RULE_ID_END = 8999; // reserved range for per-site pause/allow rules (thousands of paused sites is unrealistic)
const REFERRER_RULE_ID = 9000; // fixed, single rule -- just past pause's range

const DEFAULT_STATE = {
  rulesetsEnabled: { ads: true, trackers: true, malware: true, annoyances: true, antiadblock: true, custom: true },
  customPatterns: [], // array of raw pattern strings, e.g. "example.com" or "||ads.example.com^"
  pausedDomains: [], // array of hostnames currently whitelisted
  popupRedirectProtection: true, // content.js: window.open guard + meta-refresh stripping
  youtubeAdSkip: true, // youtube-skip.js: auto-click Skip Ad + mute through unskippable ads
  referrerPrivacy: true, // strips the Referer header on third-party requests
  customCosmeticRules: [], // array of {hostname, selector} -- picked via the popup's element picker
};

async function getState() {
  const stored = await api.storage.local.get(DEFAULT_STATE);
  return { ...DEFAULT_STATE, ...stored };
}

async function setState(partial) {
  await api.storage.local.set(partial);
}

function patternToUrlFilter(pattern) {
  const p = pattern.trim();
  if (!p) return null;
  if (p.startsWith("||") || p.startsWith("|") || p.includes("*") || p.includes("^")) {
    return p; // already looks like an Adblock-style filter; use as-is
  }
  return `||${p}^`; // treat as a plain domain
}

async function syncStaticRulesets(state) {
  const enable = [];
  const disable = [];
  for (const id of ["ads", "trackers", "malware", "annoyances", "antiadblock"]) {
    (state.rulesetsEnabled[id] ? enable : disable).push(id);
  }
  await api.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enable,
    disableRulesetIds: disable,
  });
}

// The dynamic-rules store (getDynamicRules/updateDynamicRules) is a single
// shared SQLite-backed resource on Safari's side. Overlapping read-modify-write
// calls against it (e.g. custom-rule sync and pause-rule sync both racing via
// Promise.all) have been observed to crash WebKit's extension rule store, and
// even when it doesn't crash, each call's "existing" snapshot can go stale if
// another call mutates the store first. Serialize all access through this queue.
let dynamicRulesQueue = Promise.resolve();
function withDynamicRulesLock(fn) {
  const result = dynamicRulesQueue.then(fn);
  dynamicRulesQueue = result.catch(() => {});
  return result;
}

async function syncCustomDynamicRules(state) {
  return withDynamicRulesLock(async () => {
    const existing = await api.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing
      .filter((r) => r.id >= CUSTOM_RULE_ID_START && r.id <= CUSTOM_RULE_ID_END)
      .map((r) => r.id);

    const addRules = [];
    if (state.rulesetsEnabled.custom) {
      let id = CUSTOM_RULE_ID_START;
      for (const pattern of state.customPatterns) {
        const urlFilter = patternToUrlFilter(pattern);
        if (!urlFilter || id > CUSTOM_RULE_ID_END) continue;
        addRules.push({
          id: id++,
          priority: 1,
          action: { type: "block" },
          condition: { urlFilter },
        });
      }
    }

    await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  });
}

async function syncPauseDynamicRules(state) {
  return withDynamicRulesLock(async () => {
    const existing = await api.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing
      .filter((r) => r.id >= PAUSE_RULE_ID_START && r.id <= PAUSE_RULE_ID_END)
      .map((r) => r.id);

    const addRules = state.pausedDomains.slice(0, PAUSE_RULE_ID_END - PAUSE_RULE_ID_START + 1).map((domain, i) => ({
      id: PAUSE_RULE_ID_START + i,
      priority: 100, // outranks every block rule, static or dynamic
      action: { type: "allow" },
      // initiatorDomains (the page that *made* the request), not
      // requestDomains (where the request is *going*) -- the whole point
      // of pausing a site is to exempt the third-party ads/trackers/CDNs
      // it embeds, which live on other domains entirely. requestDomains
      // here would only ever match matzav.com's own first-party requests,
      // making pause a near-total no-op.
      condition: { initiatorDomains: [domain] },
    }));

    await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  });
}

async function syncReferrerPrivacyRule(state) {
  return withDynamicRulesLock(async () => {
    const existing = await api.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.filter((r) => r.id === REFERRER_RULE_ID).map((r) => r.id);

    const addRules = [];
    if (state.referrerPrivacy) {
      addRules.push({
        id: REFERRER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "Referer", operation: "remove" }],
        },
        // thirdParty only -- stripping the referer on a site's own
        // first-party requests risks breaking same-origin referer checks
        // (some login/CSRF/hotlink-protection flows legitimately rely on
        // it); third-party is where the actual privacy leak is anyway.
        condition: { domainType: "thirdParty" },
      });
    }

    await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  });
}

// Wipes every dynamic rule regardless of ID range (not just the custom/pause
// ranges the two functions above know about), then lets syncAll() rebuild
// the correct ones from state right after. This is a defensive reset for
// Safari's on-disk dynamic-rules store, run once per extension startup:
// dynamic rules are a derived cache of state.customPatterns/pausedDomains,
// never the source of truth, so clearing it can't lose user settings.
async function resetDynamicRulesStore() {
  return withDynamicRulesLock(async () => {
    const existing = await api.declarativeNetRequest.getDynamicRules();
    if (existing.length === 0) return;
    await api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
    });
  });
}

async function syncAll() {
  const state = await getState();
  await Promise.all([
    syncStaticRulesets(state),
    syncCustomDynamicRules(state),
    syncPauseDynamicRules(state),
    syncReferrerPrivacyRule(state),
  ]);
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Toolbar icon: swaps to a grayed-out variant on tabs whose site is paused,
// so "did I leave this paused?" is answerable without opening the popup.
// This is an ICON swap rather than badge text: the blocked-count badge this
// was designed alongside has since been removed (see disableBlockCountBadge
// below), but a grayed-out icon is a clearer "paused" signal than a tiny
// glyph anyway.
// Icon changes are per-tab (via the tabId option), so switching tabs or
// navigating within a tab has to actively refresh it -- there's no
// automatic "current tab" concept in the action API.
const ICON_SIZES = [16, 32, 48, 128];
const ICON_PATHS_NORMAL = Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon-${s}.png`]));
const ICON_PATHS_PAUSED = Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon-${s}-paused.png`]));

async function updateBadgeForTab(tabId, url) {
  if (tabId == null) return;
  const hostname = hostnameFromUrl(url);
  const state = await getState();
  const paused = !!hostname && state.pausedDomains.includes(hostname);
  try {
    await api.action.setIcon({ tabId, path: paused ? ICON_PATHS_PAUSED : ICON_PATHS_NORMAL });
  } catch {
    // Tab may have closed/navigated away before this resolved -- harmless.
  }
}

// Explicitly turns OFF the browser's automatic "badge text = blocked count"
// display. It was on briefly and the setting persists across restarts, so
// simply not calling it isn't enough for installs that already had it on --
// switch it off and clear any leftover text.
async function disableBlockCountBadge() {
  try {
    await api.declarativeNetRequest.setExtensionActionOptions({
      displayActionCountAsBadgeText: false,
    });
    await api.action.setBadgeText({ text: "" });
  } catch {
    // Not available on this browser/version -- nothing to turn off.
  }
}

async function updateBadgeForActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) await updateBadgeForTab(tab.id, tab.url);
}

api.tabs.onActivated?.addListener(async ({ tabId }) => {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (tab) await updateBadgeForTab(tab.id, tab.url);
});

api.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    updateBadgeForTab(tabId, tab.url);
  }
});

api.runtime.onInstalled.addListener(async () => {
  const stored = await api.storage.local.get(null);
  if (Object.keys(stored).length === 0) {
    await setState(DEFAULT_STATE);
  }
  await resetDynamicRulesStore();
  await syncAll();
  await disableBlockCountBadge();
  await updateBadgeForActiveTab();
});

api.runtime.onStartup?.addListener(async () => {
  await resetDynamicRulesStore();
  await syncAll();
  await disableBlockCountBadge();
  await updateBadgeForActiveTab();
});

// Messages from the popup.
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true; // keep the message channel open for the async response
});

async function handleMessage(message) {
  const state = await getState();

  switch (message.type) {
    case "GET_STATE": {
      let activeHostname = null;
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) activeHostname = hostnameFromUrl(tab.url);
      // Custom patterns beyond this many are silently dropped when synced to
      // dynamic rules (see syncCustomDynamicRules) -- exposed here so the
      // popup can warn before that silently happens.
      const customRuleCap = CUSTOM_RULE_ID_END - CUSTOM_RULE_ID_START + 1;
      return { state, activeHostname, customRuleCap };
    }

    case "SET_RULESET_ENABLED": {
      const rulesetsEnabled = { ...state.rulesetsEnabled, [message.ruleset]: message.enabled };
      await setState({ rulesetsEnabled });
      const newState = { ...state, rulesetsEnabled };
      if (message.ruleset === "custom") {
        await syncCustomDynamicRules(newState);
      } else {
        await syncStaticRulesets(newState);
      }
      return { ok: true };
    }

    case "SET_DOMAIN_PAUSED": {
      const { domain, paused } = message;
      let pausedDomains = state.pausedDomains.filter((d) => d !== domain);
      if (paused) pausedDomains.push(domain);
      await setState({ pausedDomains });
      await syncPauseDynamicRules({ ...state, pausedDomains });
      await updateBadgeForActiveTab();
      return { ok: true };
    }

    case "ADD_CUSTOM_PATTERNS": {
      const additions = message.patterns
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const customPatterns = Array.from(new Set([...state.customPatterns, ...additions]));
      await setState({ customPatterns });
      await syncCustomDynamicRules({ ...state, customPatterns });
      return { ok: true, customPatterns };
    }

    case "REMOVE_CUSTOM_PATTERN": {
      const customPatterns = state.customPatterns.filter((p) => p !== message.pattern);
      await setState({ customPatterns });
      await syncCustomDynamicRules({ ...state, customPatterns });
      return { ok: true, customPatterns };
    }

    case "REQUEST_ELEMENT_PICKER": {
      // See popup.js for why this is relayed through here rather than the
      // popup calling tabs.sendMessage directly.
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab) return { ok: false, error: "no active tab" };
      await api.tabs.sendMessage(tab.id, { type: "START_ELEMENT_PICKER" }).catch(() => {});
      return { ok: true };
    }

    case "ADD_CUSTOM_COSMETIC_RULE": {
      // Sent by content.js's element picker after the user confirms a pick
      // -- hostname/selector are both generated from the actual clicked
      // element, not free-typed, so there's no untrusted-text risk here the
      // way there would be with a manual selector text box.
      const { hostname, selector } = message;
      if (!hostname || !selector) return { ok: false, error: "missing hostname/selector" };
      const exists = state.customCosmeticRules.some(
        (r) => r.hostname === hostname && r.selector === selector
      );
      const customCosmeticRules = exists
        ? state.customCosmeticRules
        : [...state.customCosmeticRules, { hostname, selector }];
      await setState({ customCosmeticRules });
      return { ok: true, customCosmeticRules };
    }

    case "REMOVE_CUSTOM_COSMETIC_RULE": {
      const { hostname, selector } = message;
      const customCosmeticRules = state.customCosmeticRules.filter(
        (r) => !(r.hostname === hostname && r.selector === selector)
      );
      await setState({ customCosmeticRules });
      return { ok: true, customCosmeticRules };
    }

    case "SET_POPUP_PROTECTION_ENABLED": {
      // Purely a content.js behavior toggle -- no declarativeNetRequest
      // rules involved, so there's nothing to sync beyond persisting it.
      await setState({ popupRedirectProtection: message.enabled });
      return { ok: true };
    }

    case "SET_YOUTUBE_SKIP_ENABLED": {
      // Same as above -- youtube-skip.js reads this straight from storage.
      await setState({ youtubeAdSkip: message.enabled });
      return { ok: true };
    }

    case "SET_REFERRER_PRIVACY_ENABLED": {
      await setState({ referrerPrivacy: message.enabled });
      await syncReferrerPrivacyRule({ ...state, referrerPrivacy: message.enabled });
      return { ok: true };
    }

    case "IMPORT_STATE": {
      // The imported file is untrusted input (the user picked an arbitrary
      // file) -- this is the real trust boundary, not popup.js's JSON.parse
      // check. Every field is individually type-checked and only known keys
      // are copied through; anything malformed or unrecognized is silently
      // dropped rather than rejecting the whole import over one bad field.
      const incoming = message.state;
      if (!incoming || typeof incoming !== "object") {
        return { ok: false, error: "Not a settings object" };
      }
      const sanitized = {};
      if (Array.isArray(incoming.customPatterns)) {
        sanitized.customPatterns = incoming.customPatterns.filter((p) => typeof p === "string");
      }
      if (Array.isArray(incoming.pausedDomains)) {
        sanitized.pausedDomains = incoming.pausedDomains.filter((d) => typeof d === "string");
      }
      if (Array.isArray(incoming.customCosmeticRules)) {
        sanitized.customCosmeticRules = incoming.customCosmeticRules.filter(
          (r) => r && typeof r.hostname === "string" && typeof r.selector === "string"
        );
      }
      if (incoming.rulesetsEnabled && typeof incoming.rulesetsEnabled === "object") {
        const rulesetsEnabled = { ...state.rulesetsEnabled };
        for (const key of Object.keys(DEFAULT_STATE.rulesetsEnabled)) {
          if (typeof incoming.rulesetsEnabled[key] === "boolean") {
            rulesetsEnabled[key] = incoming.rulesetsEnabled[key];
          }
        }
        sanitized.rulesetsEnabled = rulesetsEnabled;
      }
      if (typeof incoming.popupRedirectProtection === "boolean") {
        sanitized.popupRedirectProtection = incoming.popupRedirectProtection;
      }
      if (typeof incoming.youtubeAdSkip === "boolean") {
        sanitized.youtubeAdSkip = incoming.youtubeAdSkip;
      }
      if (typeof incoming.referrerPrivacy === "boolean") {
        sanitized.referrerPrivacy = incoming.referrerPrivacy;
      }

      await setState(sanitized);
      await syncAll();
      await updateBadgeForActiveTab();
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}
