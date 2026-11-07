// The popup's "This site is broken?" page: explains what we blocked/hid on
// the current page, can run a guided "turn features off one group at a time"
// test, offers narrow per-site fixes, and always lets the newest fix be undone.
// Pure logic (matching, ranking, test sequencing) lives in diagnose-core.js.

const api = globalThis.browser || globalThis.chrome;
const D = globalThis.ATBDiag;

const LIST_LABELS = {
  ads: "Ads list",
  trackers: "Trackers list",
  malware: "Malware / Phishing list",
  annoyances: "Annoyances list",
  antiadblock: "Anti-Adblock list",
  custom: "your custom patterns",
  paused: "site pause",
  exception: "your site fixes",
};
const STATIC_LISTS = ["ads", "trackers", "malware", "annoyances", "antiadblock"];
const ISSUES_URL = "https://github.com/ygb4520-cmd/safariadblocker/issues/new";
const REASON_TEXT = {
  "failed-load": "an image or frame that failed to load",
  "failed-load-wrapper": "the box around an image that failed to load",
  "ad-label": "a box labeled \"Advertisement\"",
  "ad-size": "an empty box shaped like an ad",
};

const send = (message) => api.runtime.sendMessage(message);

// ---- tiny DOM helper (text only -- page-derived strings never become HTML) ----
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "checked") el.checked = !!value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function tag(text, warn) {
  return h("span", { class: "diag-tag" + (warn ? " warn" : "") }, text);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + "s"}`;
}

function hostCovered(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

// ---- Matching our rules against what failed -----------------------------------
function patternToUrlFilter(pattern) {
  const p = pattern.trim();
  if (!p) return null;
  if (p.startsWith("||") || p.startsWith("|") || p.includes("*") || p.includes("^")) return p;
  return `||${p}^`;
}

// The extension's dynamic rules, rebuilt as plain objects (same shapes and
// priorities as background.js creates them) so the matcher sees them too.
function dynamicRulesets(state) {
  const custom = [];
  if (state.rulesetsEnabled.custom) {
    (state.customPatterns || []).forEach((p, i) => {
      const urlFilter = patternToUrlFilter(p);
      if (urlFilter) custom.push({ id: i + 1, priority: 1, action: { type: "block" }, condition: { urlFilter } });
    });
  }
  const paused = (state.pausedDomains || []).map((d, i) => ({
    id: 5000 + i, priority: 100, action: { type: "allow" }, condition: { initiatorDomains: [d] },
  }));
  const exception = (state.siteExceptions || [])
    .filter((e) => e.kind === "url")
    .map((e, i) => ({
      id: 10000 + i, priority: 200, action: { type: "allow" },
      condition: { requestDomains: [e.requestHost], initiatorDomains: [e.hostname] },
    }));
  return [
    { name: "custom", rules: custom },
    { name: "paused", rules: paused },
    { name: "exception", rules: exception },
  ];
}

async function fetchRules(listId) {
  const res = await fetch(api.runtime.getURL(`rules/${listId}.json`));
  if (!res.ok) throw new Error(`rules/${listId}.json`);
  return res.json();
}

const TYPE_TO_KIND = {
  xmlhttprequest: "fetch", image: "img", script: "script", stylesheet: "css", media: "media",
  sub_frame: "iframe", font: "font", ping: "ping", other: "other",
};

// Exact attribution (Chrome/Edge unpacked): look the matched rule up by ID.
async function resolveExact(matchLog, state, bases) {
  const wanted = {};
  for (const e of matchLog) {
    if (STATIC_LISTS.includes(e.rs)) (wanted[e.rs] = wanted[e.rs] || new Set()).add(e.ri);
  }
  const staticIndex = {};
  await Promise.all(
    Object.keys(wanted).map(async (listId) => {
      try {
        const rules = await fetchRules(listId);
        staticIndex[listId] = new Map(rules.filter((r) => wanted[listId].has(r.id)).map((r) => [r.id, r]));
      } catch {
        staticIndex[listId] = new Map();
      }
    })
  );

  const blocks = [];
  const referrerHosts = [];
  for (const e of matchLog) {
    if (e.rs === "_dynamic") {
      if (e.ri === bases.referrer) {
        referrerHosts.push(D.hostFromUrl(e.u));
        continue;
      }
      const inRange = (range) => e.ri >= range[0] && e.ri <= range[1];
      if (inRange(bases.custom)) {
        const pattern = (state.customPatterns || [])[e.ri - bases.custom[0]];
        blocks.push({ url: e.u, kind: TYPE_TO_KIND[e.ty] || "other", ruleset: "custom", ruleId: e.ri, urlFilter: pattern || "", exact: true });
      }
      continue;
    }
    const rule = staticIndex[e.rs] && staticIndex[e.rs].get(e.ri);
    if (rule && rule.action && rule.action.type === "block") {
      blocks.push({
        url: e.u, kind: TYPE_TO_KIND[e.ty] || "other", ruleset: e.rs, ruleId: e.ri,
        urlFilter: (rule.condition && rule.condition.urlFilter) || "", exact: true,
      });
    }
  }
  return { blocks, referrerHosts };
}

// Everything the page knows, merged into one analysis object.
async function analyze(data) {
  const { state, hostname, pageLog, matchLog, canExact, dynamicRuleBases } = data;
  const out = {
    groups: [], notOurs: 0, hiddenCosmetic: [], hiddenHeuristic: [], popupsBlocked: 0,
    referrerHosts: [], canExact, watched: !!pageLog, callsWatched: !!(pageLog && pageLog.failedCalls),
    cleanupOn: !!(pageLog && pageLog.cleanupOn), popupsOn: !!(pageLog && pageLog.popupsOn),
  };
  if (!pageLog) return out;

  // 1. Everything that failed to load, merged by URL.
  const failed = new Map();
  for (const f of [...(pageLog.failedElements || []), ...(pageLog.failedCalls || [])]) {
    const key = f.url.split("#")[0];
    if (!failed.has(key)) failed.set(key, { url: key, kind: f.kind });
  }

  // 2. Exact attribution where the browser can give it.
  let exact = { blocks: [], referrerHosts: [] };
  if (canExact && matchLog && matchLog.length) {
    try {
      exact = await resolveExact(matchLog, state, dynamicRuleBases);
    } catch {
      exact = { blocks: [], referrerHosts: [] };
    }
  }
  out.referrerHosts = exact.referrerHosts;

  const items = new Map(); // url -> item
  for (const b of exact.blocks) items.set(b.url.split("#")[0], { ...b, url: b.url.split("#")[0] });

  // 3. For the rest, re-match against our own rule files ("likely").
  const unmatched = [...failed.values()].filter((f) => !items.has(f.url));
  if (unmatched.length > 0) {
    const enabled = STATIC_LISTS.filter((id) => state.rulesetsEnabled[id]);
    const rulesets = [...dynamicRulesets(state)];
    await Promise.all(
      enabled.map(async (id) => {
        try {
          rulesets.push({ name: id, rules: await fetchRules(id) });
        } catch {
          // a missing list just means fewer possible matches
        }
      })
    );
    const matcher = D.createMatcher(rulesets);
    for (const f of unmatched) {
      const r = matcher.match({ url: f.url, type: f.kind, initiator: hostname });
      if (r.verdict === "block" && r.winner) {
        items.set(f.url, {
          url: f.url, kind: f.kind, ruleset: r.winner.ruleset, ruleId: r.winner.rule.id,
          urlFilter: (r.winner.rule.condition && r.winner.rule.condition.urlFilter) || "", exact: false,
        });
      } else {
        out.notOurs++;
      }
    }
  }

  // 4. Group by the host the page was talking to; rank by how needed it looks.
  const byHost = new Map();
  for (const item of items.values()) {
    item.host = D.hostFromUrl(item.url);
    item.score = D.suspectScore(item, hostname);
    if (!byHost.has(item.host)) byHost.set(item.host, { host: item.host, items: [] });
    byHost.get(item.host).items.push(item);
  }
  out.groups = [...byHost.values()].map((g) => {
    g.score = Math.max(...g.items.map((i) => i.score));
    g.label = D.suspectLabel(g.score);
    g.lists = [...new Set(g.items.map((i) => i.ruleset))];
    g.exact = g.items.some((i) => i.exact);
    return g;
  }).sort((a, b) => b.score - a.score || b.items.length - a.items.length);

  // 5. Hidden things.
  out.hiddenCosmetic = (pageLog.cosmetic || [])
    .filter((m) => m.hiddenNow)
    .map((m) => ({ ...m, interesting: m.samples.some((s) => s.textLen >= 20 || s.hasMedia) }))
    .sort((a, b) => Number(b.interesting) - Number(a.interesting));
  const reasons = new Map();
  for (const x of pageLog.hidden || []) reasons.set(x.reason, (reasons.get(x.reason) || 0) + 1);
  out.hiddenHeuristic = [...reasons.entries()].map(([reason, count]) => ({ reason, count }));
  out.popupsBlocked = pageLog.popupsBlocked || 0;
  return out;
}

// ---- State shared by the render functions ------------------------------------------
let ctx = null; // {data, analysis}
let lastApplied = null; // {batchId, added}

function describeException(e) {
  switch (e.kind) {
    case "url": return `Allow ${e.requestHost} to load on ${e.hostname}`;
    case "referrer": return `Keep the referrer on ${e.hostname}`;
    case "popups": return `Allow pop-ups on ${e.hostname}`;
    case "cleanup": return `Page cleanup off on ${e.hostname}`;
    case "cosmetic": return `Show ${e.selector} on ${e.hostname}`;
    default: return e.kind;
  }
}

function setStatus(content) {
  const box = document.getElementById("diagStatus");
  box.replaceChildren();
  if (!content) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.append(...[content].flat());
}

async function refresh() {
  const data = await send({ type: "DIAG_GET" });
  const analysis = await analyze(data);
  ctx = { data, analysis };
  render();
}

// ---- Fix actions ---------------------------------------------------------------------
async function applyFix(items, what) {
  const res = await send({ type: "DIAG_APPLY_FIX", items });
  await refresh();
  if (!res || !res.added) {
    setStatus(h("span", {}, "Nothing new to apply — that fix is already in place."));
    return;
  }
  lastApplied = { batchId: res.batchId, added: res.added };
  setStatus([
    h("div", {}, `✓ ${what} Reload the page to see if that fixed it.`),
    h("button", { onclick: reloadPage }, "Reload the page"),
    h("button", { class: "secondary-btn", onclick: undoLast }, "Undo"),
  ]);
}

async function reloadPage() {
  await send({ type: "DIAG_RELOAD_TAB", tabId: ctx.data.tabId });
  setStatus(h("span", {}, "Reloaded. If it's still broken, press Undo — or try another fix below."));
  const box = document.getElementById("diagStatus");
  box.append(h("div", { class: "diag-actions" }, h("button", { class: "secondary-btn", onclick: undoLast }, "Undo the last fix")));
}

async function undoLast() {
  const res = await send({ type: "DIAG_UNDO_LAST" });
  lastApplied = null;
  await refresh();
  setStatus(
    h("div", {}, res && res.removed ? `Undone — removed ${plural(res.removed, "change")}. Reload the page to see it as before.` : "There was nothing to undo.")
  );
}

async function removeException(id) {
  await send({ type: "DIAG_REMOVE_EXCEPTION", id });
  lastApplied = null;
  await refresh();
}

// ---- Guided test --------------------------------------------------------------------------
async function startTest() {
  const { data } = ctx;
  const testable = D.testableFeatures(data.state);
  if (!data.hostname || data.tabId == null) return;
  const session = D.startSession(testable);
  if (session.phase === "done") {
    await send({ type: "DIAG_END_SESSION", result: session.result, hostname: data.hostname, reload: false });
    await refresh();
    return;
  }
  await send({ type: "DIAG_CLEAR_RESULT" });
  await send({ type: "DIAG_SET_SESSION", session: { ...session, hostname: data.hostname, tabId: data.tabId } });
  await refresh();
}

async function answerTest(worked) {
  const { data } = ctx;
  const session = data.session;
  if (!session) return;
  const next = D.nextStep(session, worked);
  if (next.phase === "done") {
    await send({ type: "DIAG_END_SESSION", result: next.result, hostname: session.hostname, reload: true });
  } else {
    await send({ type: "DIAG_SET_SESSION", session: { ...next, hostname: session.hostname, tabId: session.tabId } });
  }
  await refresh();
}

async function stopTest() {
  await send({ type: "DIAG_END_SESSION", reload: true });
  await refresh();
  setStatus(h("span", {}, "Test stopped — your settings are exactly as they were."));
}

// ---- Rendering ---------------------------------------------------------------------------------
function featureList(ids) {
  return h("ul", {}, ids.map((id) => {
    const f = D.featureById(id);
    return h("li", {}, h("b", {}, f ? f.label : id), f ? ` — ${f.what}` : "");
  }));
}

function renderSession(session) {
  const intro = {
    all: "Test 1 — everything switched off. If the site works now, one of our features is the cause and we'll narrow it down.",
    search: "Narrowing it down. We switched off just the features below.",
    confirm: "Double-checking. Only this one feature is switched off now.",
  }[session.phase] || "";
  return h("div", { class: "diag-card" },
    h("h2", {}, "Test in progress"),
    h("p", {}, intro),
    h("p", {}, "Switched off just for this test (the page was reloaded):"),
    featureList(session.disabled),
    h("p", {}, h("b", {}, "Is the site working properly now?")),
    h("div", { class: "diag-actions" },
      h("button", { onclick: () => answerTest(true) }, "Yes, it works now"),
      h("button", { class: "secondary-btn", onclick: () => answerTest(false) }, "No, still broken")
    ),
    h("p", { class: "hint" }, "Your real settings are never changed by this test, and it ends by itself after 15 minutes."),
    h("div", { class: "diag-actions" }, h("button", { class: "secondary-btn", onclick: stopTest }, "Stop the test & restore everything"))
  );
}

function renderResult(lastResult) {
  if (!lastResult || lastResult.hostname !== ctx.data.hostname) return null;
  const r = lastResult.result;
  const host = ctx.data.hostname;
  const card = h("div", { class: "diag-card" }, h("h2", {}, "Test result"));
  const clear = h("div", { class: "diag-actions" },
    h("button", { class: "secondary-btn", onclick: async () => { await send({ type: "DIAG_CLEAR_RESULT" }); await refresh(); } }, "Dismiss this result"));

  if (r.kind === "not-us") {
    card.append(
      h("p", {}, "Switching everything off didn't fix it, so this doesn't look like Ad & Tracker Blocker. It's more likely the site itself, your connection, or another extension."),
      clear
    );
  } else if (r.kind === "nothing-to-test") {
    card.append(h("p", {}, "Every feature that could cause this is already switched off, so there's nothing to test."), clear);
  } else if (r.kind === "multiple") {
    card.append(
      h("p", {}, "More than one of our features is involved, so no single switch fixes it."),
      h("p", {}, "Simplest fix: pause blocking on this site. Or use the lists below to allow just the requests it needs."),
      h("div", { class: "diag-actions" },
        h("button", { onclick: async () => { await send({ type: "SET_DOMAIN_PAUSED", domain: host, paused: true }); await send({ type: "DIAG_CLEAR_RESULT" }); await reloadPage(); await refresh(); } }, "Pause on this site")),
      clear
    );
  } else if (r.kind === "culprit") {
    const f = D.featureById(r.feature);
    card.append(h("p", {}, h("b", {}, `Found it: ${f ? f.label : r.feature}`), ` — ${f ? f.what : ""}.`));
    const fixes = {
      referrer: ["Some sites need to know where you came from. Stop hiding it on this site only:", [{ kind: "referrer", hostname: host }], "Referrer Privacy is now off for this site only."],
      popups: ["This site opens a window on its own that we were blocking. Allow that on this site only:", [{ kind: "popups", hostname: host }], "Pop-ups are now allowed on this site only."],
      cleanup: ["Our page cleanup hid something the site needs. Turn cleanup off for this site only (network blocking stays on):", [{ kind: "cleanup", hostname: host }], "Page cleanup is now off for this site only."],
    }[r.feature];
    if (fixes) {
      card.append(
        h("p", {}, fixes[0]),
        h("div", { class: "diag-actions" }, h("button", { onclick: () => applyFix(fixes[1], fixes[2]) }, "Fix it for this site"))
      );
    } else {
      card.append(h("p", {}, "It blocked something the site needs. See “Requests that failed” below — the ones from that list are already ticked. Allow them for this site, or pause the site."));
    }
    card.append(clear);
  }
  return card;
}

function groupRow(group, preselect) {
  const box = h("input", { type: "checkbox", "data-host": group.host, checked: preselect(group) });
  const where = group.lists.map((l) => LIST_LABELS[l] || l).join(", ");
  const kinds = [...new Set(group.items.map((i) => i.kind))].join(", ");
  const sample = D.sanitizeUrl(group.items[0].url);
  return h("li", {},
    box,
    h("div", { class: "diag-main" },
      h("div", {}, h("b", {}, group.host), tag(group.label, group.label === "possibly needed")),
      h("div", { class: "diag-sub" },
        `${plural(group.items.length, "request")} · ${kinds} · blocked by ${where} ${group.exact ? "(exact)" : "(likely)"}`),
      h("div", { class: "diag-sub" }, sample))
  );
}

function renderRequests(analysis, lastResult) {
  const host = ctx.data.hostname;
  const culprit = lastResult && lastResult.hostname === host && lastResult.result.kind === "culprit" ? lastResult.result.feature : null;
  const preselect = (g) => (culprit && STATIC_LISTS.concat("custom").includes(culprit) ? g.lists.includes(culprit) : g.label === "possibly needed");
  const sec = h("details", { class: "diag-section", open: analysis.groups.length > 0 }, h("summary", {}, `Requests that were blocked (${analysis.groups.length} ${analysis.groups.length === 1 ? "site" : "sites"})`));
  if (!analysis.watched) {
    sec.append(h("p", { class: "hint" }, "Couldn't read this page's activity. Reload the page, then open this screen again (it can't run on browser pages like new-tab)."));
    return sec;
  }
  if (analysis.groups.length === 0) {
    sec.append(h("p", { class: "hint" }, "Nothing this page tried to load was blocked by our lists. If the page is still broken, the cause is probably Referrer Privacy, page cleanup or a pop-up block — the guided test will tell."));
  } else {
    sec.append(h("p", { class: "hint" }, "Ticked = looks like the site actually needs it. Allow only those, on this site only."));
    const list = h("ul", { class: "diag-list" }, analysis.groups.map((g) => groupRow(g, preselect)));
    sec.append(list, h("div", { class: "diag-actions" },
      h("button", {
        onclick: () => {
          const hosts = [...list.querySelectorAll("input:checked")].map((i) => i.getAttribute("data-host"));
          if (hosts.length === 0) return setStatus(h("span", {}, "Tick at least one request first."));
          applyFix(hosts.map((requestHost) => ({ kind: "url", hostname: host, requestHost })), `Allowed ${plural(hosts.length, "site")} to load on ${host}.`);
        },
      }, "Allow ticked ones on this site")));
  }
  if (analysis.notOurs > 0) {
    sec.append(h("p", { class: "hint" }, `${plural(analysis.notOurs, "other request")} also failed, but not because of our rules (usually the site or your connection).`));
  }
  if (!analysis.callsWatched) {
    sec.append(h("p", { class: "hint" }, "This site's security settings stopped us from watching its background requests, so some blocks may be missing here."));
  }
  return sec;
}

function renderHidden(analysis) {
  const host = ctx.data.hostname;
  const sec = h("details", { class: "diag-section" }, h("summary", {}, "Things we hid on the page"));
  if (analysis.hiddenCosmetic.length === 0 && analysis.hiddenHeuristic.length === 0) {
    sec.append(h("p", { class: "hint" }, "We didn't hide anything on this page."));
    return sec;
  }
  if (analysis.hiddenCosmetic.length > 0) {
    sec.append(h("p", { class: "hint" }, "Hidden by the element-hiding lists. Items with text or media are the most likely to be real content:"));
    sec.append(h("ul", { class: "diag-list" }, analysis.hiddenCosmetic.slice(0, 8).map((m) =>
      h("li", {},
        h("div", { class: "diag-main" },
          h("div", {}, m.samples[0].desc, m.interesting ? tag("has real content", true) : null),
          h("div", { class: "diag-sub" }, `${plural(m.count, "element")} · rule: ${m.selector.slice(0, 90)}`)),
        h("button", { onclick: () => applyFix([{ kind: "cosmetic", hostname: host, selector: m.selector, source: m.source }], "That element is now shown on this site.") }, "Show it")))));
  }
  if (analysis.hiddenHeuristic.length > 0) {
    sec.append(h("p", { class: "hint" }, "Hidden by our automatic cleanup:"));
    sec.append(h("ul", {}, analysis.hiddenHeuristic.map((x) => h("li", {}, `${plural(x.count, "thing")}: ${REASON_TEXT[x.reason] || x.reason}`))));
  }
  if (analysis.cleanupOn) {
    sec.append(h("div", { class: "diag-actions" },
      h("button", { class: "secondary-btn", onclick: () => applyFix([{ kind: "cleanup", hostname: host }], "Page cleanup is now off for this site only.") }, "Turn page cleanup off on this site")));
  }
  return sec;
}

function renderOther(analysis) {
  const host = ctx.data.hostname;
  const state = ctx.data.state;
  const covered = (kind) => (state.siteExceptions || []).some((e) => e.kind === kind && hostCovered(host, e.hostname));
  const sec = h("details", { class: "diag-section" }, h("summary", {}, "Referrer and pop-ups"));
  const exactLine = analysis.referrerHosts.length
    ? ` It removed the referrer from ${plural(analysis.referrerHosts.length, "request")} (to ${[...new Set(analysis.referrerHosts)].slice(0, 4).join(", ")}).`
    : "";
  sec.append(h("p", {}, state.referrerPrivacy ? "Referrer Privacy is on: requests to other sites don't say which site you came from." + exactLine : "Referrer Privacy is off."));
  if (state.referrerPrivacy && !covered("referrer")) {
    sec.append(h("div", { class: "diag-actions" },
      h("button", { class: "secondary-btn", onclick: () => applyFix([{ kind: "referrer", hostname: host }], "Referrer Privacy is now off for this site only.") }, "Don't hide the referrer on this site")));
  }
  sec.append(h("p", {}, analysis.popupsBlocked > 0 ? `${plural(analysis.popupsBlocked, "pop-up")} blocked on this page.` : "No pop-ups were blocked on this page."));
  if (analysis.popupsBlocked > 0 && !covered("popups")) {
    sec.append(h("div", { class: "diag-actions" },
      h("button", { class: "secondary-btn", onclick: () => applyFix([{ kind: "popups", hostname: host }], "Pop-ups are now allowed on this site only.") }, "Allow pop-ups on this site")));
  }
  return sec;
}

function lastBatch(exceptions) {
  let newest = null;
  for (const e of exceptions) if (!newest || e.addedAt >= newest.addedAt) newest = e;
  return newest ? exceptions.filter((e) => e.batchId === newest.batchId) : [];
}

function renderFixes() {
  const { state, hostname } = ctx.data;
  const all = state.siteExceptions || [];
  const mine = all.filter((e) => hostCovered(hostname, e.hostname));
  const sec = h("details", { class: "diag-section", open: mine.length > 0 }, h("summary", {}, `Your fixes for this site (${mine.length})`));
  if (all.length === 0) {
    sec.append(h("p", { class: "hint" }, "No fixes yet. Anything you allow above shows up here, and every fix can be undone."));
    return sec;
  }
  if (mine.length > 0) {
    sec.append(h("ul", { class: "diag-list" }, mine.map((e) =>
      h("li", {}, h("div", { class: "diag-main" }, describeException(e)), h("button", { onclick: () => removeException(e.id) }, "Remove")))));
  }
  const newest = lastBatch(all);
  const actions = h("div", { class: "diag-actions" },
    h("button", { class: "secondary-btn", onclick: undoLast }, `Undo last fix (${plural(newest.length, "change")})`));
  if (mine.length > 1) {
    actions.append(h("button", { class: "secondary-btn", onclick: async () => { await send({ type: "DIAG_CLEAR_HOST", hostname }); await refresh(); } }, "Remove all fixes for this site"));
  }
  sec.append(actions);
  return sec;
}

// ---- Report -------------------------------------------------------------------------------------
function buildReport() {
  const { data, analysis } = ctx;
  const { state, hostname, session, lastResult } = data;
  const manifest = api.runtime.getManifest();
  const on = (b) => (b ? "on" : "off");
  const lines = [
    `Ad & Tracker Blocker v${manifest.version} — broken-site report`,
    `Site: ${hostname}`,
    `Browser: ${navigator.userAgent}`,
    `Exact rule matching available: ${analysis.canExact ? "yes" : "no (estimated)"}`,
    "",
    "Settings: " + ["ads", "trackers", "malware", "annoyances", "antiadblock", "custom"].map((k) => `${k}=${on(state.rulesetsEnabled[k])}`).join(", ") +
      `, referrerPrivacy=${on(state.referrerPrivacy)}, popups=${on(state.popupRedirectProtection !== false)}` +
      `, paused=${(state.pausedDomains || []).includes(hostname)}`,
  ];
  if (lastResult && lastResult.hostname === hostname) lines.push(`Guided test result: ${JSON.stringify(lastResult.result)}`);
  if (session) lines.push(`A guided test is running (features off: ${session.disabled.join(", ")})`);
  lines.push("", "Blocked requests (query strings removed):");
  if (analysis.groups.length === 0) lines.push("  none");
  for (const g of analysis.groups) {
    for (const i of g.items.slice(0, 6)) {
      lines.push(`  - ${D.sanitizeUrl(i.url)} [${i.kind}] by ${LIST_LABELS[i.ruleset] || i.ruleset} rule ${i.ruleId} "${i.urlFilter}" ${i.exact ? "(exact)" : "(likely)"} — ${g.label}`);
    }
  }
  if (analysis.notOurs) lines.push(`  (+${analysis.notOurs} other failed requests not caused by our rules)`);
  lines.push("", "Hidden by element-hiding lists:");
  if (analysis.hiddenCosmetic.length === 0) lines.push("  none");
  for (const m of analysis.hiddenCosmetic.slice(0, 10)) {
    lines.push(`  - ${m.samples[0].desc} x${m.count} via ${m.selector.slice(0, 100)}${m.interesting ? " (has text/media)" : ""}`);
  }
  for (const x of analysis.hiddenHeuristic) lines.push(`  - cleanup: ${x.count} x ${x.reason}`);
  lines.push("", `Pop-ups blocked: ${analysis.popupsBlocked}`);
  if (analysis.referrerHosts.length) lines.push(`Referrer removed on ${analysis.referrerHosts.length} requests`);
  const mine = (state.siteExceptions || []).filter((e) => hostCovered(hostname, e.hostname));
  lines.push("", `Fixes applied on this site: ${mine.length === 0 ? "none" : ""}`);
  for (const e of mine) lines.push(`  - ${describeException(e)}`);
  return lines.join("\n");
}

function renderReportSection() {
  const sec = h("details", { class: "diag-section" }, h("summary", {}, "Share a report"));
  const pre = h("pre", { id: "diagReport" }, "");
  sec.append(
    h("p", { class: "hint" }, "Web addresses are shortened (no query strings). Nothing is sent anywhere unless you choose to share it."),
    h("div", { class: "diag-actions" },
      h("button", { class: "secondary-btn", onclick: async () => {
        const text = buildReport();
        pre.textContent = text;
        try {
          await navigator.clipboard.writeText(text);
          setStatus(h("span", {}, "Report copied. Paste it wherever you like."));
        } catch {
          setStatus(h("span", {}, "Couldn't copy automatically — select the text below and copy it."));
        }
      } }, "Copy report"),
      h("button", { class: "secondary-btn", onclick: () => {
        const text = buildReport();
        pre.textContent = text;
        const body = text.length > 3500 ? text.slice(0, 3500) + "\n…(shortened — use Copy report for the rest)" : text;
        const url = `${ISSUES_URL}?title=${encodeURIComponent(`Broken site: ${ctx.data.hostname}`)}&body=${encodeURIComponent(body)}`;
        api.tabs.create({ url });
      } }, "Open a GitHub issue")
    ),
    h("p", { class: "hint" }, "“Open a GitHub issue” opens a new tab with this report filled in. It isn't posted until you press Submit there."),
    pre
  );
  return sec;
}

function render() {
  const { data, analysis } = ctx;
  document.getElementById("diagSite").textContent = data.hostname || "No page to look at";
  const main = document.getElementById("diagMain");
  main.replaceChildren();

  if (!data.hostname) {
    main.append(h("p", { class: "hint" }, "Open this on the page that's broken: go to that tab, click the extension icon, then “This site is broken?”. (It can't look at browser pages like a new tab.)"));
    return;
  }

  if (data.session) {
    main.append(renderSession(data.session));
    return;
  }

  const paused = (data.state.pausedDomains || []).includes(data.hostname);
  if (paused) {
    main.append(h("div", { class: "diag-card" }, h("p", {}, "Blocking is paused on this site, so we aren't causing it. Turn off “Pause on this site” in the main screen to test normally.")));
  }

  const result = renderResult(data.lastResult);
  if (result) main.append(result);

  const testable = D.testableFeatures(data.state);
  main.append(h("div", { class: "diag-card" },
    h("h2", {}, "Find out why"),
    h("p", {}, "Open the broken page first. The guided test switches our features off in groups, reloads the page, and asks “is it fixed?” — usually 3–6 questions — then tells you which one is responsible and offers a fix for this site only."),
    h("div", { class: "diag-actions" },
      h("button", { disabled: paused || testable.length === 0, onclick: startTest }, "Run the guided test")),
    paused ? null : testable.length === 0 ? h("p", { class: "hint" }, "Everything is already off, so there's nothing to test.") : null));

  main.append(renderRequests(analysis, data.lastResult), renderHidden(analysis), renderOther(analysis), renderFixes(), renderReportSection());
}

// ---- Boot ------------------------------------------------------------------------------------------
refresh().catch((err) => {
  document.getElementById("diagMain").replaceChildren(h("p", { class: "hint" }, `Something went wrong: ${err && err.message ? err.message : err}`));
});
