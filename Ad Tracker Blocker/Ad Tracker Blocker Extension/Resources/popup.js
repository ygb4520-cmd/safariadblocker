const api = globalThis.browser || globalThis.chrome;

const toggleAds = document.getElementById("toggle-ads");
const toggleTrackers = document.getElementById("toggle-trackers");
const toggleMalware = document.getElementById("toggle-malware");
const toggleCustom = document.getElementById("toggle-custom");
const togglePopupRedirect = document.getElementById("toggle-popup-redirect");
const toggleYoutubeSkip = document.getElementById("toggle-youtube-skip");
const togglePause = document.getElementById("toggle-pause");
const siteLabel = document.getElementById("siteLabel");
const rulesHealth = document.getElementById("rulesHealth");
const customInput = document.getElementById("custom-input");
const customAddBtn = document.getElementById("custom-add");
const customList = document.getElementById("custom-list");

let activeHostname = null;

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
  const { state, activeHostname: hostname } = await send({ type: "GET_STATE" });
  activeHostname = hostname;

  toggleAds.checked = !!state.rulesetsEnabled.ads;
  toggleTrackers.checked = !!state.rulesetsEnabled.trackers;
  toggleMalware.checked = state.rulesetsEnabled.malware !== false;
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

init();
