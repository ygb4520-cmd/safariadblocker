// Background service worker: owns all declarativeNetRequest state.
//
// Categories:
//  - "ads" / "trackers": static rulesets bundled at build time (rules/ads.json,
//    rules/trackers.json). Toggled on/off via updateEnabledRulesets.
//  - "custom": static rulesets are immutable once packaged, so user-added
//    patterns can't be appended to a bundled rules/custom.json at runtime.
//    Instead, custom rules are implemented as *dynamic* rules
//    (chrome.declarativeNetRequest.updateDynamicRules), which the extension
//    is free to add/remove at any time. The "Custom rules" toggle simply
//    adds or removes all of them at once.
//  - "Pause on this site" also uses dynamic rules: a single high-priority
//    "allow" rule scoped to the site's domain, which beats every block rule
//    regardless of which categories are enabled.

const api = globalThis.browser || globalThis.chrome;

const CUSTOM_RULE_ID_START = 1;
const CUSTOM_RULE_ID_END = 4999; // inclusive upper bound reserved for custom-pattern rules
const PAUSE_RULE_ID_START = 5000; // reserved range for per-site pause/allow rules

const DEFAULT_STATE = {
  rulesetsEnabled: { ads: true, trackers: true, custom: true },
  customPatterns: [], // array of raw pattern strings, e.g. "example.com" or "||ads.example.com^"
  pausedDomains: [], // array of hostnames currently whitelisted
  popupRedirectProtection: true, // content.js: window.open guard + meta-refresh stripping
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
  for (const id of ["ads", "trackers"]) {
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
      .filter((r) => r.id >= PAUSE_RULE_ID_START)
      .map((r) => r.id);

    const addRules = state.pausedDomains.map((domain, i) => ({
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

async function syncAll() {
  const state = await getState();
  await Promise.all([
    syncStaticRulesets(state),
    syncCustomDynamicRules(state),
    syncPauseDynamicRules(state),
  ]);
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

api.runtime.onInstalled.addListener(async () => {
  const stored = await api.storage.local.get(null);
  if (Object.keys(stored).length === 0) {
    await setState(DEFAULT_STATE);
  }
  await syncAll();
});

api.runtime.onStartup?.addListener(() => {
  syncAll();
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
      return { state, activeHostname };
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

    case "SET_POPUP_PROTECTION_ENABLED": {
      // Purely a content.js behavior toggle -- no declarativeNetRequest
      // rules involved, so there's nothing to sync beyond persisting it.
      await setState({ popupRedirectProtection: message.enabled });
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}
