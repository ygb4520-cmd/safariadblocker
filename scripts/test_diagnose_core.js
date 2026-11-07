#!/usr/bin/env node
// Tests for ExtensionSource/diagnose-core.js (rule matching, ranking, and the
// guided-test state machine). Plain Node, no dependencies:
//
//     node scripts/test_diagnose_core.js
//
// The matcher tests run against the REAL bundled rules, so they also catch
// the matcher drifting away from how those rules are actually written.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const core = require("../ExtensionSource/diagnose-core.js");

const RULES_DIR = path.join(__dirname, "..", "ExtensionSource", "rules");
const loadRules = (name) => JSON.parse(fs.readFileSync(path.join(RULES_DIR, name + ".json"), "utf8"));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

// ---- filter -> regex ---------------------------------------------------------
test("domain anchor + separator", () => {
  const re = core.filterToRegex("||ads.example.com^");
  assert(re.test("https://ads.example.com/x.js"));
  assert(re.test("https://sub.ads.example.com/"));
  assert(re.test("https://ads.example.com"));
  assert(!re.test("https://ads.example.com.evil.net/"));
  assert(!re.test("https://notads.example.com/"));
});

test("wildcards, start/end anchors, case-insensitivity", () => {
  assert(core.filterToRegex("/banner/*/img").test("https://x.com/banner/300/img"));
  assert(core.filterToRegex("|https://x.com/a|").test("https://x.com/a"));
  assert(!core.filterToRegex("|https://x.com/a|").test("https://x.com/a/b"));
  assert(core.filterToRegex("/AdFrame.").test("https://x.com/adframe.html"));
});

test("anchorHost only indexes hosts that end at a terminator", () => {
  assert.strictEqual(core.anchorHost("||doubleclick.net^"), "doubleclick.net");
  assert.strictEqual(core.anchorHost("||x.com/path"), "x.com");
  assert.strictEqual(core.anchorHost("||ads."), null);
  assert.strictEqual(core.anchorHost("||example.com"), null); // prefix-matching form
  assert.strictEqual(core.anchorHost("/banner/"), null);
});

// ---- registrable domain --------------------------------------------------------
test("registrableDomain", () => {
  assert.strictEqual(core.registrableDomain("music.amazon.com"), "amazon.com");
  assert.strictEqual(core.registrableDomain("a.b.example.co.uk"), "example.co.uk");
  assert.strictEqual(core.registrableDomain("localhost"), "localhost");
});

test("sanitizeUrl drops query and fragment", () => {
  assert.strictEqual(core.sanitizeUrl("https://a.com/p/q?token=SECRET#frag"), "https://a.com/p/q");
});

// ---- matching against synthetic rules --------------------------------------------
function tiny(rules) {
  return core.createMatcher([{ name: "t", rules }]);
}

test("block rule matches, resource type honoured", () => {
  const m = tiny([{ id: 1, priority: 1, action: { type: "block" },
    condition: { urlFilter: "||t.example.com^", resourceTypes: ["script"] } }]);
  assert.strictEqual(m.match({ url: "https://t.example.com/a.js", type: "script", initiator: "x.com" }).verdict, "block");
  assert.strictEqual(m.match({ url: "https://t.example.com/a.png", type: "img", initiator: "x.com" }).verdict, null);
});

test("thirdParty / initiatorDomains conditions", () => {
  const m = tiny([
    { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "||cdn.example.com^", domainType: "thirdParty" } },
    { id: 2, priority: 1, action: { type: "block" }, condition: { urlFilter: "||only.example.com^", initiatorDomains: ["a.com"] } },
  ]);
  assert.strictEqual(m.match({ url: "https://cdn.example.com/x", type: "script", initiator: "other.com" }).verdict, "block");
  assert.strictEqual(m.match({ url: "https://cdn.example.com/x", type: "script", initiator: "www.example.com" }).verdict, null);
  assert.strictEqual(m.match({ url: "https://only.example.com/x", type: "img", initiator: "sub.a.com" }).verdict, "block");
  assert.strictEqual(m.match({ url: "https://only.example.com/x", type: "img", initiator: "b.com" }).verdict, null);
});

test("higher priority allow beats block; tie -> allow", () => {
  const m = tiny([
    { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "||ads.example.com^" } },
    { id: 2, priority: 2, action: { type: "allow" }, condition: { urlFilter: "||ads.example.com/ok^" } },
    { id: 3, priority: 1, action: { type: "allow" }, condition: { urlFilter: "||ads.example.com/tie^" } },
  ]);
  assert.strictEqual(m.match({ url: "https://ads.example.com/ok/x", type: "script", initiator: "x.com" }).verdict, "allow");
  assert.strictEqual(m.match({ url: "https://ads.example.com/tie/x", type: "script", initiator: "x.com" }).verdict, "allow");
  assert.strictEqual(m.match({ url: "https://ads.example.com/other", type: "script", initiator: "x.com" }).verdict, "block");
});

test("rules without a urlFilter (e.g. pause rules) still match on conditions", () => {
  const m = tiny([{ id: 1, priority: 100, action: { type: "allow" }, condition: { initiatorDomains: ["site.com"] } },
    { id: 2, priority: 1, action: { type: "block" }, condition: { urlFilter: "||ads.example.com^" } }]);
  assert.strictEqual(m.match({ url: "https://ads.example.com/x", type: "script", initiator: "www.site.com" }).verdict, "allow");
});

// ---- matching against the REAL bundled rules --------------------------------------
const real = core.createMatcher(["ads", "trackers", "malware", "annoyances", "antiadblock"]
  .map((name) => ({ name, rules: loadRules(name) })));

