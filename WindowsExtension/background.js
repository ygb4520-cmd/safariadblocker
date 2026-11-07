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
//  - "Site exceptions" (siteExceptions) are the fixes the "This site is
//    broken?" diagnoser creates: per-site allow rules for individual request
//    hosts (dynamic rules, priority 200, IDs 10000-14999), per-site Referrer
//    Privacy exemptions (excluded from that rule), and content.js-side
//    switches (page cleanup / pop-up protection off for one site, one
//    selector un-hidden). Every exception carries a batchId so the newest
//    fix can be undone in one click.
//  - The guided test temporarily switches features off through an *overlay*
//    on the saved state (see overlayState) -- the user's real settings are
//    never modified, so ending/expiring the test can't lose anything.
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
const EXCEPTION_RULE_ID_START = 10000;
const EXCEPTION_RULE_ID_END = 14999; // per-site "allow this request host" rules from the diagnoser
const EXCEPTION_PRIORITY = 200; // outranks pause (100) and every list rule
const MAX_SITE_EXCEPTIONS = 500;
const EXCEPTION_KINDS = ["url", "referrer", "popups", "cleanup", "cosmetic"];

const DEFAULT_STATE = {
  rulesetsEnabled: { ads: true, trackers: true, malware: true, annoyances: true, antiadblock: true, custom: true },
  customPatterns: [], // array of raw pattern strings, e.g. "example.com" or "||ads.example.com^"
  pausedDomains: [], // array of hostnames currently whitelisted
  popupRedirectProtection: true, // content.js: window.open guard + meta-refresh stripping
  youtubeAdSkip: true, // youtube-skip.js: auto-click Skip Ad + mute through unskippable ads
  referrerPrivacy: true, // strips the Referer header on third-party requests
  customCosmeticRules: [], // array of {hostname, selector} -- picked via the popup's element picker
  // Fixes made by the "This site is broken?" diagnoser:
  // {id, kind: url|referrer|popups|cleanup|cosmetic, hostname, requestHost?,
  //  selector?, source?, note?, batchId, addedAt}
  siteExceptions: [],
};

// --- Guided-test overlay ----------------------------------------------------
// While the diagnoser's "turn things off and ask 'is it fixed?'" test runs,
// the features under test are switched off by overlaying them onto the saved
// state at sync time. The saved settings themselves are never touched, so
// ending or expiring a test just re-syncs -- nothing to put back.
const DIAG_KEY = "diagnosticSession";
const DIAG_RESULT_KEY = "diagnosticResult";
const DIAG_EXPIRY_MS = 15 * 60 * 1000;
const DIAG_FEATURE_IDS = ["referrer", "popups", "cleanup", "trackers", "ads", "antiadblock", "annoyances", "malware", "custom"];

let currentDiagnostic = null; // {hostname, tabId, phase, candidates, disabled, startedAt}
let diagnosticLoaded = null;

function loadDiagnostic() {
  if (!diagnosticLoaded) {
    diagnosticLoaded = api.storage.local.get(DIAG_KEY).then((stored) => {
      currentDiagnostic = stored[DIAG_KEY] || null;
    });
  }
  return diagnosticLoaded;
}

function activeDiagnostic() {
  const d = currentDiagnostic;
  if (!d || Date.now() - d.startedAt > DIAG_EXPIRY_MS) return null;
  return d;
}

function overlayState(state) {
  const d = activeDiagnostic();
  if (!d) return state;
  const rulesetsEnabled = { ...state.rulesetsEnabled };
  let referrerPrivacy = state.referrerPrivacy;
  for (const id of d.disabled || []) {
    if (id in rulesetsEnabled) rulesetsEnabled[id] = false;
    if (id === "referrer") referrerPrivacy = false;
  }
  return { ...state, rulesetsEnabled, referrerPrivacy };
}

async function endDiagnostic() {
  currentDiagnostic = null;
  await api.storage.local.remove(DIAG_KEY);
  await syncAll();
}

