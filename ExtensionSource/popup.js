const api = globalThis.browser || globalThis.chrome;

const toggleAds = document.getElementById("toggle-ads");
const toggleTrackers = document.getElementById("toggle-trackers");
const toggleMalware = document.getElementById("toggle-malware");
const toggleAnnoyances = document.getElementById("toggle-annoyances");
const toggleCustom = document.getElementById("toggle-custom");
const togglePopupRedirect = document.getElementById("toggle-popup-redirect");
const toggleYoutubeSkip = document.getElementById("toggle-youtube-skip");
const togglePause = document.getElementById("toggle-pause");
const siteLabel = document.getElementById("siteLabel");
const rulesHealth = document.getElementById("rulesHealth");
const customInput = document.getElementById("custom-input");
const customAddBtn = document.getElementById("custom-add");
const customList = document.getElementById("custom-list");
const customCount = document.getElementById("customCount");
const exportBtn = document.getElementById("export-settings");
const importBtn = document.getElementById("import-settings");
const importFileInput = document.getElementById("import-file-input");
const importStatus = document.getElementById("importStatus");

let activeHostname = null;
let customRuleCap = Infinity;
let currentState = null;

function send(message) {
  return api.runtime.sendMessage(message);
}

function renderCustomList(patterns) {
  customList.innerHTML = "";
  for (const pattern of patterns) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = pattern;
    span.title = pattern;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      const res = await send({ type: "REMOVE_CUSTOM_PATTERN", pattern });
      renderCustomList(res.customPatterns);
    });
    li.append(span, removeBtn);
    customList.appendChild(li);
  }

  const overCap = patterns.length > customRuleCap;
  customCount.textContent = overCap
    ? `${patterns.length} / ${customRuleCap} patterns -- the last ${patterns.length - customRuleCap} aren't being enforced`
    : `${patterns.length} / ${customRuleCap} patterns`;
  customCount.classList.toggle("over-cap", overCap);
}

// rules/meta.json is written by scripts/convert_filterlists.py -- one
// {updatedAt, count} entry per rules file, only updated when that file
// actually got refreshed (see the self-healing check in that script).
// Showing the OLDEST of the tracked files' timestamps, rather than the
// newest, means one stuck/failing category can't hide behind the others
// having refreshed fine.
const RULE_FILES = ["ads.json", "trackers.json", "malware.json", "cosmetic.json"];
const STALE_AFTER_MS = 1000 * 60 * 60 * 24 * 2; // 2 days -- refresh runs daily

function formatRelativeTime(epochMs) {
  const diffMin = Math.round((Date.now() - epochMs) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}

async function loadRulesHealth() {
  try {
    const res = await fetch(api.runtime.getURL("rules/meta.json"));
    if (!res.ok) throw new Error("meta.json not found");
    const meta = await res.json();
    const timestamps = RULE_FILES
      .map((f) => meta[f]?.updatedAt)
      .filter(Boolean)
      .map((iso) => new Date(iso).getTime())
      .filter((ms) => !Number.isNaN(ms));

    if (timestamps.length === 0) {
      rulesHealth.textContent = "Rules: update time unknown";
      rulesHealth.classList.remove("stale");
      return;
    }

    const oldest = Math.min(...timestamps);
    const stale = Date.now() - oldest > STALE_AFTER_MS;
    rulesHealth.textContent = `Rules updated ${formatRelativeTime(oldest)}`;
    rulesHealth.classList.toggle("stale", stale);
  } catch {
    rulesHealth.textContent = "Rules: update time unknown";
    rulesHealth.classList.remove("stale");
  }
}

async function init() {
  const { state, activeHostname: hostname, customRuleCap: cap } = await send({ type: "GET_STATE" });
  activeHostname = hostname;
  currentState = state;
  if (cap) customRuleCap = cap;

  toggleAds.checked = !!state.rulesetsEnabled.ads;
  toggleTrackers.checked = !!state.rulesetsEnabled.trackers;
  toggleMalware.checked = state.rulesetsEnabled.malware !== false;
  toggleAnnoyances.checked = state.rulesetsEnabled.annoyances !== false;
  toggleCustom.checked = !!state.rulesetsEnabled.custom;
  togglePopupRedirect.checked = state.popupRedirectProtection !== false;
  toggleYoutubeSkip.checked = state.youtubeAdSkip !== false;

  if (activeHostname) {
    siteLabel.textContent = activeHostname;
    togglePause.checked = state.pausedDomains.includes(activeHostname);
    togglePause.disabled = false;
  } else {
    siteLabel.textContent = "No active site";
    togglePause.disabled = true;
  }

  renderCustomList(state.customPatterns);
  loadRulesHealth();
}

toggleAds.addEventListener("change", () => {
  send({ type: "SET_RULESET_ENABLED", ruleset: "ads", enabled: toggleAds.checked });
});

toggleTrackers.addEventListener("change", () => {
  send({ type: "SET_RULESET_ENABLED", ruleset: "trackers", enabled: toggleTrackers.checked });
});

toggleMalware.addEventListener("change", () => {
  send({ type: "SET_RULESET_ENABLED", ruleset: "malware", enabled: toggleMalware.checked });
});

toggleAnnoyances.addEventListener("change", () => {
  send({ type: "SET_RULESET_ENABLED", ruleset: "annoyances", enabled: toggleAnnoyances.checked });
});

toggleCustom.addEventListener("change", () => {
  send({ type: "SET_RULESET_ENABLED", ruleset: "custom", enabled: toggleCustom.checked });
});

togglePopupRedirect.addEventListener("change", () => {
  send({ type: "SET_POPUP_PROTECTION_ENABLED", enabled: togglePopupRedirect.checked });
});

toggleYoutubeSkip.addEventListener("change", () => {
  send({ type: "SET_YOUTUBE_SKIP_ENABLED", enabled: toggleYoutubeSkip.checked });
});

togglePause.addEventListener("change", () => {
  if (!activeHostname) return;
  send({ type: "SET_DOMAIN_PAUSED", domain: activeHostname, paused: togglePause.checked });
});

customAddBtn.addEventListener("click", async () => {
  const raw = customInput.value.trim();
  if (!raw) return;
  const res = await send({ type: "ADD_CUSTOM_PATTERNS", patterns: raw });
  renderCustomList(res.customPatterns);
  customInput.value = "";
});

exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(currentState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ad-tracker-blocker-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  importStatus.textContent = "Settings exported.";
  importStatus.classList.remove("error");
});

importBtn.addEventListener("click", () => importFileInput.click());

// Reads an untrusted file the user picked -- background.js's IMPORT_STATE
// handler does the real validation (this extension's own trust boundary is
// there, not here); this is just surfacing a friendly error if the file
// isn't even valid JSON before bothering to send it.
importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files[0];
  importFileInput.value = ""; // allow re-selecting the same file later
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    importStatus.textContent = "That file isn't valid JSON -- was it exported from this extension?";
    importStatus.classList.add("error");
    return;
  }

  const res = await send({ type: "IMPORT_STATE", state: parsed });
  if (res.ok) {
    importStatus.textContent = "Settings imported.";
    importStatus.classList.remove("error");
    await init(); // refresh every toggle/list from the freshly imported state
  } else {
    importStatus.textContent = "Import failed -- see the extension's console for details.";
    importStatus.classList.add("error");
  }
});

init();