test("real rules: a classic ad server is blocked", () => {
  const r = real.match({ url: "https://securepubads.g.doubleclick.net/tag/js/gpt.js", type: "script", initiator: "news.example.com" });
  assert.strictEqual(r.verdict, "block");
});

test("real rules: Amazon telemetry is NOT blocked -- a priority-2 allow rule outranks the tracker blocks", () => {
  // Regression test for the Amazon Music investigation: the tracker rules for
  // fls-na.amazon.com / unagi.amazon.* exist, but EasyList's `@@||amazon.com^`
  // exception (priority 2) beats them, so they are not what stalls the player.
  const r = real.match({ url: "https://fls-na.amazon.com/1/batch/1/OE/", type: "xhr", initiator: "music.amazon.com" });
  assert.strictEqual(r.verdict, "allow");
  assert.strictEqual(r.winner.ruleset, "ads");
  assert(r.matches.some((m) => m.ruleset === "trackers" && m.rule.action.type === "block"),
    "the overridden tracker block should still be listed among the matches");
  const u = real.match({ url: "https://unagi-na.amazon.com/1/events/com.amazon.csm.csa.prod", type: "fetch", initiator: "music.amazon.com" });
  assert.strictEqual(u.verdict, "allow");
});

test("real rules: a well-known third-party tracker IS blocked and attributed", () => {
  const r = real.match({ url: "https://www.google-analytics.com/collect?v=1", type: "img", initiator: "news.example.com" });
  assert.strictEqual(r.verdict, "block");
  assert(["trackers", "ads"].includes(r.winner.ruleset));
});

test("real rules: an ordinary CDN image is NOT blocked", () => {
  const r = real.match({
    url: "https://img.mlbstatic.com/mlb-images/image/upload/w_240,h_382,g_auto,c_fill,q_auto:best/mlb/rmxupw7aufawhdy21fey",
    type: "img", initiator: "www.mlb.com",
  });
  assert.strictEqual(r.verdict, null);
});

test("real rules: the matcher is fast enough to run on a page full of requests", () => {
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) {
    real.match({ url: `https://cdn${i}.example.org/assets/app-${i}.js`, type: "script", initiator: "www.example.com" });
  }
  assert(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
});

// ---- ranking -----------------------------------------------------------------------
test("same-company non-telemetry outranks third-party telemetry", () => {
  const a = core.suspectScore({ url: "https://api.amazon.com/v1/playback", kind: "fetch" }, "music.amazon.com");
  const b = core.suspectScore({ url: "https://tracker.example.net/collect", kind: "img" }, "music.amazon.com");
  assert(a > b);
  assert.strictEqual(core.suspectLabel(a), "possibly needed");
  assert.strictEqual(core.suspectLabel(b), "probably harmless");
});

test("'static' and 'downloads' are not mistaken for telemetry", () => {
  const s = core.suspectScore({ url: "https://static.other.com/downloads/app.js", kind: "script" }, "site.com");
  assert(s >= 1, `score ${s}`);
});

// ---- testable features ---------------------------------------------------------------
test("testableFeatures only lists what is switched on", () => {
  const all = core.testableFeatures({
    rulesetsEnabled: { ads: true, trackers: true, malware: true, annoyances: true, antiadblock: true, custom: true },
    customPatterns: ["x.com"], referrerPrivacy: true, popupRedirectProtection: true,
  });
  assert.deepStrictEqual(all.sort(), ["ads", "annoyances", "antiadblock", "cleanup", "custom", "malware", "popups", "referrer", "trackers"]);
  const few = core.testableFeatures({
    rulesetsEnabled: { ads: false, trackers: false, malware: true, annoyances: false, antiadblock: false, custom: true },
    customPatterns: [], referrerPrivacy: false, popupRedirectProtection: true,
  });
  assert.deepStrictEqual(few.sort(), ["malware", "popups"]);
});

// ---- the guided test -------------------------------------------------------------------
// Simulates a user whose site is fixed exactly when ALL of `culprits` are off.
function runGuidedTest(testable, culprits) {
  let s = core.startSession(testable);
  let rounds = 0;
  while (s.phase !== "done") {
    rounds++;
    assert(rounds < 20, "did not terminate");
    const worked = culprits.every((c) => s.disabled.includes(c));
    s = core.nextStep(s, worked);
  }
  return { result: s.result, rounds };
}

const NINE = ["referrer", "popups", "cleanup", "trackers", "ads", "antiadblock", "annoyances", "malware", "custom"];

test("guided test finds every single culprit", () => {
  for (const culprit of NINE) {
    const { result, rounds } = runGuidedTest(NINE, [culprit]);
    assert.deepStrictEqual(result, { kind: "culprit", feature: culprit }, culprit);
    assert(rounds <= 7, `${culprit} took ${rounds} rounds`);
  }
});

test("guided test says 'not us' when turning everything off changes nothing", () => {
  const { result, rounds } = runGuidedTest(NINE, ["something-else"]);
  assert.deepStrictEqual(result, { kind: "not-us" });
  assert.strictEqual(rounds, 1);
});

test("guided test reports 'multiple' when two settings are both needed", () => {
  const { result } = runGuidedTest(NINE, ["referrer", "trackers"]);
  assert.strictEqual(result.kind, "multiple");
});

test("guided test with one feature, and with none", () => {
  assert.deepStrictEqual(runGuidedTest(["referrer"], ["referrer"]).result, { kind: "culprit", feature: "referrer" });
  assert.deepStrictEqual(core.startSession([]).result, { kind: "nothing-to-test" });
});

test("nextStep never mutates the session it was given", () => {
  const s = core.startSession(NINE);
  const copy = JSON.stringify(s);
  core.nextStep(s, true);
  assert.strictEqual(JSON.stringify(s), copy);
});

if (!process.exitCode) console.log(`OK (${passed} tests)`);