// Called from frequent events (tab updates, messages): a test left running
// (popup closed, user wandered off) can't leave features off for long.
async function expireDiagnosticIfStale() {
  await loadDiagnostic();
  if (currentDiagnostic && !activeDiagnostic()) await endDiagnostic();
}

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
  state = overlayState(state);
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
  state = overlayState(state);
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

// Per-site "allow this request host" rules created by the diagnoser. A
// priority-200 allow beats every block rule (list or custom) and the pause
// rule, but only for requests the named site makes to the named host.
async function syncExceptionRules(state) {
  return withDynamicRulesLock(async () => {
    const existing = await api.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing
      .filter((r) => r.id >= EXCEPTION_RULE_ID_START && r.id <= EXCEPTION_RULE_ID_END)
      .map((r) => r.id);

    const addRules = [];
    let id = EXCEPTION_RULE_ID_START;
    for (const e of state.siteExceptions || []) {
      if (e.kind !== "url" || !e.requestHost || id > EXCEPTION_RULE_ID_END) continue;
      addRules.push({
        id: id++,
        priority: EXCEPTION_PRIORITY,
        action: { type: "allow" },
        condition: { requestDomains: [e.requestHost], initiatorDomains: [e.hostname] },
      });
    }

    await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  });
}

async function syncReferrerPrivacyRule(state) {
  state = overlayState(state);
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
      // Sites the diagnoser found Referrer Privacy breaking.
      const exempt = (state.siteExceptions || [])
        .filter((e) => e.kind === "referrer")
        .map((e) => e.hostname);
      if (exempt.length > 0) {
        addRules[0].condition.excludedInitiatorDomains = Array.from(new Set(exempt));
      }
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
  await loadDiagnostic();
  const state = await getState();
  await Promise.all([
    syncStaticRulesets(state),
    syncCustomDynamicRules(state),
    syncPauseDynamicRules(state),
    syncReferrerPrivacyRule(state),
    syncExceptionRules(state),
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
  if (changeInfo.status === "loading") forgetMatchLog(tabId);
  expireDiagnosticIfStale().catch(() => {});
});

api.tabs.onRemoved?.addListener((tabId) => forgetMatchLog(tabId));

// --- Exact "which rule blocked this" log (Chrome/Edge, unpacked only) -----------
// declarativeNetRequest.onRuleMatchedDebug reports every request a rule
// matched, with the rule's ruleset+ID -- exact attribution instead of the
// diagnoser's own re-matching. It only exists when the manifest has the
// declarativeNetRequestFeedback permission (WindowsExtension/manifest.json
// only; Safari's manifest is deliberately left alone) AND the extension is
// loaded unpacked. Everywhere else onRuleMatchedDebug is undefined and this
// whole block is inert.
const MATCH_LOG_KEY = "atbMatchLog";
const MATCH_LOG_PER_TAB = 400;
const matchLog = new Map(); // tabId -> [{u, ty, i, rs, ri, ts}]
let matchLogLoaded = null;
let matchLogPersistTimer = null;

function loadMatchLog() {
  if (!matchLogLoaded) {
    matchLogLoaded = (async () => {
      try {
        if (!api.storage.session) return;
        const stored = await api.storage.session.get(MATCH_LOG_KEY);
        for (const [tabId, entries] of Object.entries(stored[MATCH_LOG_KEY] || {})) {
          if (!matchLog.has(Number(tabId))) matchLog.set(Number(tabId), entries);
        }
      } catch {
        // storage.session unavailable -- the in-memory log still works.
      }
    })();
  }
  return matchLogLoaded;
}

function persistMatchLogSoon() {
  if (!api.storage.session || matchLogPersistTimer) return;
  matchLogPersistTimer = setTimeout(() => {
    matchLogPersistTimer = null;
    api.storage.session.set({ [MATCH_LOG_KEY]: Object.fromEntries(matchLog) }).catch(() => {});
  }, 700);
}

function forgetMatchLog(tabId) {
  if (matchLog.delete(tabId)) persistMatchLogSoon();
}

function recordRuleMatch(info) {
  const tabId = info.request && info.request.tabId;
  if (tabId == null || tabId < 0) return;
  const list = matchLog.get(tabId) || [];
  list.push({
    u: String(info.request.url).slice(0, 400),
    ty: info.request.type,
    i: hostnameFromUrl(info.request.initiator || "") || "",
    rs: info.rule.rulesetId,
    ri: info.rule.ruleId,
    ts: Date.now(),
  });
  if (list.length > MATCH_LOG_PER_TAB) list.splice(0, list.length - MATCH_LOG_PER_TAB);
  matchLog.set(tabId, list);
  persistMatchLogSoon();
}

if (api.declarativeNetRequest.onRuleMatchedDebug) {
  loadMatchLog();
  api.declarativeNetRequest.onRuleMatchedDebug.addListener(recordRuleMatch);
}

// Chrome/Edge (Windows) only: the Windows updater (WindowsExtension/updater/)
// rewrites rules/*.json on disk, finishing with meta.json. A static ruleset
// is only re-read when the extension reloads, so notice that meta.json
// changed and reload ourselves. Safari is excluded (it defines `browser`):
// its bundled rules only ever change via a rebuild, which replaces the
// whole extension anyway. Throttled, and the new signature is saved *before*
// reloading so this can't loop.
const RULE_META_SIGNATURE_KEY = "ruleMetaSignature";
const RULE_CHECK_MIN_INTERVAL_MS = 30 * 60 * 1000;
let lastRuleCheckAt = 0;

async function checkForRuleUpdate() {
  if (globalThis.browser) return;
  const now = Date.now();
  if (now - lastRuleCheckAt < RULE_CHECK_MIN_INTERVAL_MS) return;
  lastRuleCheckAt = now;
  try {
    const res = await fetch(api.runtime.getURL("rules/meta.json"), { cache: "no-store" });
    if (!res.ok) return;
    const signature = await res.text();
    const stored = await api.storage.local.get(RULE_META_SIGNATURE_KEY);
    if (stored[RULE_META_SIGNATURE_KEY] === signature) return;
    await api.storage.local.set({ [RULE_META_SIGNATURE_KEY]: signature });
    // First run just records the baseline; only a *change* reloads.
    if (stored[RULE_META_SIGNATURE_KEY] !== undefined) api.runtime.reload();
  } catch {
    // Missing/unreadable meta.json just means no update check this time.
  }
}

checkForRuleUpdate();

api.runtime.onInstalled.addListener(async () => {
  const stored = await api.storage.local.get(null);
  // Ignore the update-check bookkeeping key: it can be written (at service
  // worker start) before this first-install handler runs, and must not make
  // a brand-new install look like it already has saved settings.
  const settingKeys = Object.keys(stored).filter((k) => k !== RULE_META_SIGNATURE_KEY);
  if (settingKeys.length === 0) {
    await setState(DEFAULT_STATE);
  }
  await resetDynamicRulesStore();
  await syncAll();
  await disableBlockCountBadge();
  await updateBadgeForActiveTab();
});

api.runtime.onStartup?.addListener(async () => {
  checkForRuleUpdate();
  // A guided test never survives a browser restart.
  await loadDiagnostic();
  currentDiagnostic = null;
  await api.storage.local.remove(DIAG_KEY);
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

// Reject anything that isn't a plain, sane hostname before it can become part
// of a rule or be echoed back into the UI.
function isHostname(value) {
  return typeof value === "string" && value.length <= 253 && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(value);
}

function sanitizeException(raw) {
  if (!raw || typeof raw !== "object" || !EXCEPTION_KINDS.includes(raw.kind)) return null;
  if (!isHostname(raw.hostname)) return null;
  const out = { kind: raw.kind, hostname: raw.hostname.toLowerCase() };
  if (raw.kind === "url") {
    if (!isHostname(raw.requestHost)) return null;
    out.requestHost = raw.requestHost.toLowerCase();
  }
  if (raw.kind === "cosmetic") {
    if (typeof raw.selector !== "string" || !raw.selector || raw.selector.length > 500) return null;
    out.selector = raw.selector;
    out.source = raw.source === "css" ? "css" : "json";
  }
  if (typeof raw.note === "string") out.note = raw.note.slice(0, 200);
  return out;
}

function sameException(a, b) {
  return a.kind === b.kind && a.hostname === b.hostname &&
    a.requestHost === b.requestHost && a.selector === b.selector;
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function applyExceptionChange(state, siteExceptions) {
  await setState({ siteExceptions });
  const newState = { ...state, siteExceptions };
  await Promise.all([syncExceptionRules(newState), syncReferrerPrivacyRule(newState)]);
}

// The newest batch = the batchId of the most recently added exception.
function lastBatchId(siteExceptions) {
  let newest = null;
  for (const e of siteExceptions) {
    if (!newest || e.addedAt >= newest.addedAt) newest = e;
  }
  return newest ? newest.batchId : null;
}

async function reloadTab(tabId) {
  try {
    await api.tabs.reload(tabId, { bypassCache: true });
  } catch {
    await api.tabs.reload(tabId).catch(() => {});
  }
}

async function handleMessage(message) {
  await expireDiagnosticIfStale();
  const state = await getState();

  switch (message.type) {
    case "CHECK_RULE_UPDATE": {
      // Sent by content.js on page loads (Chrome/Edge only) -- a cheap way to
      // wake this service worker regularly without needing the alarms
      // permission. Throttled inside checkForRuleUpdate().
      checkForRuleUpdate();
      return { ok: true };
    }

    case "GET_STATE": {
      let activeHostname = null;
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) activeHostname = hostnameFromUrl(tab.url);
      // Custom patterns beyond this many are silently dropped when synced to
      // dynamic rules (see syncCustomDynamicRules) -- exposed here so the
      // popup can warn before that silently happens.
      const customRuleCap = CUSTOM_RULE_ID_END - CUSTOM_RULE_ID_START + 1;
      const diag = activeDiagnostic();
      return { state, activeHostname, customRuleCap, diagnosticActive: !!diag };
    }

    case "DIAG_GET": {
      // Everything the diagnose page needs in one round trip.
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      const hostname = tab?.url ? hostnameFromUrl(tab.url) : null;
      let pageLog = null;
      if (tab && tab.id != null) {
        pageLog = await api.tabs.sendMessage(tab.id, { type: "GET_DIAG_LOG" }).catch(() => null);
      }
      await loadMatchLog();
      const stored = await api.storage.local.get(DIAG_RESULT_KEY);
      return {
        state,
        tabId: tab ? tab.id : null,
        hostname,
        session: activeDiagnostic(),
        lastResult: stored[DIAG_RESULT_KEY] || null,
        pageLog,
        canExact: !!api.declarativeNetRequest.onRuleMatchedDebug,
        matchLog: tab && tab.id != null ? matchLog.get(tab.id) || [] : [],
        dynamicRuleBases: {
          custom: [CUSTOM_RULE_ID_START, CUSTOM_RULE_ID_END],
          pause: [PAUSE_RULE_ID_START, PAUSE_RULE_ID_END],
          referrer: REFERRER_RULE_ID,
          exception: [EXCEPTION_RULE_ID_START, EXCEPTION_RULE_ID_END],
        },
      };
    }

    case "DIAG_SET_SESSION": {
      // The diagnose page owns the test's logic (diagnose-core.js) and just
      // asks us to apply a step: remember it, re-sync with the overlay, and
      // reload the tab under test so the user can look at the result.
      const sess = message.session;
      if (!sess || typeof sess.tabId !== "number" || !isHostname(sess.hostname)) {
        return { ok: false, error: "bad session" };
      }
      const clean = (list) => (Array.isArray(list) ? list.filter((id) => DIAG_FEATURE_IDS.includes(id)) : []);
      currentDiagnostic = {
        hostname: sess.hostname.toLowerCase(),
        tabId: sess.tabId,
        phase: ["all", "search", "confirm"].includes(sess.phase) ? sess.phase : "all",
        candidates: clean(sess.candidates),
        disabled: clean(sess.disabled),
        startedAt: Date.now(), // refreshed every step: expiry counts from the last one
      };
      await api.storage.local.set({ [DIAG_KEY]: currentDiagnostic });
      await syncAll();
      await reloadTab(sess.tabId);
      return { ok: true, session: currentDiagnostic };
    }

    case "DIAG_END_SESSION": {
      // Restores everything (the overlay simply goes away) and optionally
      // keeps the verdict so the page can show it next time it's opened.
      const hadSession = !!currentDiagnostic;
      const tabId = currentDiagnostic ? currentDiagnostic.tabId : null;
      await endDiagnostic();
      if (message.result && isHostname(message.hostname)) {
        await api.storage.local.set({
          [DIAG_RESULT_KEY]: { hostname: message.hostname.toLowerCase(), result: message.result, at: Date.now() },
        });
      }
      if (hadSession && tabId != null && message.reload !== false) await reloadTab(tabId);
      return { ok: true };
    }

    case "DIAG_CLEAR_RESULT": {
      await api.storage.local.remove(DIAG_RESULT_KEY);
      return { ok: true };
    }

    case "DIAG_APPLY_FIX": {
      // Fixes are made under the user's NORMAL settings, so end any running
      // test first -- otherwise the "did it help?" check would still have
      // features switched off.
      if (currentDiagnostic) await endDiagnostic();
      const incoming = Array.isArray(message.items) ? message.items : [];
      const batchId = newId();
      const addedAt = Date.now();
      let siteExceptions = (state.siteExceptions || []).slice();
      let added = 0;
      for (const raw of incoming) {
        const clean = sanitizeException(raw);
        if (!clean || siteExceptions.some((e) => sameException(e, clean))) continue;
        if (siteExceptions.length >= MAX_SITE_EXCEPTIONS) break;
        siteExceptions.push({ ...clean, id: newId(), batchId, addedAt });
        added++;
      }
      if (added > 0) await applyExceptionChange(state, siteExceptions);
      return { ok: true, added, batchId: added > 0 ? batchId : null, siteExceptions };
    }

    case "DIAG_UNDO_LAST": {
      const batchId = lastBatchId(state.siteExceptions || []);
      if (!batchId) return { ok: true, removed: 0, siteExceptions: state.siteExceptions || [] };
      const siteExceptions = state.siteExceptions.filter((e) => e.batchId !== batchId);
      await applyExceptionChange(state, siteExceptions);
      return { ok: true, removed: state.siteExceptions.length - siteExceptions.length, siteExceptions };
    }

    case "DIAG_REMOVE_EXCEPTION": {
      const siteExceptions = (state.siteExceptions || []).filter((e) => e.id !== message.id);
      await applyExceptionChange(state, siteExceptions);
      return { ok: true, siteExceptions };
    }

    case "DIAG_CLEAR_HOST": {
      if (!isHostname(message.hostname)) return { ok: false, error: "bad hostname" };
      const host = message.hostname.toLowerCase();
      const siteExceptions = (state.siteExceptions || []).filter((e) => e.hostname !== host);
      await applyExceptionChange(state, siteExceptions);
      return { ok: true, siteExceptions };
    }

    case "DIAG_RELOAD_TAB": {
      if (typeof message.tabId === "number") await reloadTab(message.tabId);
      return { ok: true };
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
      if (Array.isArray(incoming.siteExceptions)) {
        const seen = [];
        for (const raw of incoming.siteExceptions) {
          const clean = sanitizeException(raw);
          if (!clean || seen.some((e) => sameException(e, clean))) continue;
          if (seen.length >= MAX_SITE_EXCEPTIONS) break;
          seen.push({
            ...clean,
            id: newId(),
            batchId: typeof raw.batchId === "string" ? raw.batchId.slice(0, 40) : "imported",
            addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
          });
        }
        sanitized.siteExceptions = seen;
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
