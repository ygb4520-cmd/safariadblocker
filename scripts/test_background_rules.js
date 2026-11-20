#!/usr/bin/env node
// Tests for the rules ExtensionSource/background.js creates (referrer rule
// shape, per-site exceptions, the guided-test overlay, snapshot handling,
// import validation). Runs the REAL background.js in a Node `vm` against a
// fake WebExtension API -- no browser needed:
//
//     node scripts/test_background_rules.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ATB_BACKGROUND_SRC lets a mutation check point the tests at a doctored copy.
const SOURCE = fs.readFileSync(process.env.ATB_BACKGROUND_SRC || path.join(__dirname, "..", "ExtensionSource", "background.js"), "utf8");

// ---- A fake browser to run background.js against ----------------------------
function makeEnv() {
  const store = {};
  const enabledRulesets = new Set();
  const dynamic = new Map();
  const reloads = [];
  const evt = () => {
    const l = [];
    return { addListener: (f) => l.push(f), _l: l };
  };
  const chrome = {
    runtime: {
      onMessage: evt(), onInstalled: evt(), onStartup: evt(),
      getURL: (p) => `chrome-extension://test/${p}`,
      reload: () => reloads.push("runtime.reload"),
    },
    storage: {
      local: {
        async get(keys) {
          const clone = (v) => JSON.parse(JSON.stringify(v));
          if (keys == null) return clone(store);
          if (typeof keys === "string") keys = [keys];
          const out = {};
          if (Array.isArray(keys)) {
            for (const k of keys) if (k in store) out[k] = clone(store[k]);
          } else {
            for (const [k, d] of Object.entries(keys)) out[k] = k in store ? clone(store[k]) : d;
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete store[k];
        },
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: "https://music.amazon.com/" }],
      get: async () => ({ id: 1, url: "https://music.amazon.com/" }),
      sendMessage: async () => null,
      reload: async (id) => reloads.push(id),
      onActivated: evt(), onUpdated: evt(), onRemoved: evt(),
    },
    action: { setIcon: async () => {}, setBadgeText: async () => {} },
    declarativeNetRequest: {
      async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) {
        enableRulesetIds.forEach((i) => enabledRulesets.add(i));
        disableRulesetIds.forEach((i) => enabledRulesets.delete(i));
      },
      async getDynamicRules() {
        return [...dynamic.values()];
      },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        removeRuleIds.forEach((i) => dynamic.delete(i));
        addRules.forEach((r) => dynamic.set(r.id, JSON.parse(JSON.stringify(r))));
      },
      async setExtensionActionOptions() {},
    },
  };
  const sandbox = {
    chrome, console, URL, setTimeout, clearTimeout,
    fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "background.js" });

  const send = (message) =>
    new Promise((resolve) => {
      for (const f of chrome.runtime.onMessage._l) {
        if (f(message, {}, resolve) === true) return;
      }
      resolve(undefined);
    });
  const install = async () => {
    for (const f of chrome.runtime.onInstalled._l) await f({});
  };
  return { store, enabledRulesets, dynamic, reloads, send, install };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}\n  ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  await test("after install: every static list on, referrer rule present", async () => {
    const env = makeEnv();
    await env.install();
    assert.deepStrictEqual([...env.enabledRulesets].sort(),
      ["ads", "annoyances", "antiadblock", "fmhy", "malware", "trackers"]);
    assert(env.dynamic.has(9000), "referrer rule missing");
  });

  await test("referrer rule only touches tracking-shaped third-party request types", async () => {
    const env = makeEnv();
    await env.install();
    const rule = env.dynamic.get(9000);
    assert.strictEqual(rule.action.type, "modifyHeaders");
    assert.strictEqual(rule.condition.domainType, "thirdParty");
    assert.deepStrictEqual(rule.condition.resourceTypes.slice().sort(), ["font", "image", "ping", "stylesheet"]);
    // The types the Amazon Music investigation showed must NOT lose their referrer:
    for (const needed of ["xmlhttprequest", "media", "sub_frame", "script", "websocket"]) {
      assert(!rule.condition.resourceTypes.includes(needed), `${needed} must be left alone`);
    }
  });

  await test("referrer fix excludes only that site; undo restores the plain rule", async () => {
    const env = makeEnv();
    await env.install();
    const res = await env.send({ type: "DIAG_APPLY_FIX", items: [{ kind: "referrer", hostname: "music.amazon.com" }] });
    assert.strictEqual(res.added, 1);
    assert.deepStrictEqual(env.dynamic.get(9000).condition.excludedInitiatorDomains, ["music.amazon.com"]);
    assert(env.dynamic.get(9000).condition.resourceTypes, "narrowing must survive the exception");
    const undo = await env.send({ type: "DIAG_UNDO_LAST" });
    assert.strictEqual(undo.removed, 1);
    assert.strictEqual(env.dynamic.get(9000).condition.excludedInitiatorDomains, undefined);
  });

  await test("'allow this host' becomes a priority-200 allow rule scoped to the site", async () => {
    const env = makeEnv();
    await env.install();
    await env.send({ type: "DIAG_APPLY_FIX", items: [{ kind: "url", hostname: "music.amazon.com", requestHost: "cdn.branch.io" }] });
    const rule = env.dynamic.get(10000);
    assert.strictEqual(rule.priority, 200);
    assert.strictEqual(rule.action.type, "allow");
    assert.deepStrictEqual(rule.condition, { requestDomains: ["cdn.branch.io"], initiatorDomains: ["music.amazon.com"] });
  });

  await test("duplicates are ignored; undo removes only the newest batch", async () => {
    const env = makeEnv();
    await env.install();
    await env.send({ type: "DIAG_APPLY_FIX", items: [{ kind: "popups", hostname: "a.com" }] });
    const dup = await env.send({ type: "DIAG_APPLY_FIX", items: [{ kind: "popups", hostname: "a.com" }] });
    assert.strictEqual(dup.added, 0);
    await new Promise((r) => setTimeout(r, 5)); // distinct addedAt
    await env.send({ type: "DIAG_APPLY_FIX", items: [{ kind: "cleanup", hostname: "a.com" }, { kind: "referrer", hostname: "a.com" }] });
    const undo = await env.send({ type: "DIAG_UNDO_LAST" });
    assert.strictEqual(undo.removed, 2);
    assert.deepStrictEqual(env.store.siteExceptions.map((e) => e.kind), ["popups"]);
  });

  await test("malformed fixes are rejected", async () => {
    const env = makeEnv();
    await env.install();
    const res = await env.send({ type: "DIAG_APPLY_FIX", items: [
      { kind: "evil", hostname: "a.com" },
      { kind: "url", hostname: "bad host!", requestHost: "b.com" },
      { kind: "url", hostname: "a.com" },
      { kind: "cosmetic", hostname: "a.com", selector: "x".repeat(600) },
      null, "x",
    ] });
    assert.strictEqual(res.added, 0);
    assert.strictEqual(env.dynamic.size, 1); // just the referrer rule
  });

  await test("guided test overlay switches features off without touching saved settings, then restores", async () => {
    const env = makeEnv();
    await env.install();
    const saved = JSON.stringify([env.store.rulesetsEnabled, env.store.referrerPrivacy]);
    await env.send({ type: "DIAG_SET_SESSION", session: {
      tabId: 1, hostname: "music.amazon.com", phase: "search",
      candidates: ["referrer", "trackers", "ads"], disabled: ["referrer", "trackers"],
    } });
    assert.deepStrictEqual([...env.enabledRulesets].sort(), ["ads", "annoyances", "antiadblock", "fmhy", "malware"]);
    assert(!env.dynamic.has(9000), "referrer rule should be off during the test");
    assert.strictEqual(JSON.stringify([env.store.rulesetsEnabled, env.store.referrerPrivacy]), saved, "saved settings must not change");
    assert.deepStrictEqual((await env.send({ type: "GET_STATE" })).diagnosticActive, true);
    await env.send({ type: "DIAG_END_SESSION", reload: true });
    assert.deepStrictEqual([...env.enabledRulesets].sort(), ["ads", "annoyances", "antiadblock", "fmhy", "malware", "trackers"]);
    assert(env.dynamic.has(9000), "referrer rule should be back");
    assert.strictEqual((await env.send({ type: "GET_STATE" })).diagnosticActive, false);
    assert(env.reloads.includes(1), "the tab under test is reloaded");
  });

  await test("a stale guided test is cleaned up by the next message", async () => {
    const env = makeEnv();
    await env.install();
    await env.send({ type: "DIAG_SET_SESSION", session: { tabId: 1, hostname: "a.com", phase: "all", candidates: ["trackers"], disabled: ["trackers"] } });
    assert(!env.enabledRulesets.has("trackers"));
    // Simulate the clock passing 20 minutes by aging the stored session and
    // starting a fresh worker instance on the same storage.
    env.store.diagnosticSession.startedAt = Date.now() - 20 * 60 * 1000;
    const env2 = makeEnv();
    Object.assign(env2.store, JSON.parse(JSON.stringify(env.store)));
    await env2.send({ type: "GET_STATE" });
    assert.strictEqual("diagnosticSession" in env2.store, false);
    assert(env2.enabledRulesets.has("trackers"));
  });

  await test("session input is validated", async () => {
    const env = makeEnv();
    await env.install();
    const bad = await env.send({ type: "DIAG_SET_SESSION", session: { tabId: "1", hostname: "a.com" } });
    assert.strictEqual(bad.ok, false);
    await env.send({ type: "DIAG_SET_SESSION", session: { tabId: 1, hostname: "a.com", phase: "bogus", candidates: ["trackers", "rm -rf"], disabled: ["trackers", "x"] } });
    assert.deepStrictEqual(env.store.diagnosticSession.disabled, ["trackers"]);
    assert.strictEqual(env.store.diagnosticSession.phase, "all");
  });

  await test("pre-fix snapshot is stored sanitized and the first one wins", async () => {
    const env = makeEnv();
    await env.install();
    const snap1 = { groups: [{ host: "cdn.branch.io", count: 3, lists: ["trackers", "<script>"], label: "unclear", exact: true }, { host: "bad host", count: 1 }],
      hidden: [{ selector: "#x", count: 2, interesting: true }], referrerCount: 29, popupsBlocked: 1 };
    await env.send({ type: "DIAG_APPLY_FIX", items: [{ kind: "popups", hostname: "a.com" }], snapshot: snap1, hostname: "a.com" });
    const s = env.store.diagnosticSnapshot;
    assert.strictEqual(s.hostname, "a.com");
    assert.deepStrictEqual(s.groups, [{ host: "cdn.branch.io", count: 3, lists: ["trackers"], label: "unclear", exact: true }]);
    assert.strictEqual(s.referrerCount, 29);
    // a second fix for the same site must not overwrite the picture of the original problem
    await env.send({ type: "DIAG_APPLY_FIX", items: [{ kind: "cleanup", hostname: "a.com" }], snapshot: { ...snap1, referrerCount: 0, groups: [] }, hostname: "a.com" });
    assert.strictEqual(env.store.diagnosticSnapshot.referrerCount, 29);
    const got = await env.send({ type: "DIAG_GET" });
    assert.strictEqual(got.snapshot.referrerCount, 29);
  });

  await test("importing settings validates site exceptions", async () => {
    const env = makeEnv();
    await env.install();
    const res = await env.send({ type: "IMPORT_STATE", state: { siteExceptions: [
      { kind: "url", hostname: "a.com", requestHost: "b.com" },
      { kind: "url", hostname: "a.com", requestHost: "b.com" },
      { kind: "referrer", hostname: "a.com" },
      { kind: "nope", hostname: "a.com" },
    ] } });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(env.store.siteExceptions.map((e) => e.kind), ["url", "referrer"]);
    assert(env.dynamic.has(10000));
    assert.deepStrictEqual(env.dynamic.get(9000).condition.excludedInitiatorDomains, ["a.com"]);
  });

  if (!process.exitCode) console.log(`OK (${passed} tests)`);
})();
