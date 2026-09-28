const api = globalThis.browser || globalThis.chrome;

// This page opens in its own small window, so "the active tab" here would be
// this window itself -- background.js passes the site the user was actually
// on via the URL when it opens us.
const params = new URLSearchParams(location.search);
const originHost = params.get("host") || null;

const CATEGORIES = [
  { id: "ads", label: "Ads", file: "ads.json" },
  { id: "trackers", label: "Trackers", file: "trackers.json" },
  { id: "malware", label: "Malware / Phishing", file: "malware.json" },
  { id: "annoyances", label: "Annoyances", file: "annoyances.json" },
  { id: "antiadblock", label: "Anti-Adblock", file: "antiadblock.json" },
];

function formatRelativeTime(epochMs) {
  const diffMin = Math.round((Date.now() - epochMs) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}

function addRow(table, label, value, valueClass) {
  const tr = document.createElement("tr");
  const th = document.createElement("td");
  th.textContent = label;
  const td = document.createElement("td");
  td.textContent = value;
  td.className = "stat-value" + (valueClass ? ` ${valueClass}` : "");
  tr.append(th, td);
  table.appendChild(tr);
}

async function loadMeta() {
  try {
    const res = await fetch(api.runtime.getURL("rules/meta.json"));
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function init() {
  document.getElementById("statsSite").textContent = originHost || "No active site";

  const [{ state }, meta] = await Promise.all([
    api.runtime.sendMessage({ type: "GET_STATE" }),
    loadMeta(),
  ]);

  const categoryTable = document.getElementById("categoryTable");
  for (const cat of CATEGORIES) {
    const enabled = state.rulesetsEnabled[cat.id] !== false;
    const info = meta[cat.file];
    const detail = info
      ? `${info.count.toLocaleString()} rules, ${formatRelativeTime(new Date(info.updatedAt).getTime())}`
      : "no data";
    addRow(categoryTable, `${cat.label} (${enabled ? "on" : "off"})`, detail, enabled ? "" : "muted");
  }

  const ownTable = document.getElementById("ownTable");
  addRow(ownTable, "Custom blocking patterns", String(state.customPatterns.length));
  addRow(ownTable, "Custom hidden elements", String((state.customCosmeticRules || []).length));
  addRow(ownTable, "Paused sites", String(state.pausedDomains.length));
}

init();
