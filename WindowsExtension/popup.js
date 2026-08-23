const api = globalThis.browser || globalThis.chrome;

const toggleAds = document.getElementById("toggle-ads");
const toggleTrackers = document.getElementById("toggle-trackers");
const toggleCustom = document.getElementById("toggle-custom");
const togglePopupRedirect = document.getElementById("toggle-popup-redirect");
const togglePause = document.getElementById("toggle-pause");
const siteLabel = document.getElementById("siteLabel");
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

async function init() {
  const { state, activeHostname: hostname } = await send({ type: "GET_STATE" });
  activeHostname = hostname;

  toggleAds.checked = !!state.rulesetsEnabled.ads;
  toggleTrackers.checked = !!state.rulesetsEnabled.trackers;
  toggleCustom.checked = !!state.rulesetsEnabled.custom;
  togglePopupRedirect.checked = state.popupRedirectProtection !== false;

  if (activeHostname) {
    siteLabel.textContent = activeHostname;
    togglePause.checked = state.pausedDomains.includes(activeHostname);
    togglePause.disabled = false;
  } else {
    siteLabel.textContent = "No active site";
    togglePause.disabled = true;
  }

  renderCustomList(state.customPatterns);
}

toggleAds.addEventListener("change", () => {
  send({ type: "SET_RULESET_ENABLED", ruleset: "ads", enabled: toggleAds.checked });
});

toggleTrackers.addEventListener("change", () => {
  send({ type: "SET_RULESET_ENABLED", ruleset: "trackers", enabled: toggleTrackers.checked });
});

toggleCustom.addEventListener("change", () => {
  send({ type: "SET_RULESET_ENABLED", ruleset: "custom", enabled: toggleCustom.checked });
});

togglePopupRedirect.addEventListener("change", () => {
  send({ type: "SET_POPUP_PROTECTION_ENABLED", enabled: togglePopupRedirect.checked });
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
