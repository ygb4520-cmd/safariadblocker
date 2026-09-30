const api = globalThis.browser || globalThis.chrome;

const filterBox = document.getElementById("filter-this-site");
const listEl = document.getElementById("cosmetic-list");
const emptyEl = document.getElementById("elementsEmpty");
let allRules = [];
let originHost = null;

// A rule saved for example.com also applies on sub.example.com -- same
// parent-domain matching content.js uses, so "this site" means what it does
// when the rule is actually applied.
function appliesToHost(rule, host) {
  return host === rule.hostname || host.endsWith(`.${rule.hostname}`);
}

function render() {
  const thisSiteOnly = filterBox.checked && originHost;
  const rules = thisSiteOnly ? allRules.filter((r) => appliesToHost(r, originHost)) : allRules;

  listEl.innerHTML = "";
  emptyEl.textContent = rules.length
    ? ""
    : thisSiteOnly
      ? "Nothing hidden on this site yet."
      : "Nothing hidden yet.";

  for (const rule of rules) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = `${rule.hostname}: ${rule.selector}`;
    span.title = span.textContent;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      const res = await api.runtime.sendMessage({
        type: "REMOVE_CUSTOM_COSMETIC_RULE",
        hostname: rule.hostname,
        selector: rule.selector,
      });
      allRules = res.customCosmeticRules;
      render();
    });
    li.append(span, removeBtn);
    listEl.appendChild(li);
  }
}

async function init() {
  const { state, activeHostname } = await api.runtime.sendMessage({ type: "GET_STATE" });
  originHost = activeHostname;
  document.getElementById("elementsSite").textContent = originHost || "No active site";
  if (!originHost) {
    // Nothing to filter by (e.g. opened from a blank tab) -- show everything.
    filterBox.checked = false;
    filterBox.disabled = true;
  }
  allRules = state.customCosmeticRules || [];
  render();
}

filterBox.addEventListener("change", render);
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.customCosmeticRules) {
    allRules = changes.customCosmeticRules.newValue || [];
    render();
  }
});

init();
