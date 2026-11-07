// Pure logic for the "This site is broken?" diagnoser -- no browser APIs, so
// it runs unchanged in the diagnose page AND under Node for the unit tests
// (scripts/test_diagnose_core.js).
//
// Three jobs:
//  1. A small re-implementation of declarativeNetRequest's matching, so a
//     request that failed to load can be traced back to the bundled rule
//     that (most likely) blocked it. Safari can't tell us which rule blocked
//     what; this is "likely", not "certain" -- the report says so.
//  2. Ranking those hits by how plausibly the site NEEDED the request.
//  3. The step-by-step "turn things off and ask 'is it fixed?'" search.

(function (root) {
  "use strict";

  // ---- Features the guided test can switch off ---------------------------
  const FEATURES = [
    { id: "referrer", label: "Referrer Privacy",
      what: "hides which site you came from when a page talks to other sites" },
    { id: "popups", label: "Pop-up / redirect protection",
      what: "blocks pop-ups and forced redirects the page opens on its own" },
    { id: "cleanup", label: "Page cleanup",
      what: "hides ad-looking boxes and empty slots on the page" },
    { id: "trackers", label: "Trackers list", what: "blocks known tracking requests" },
    { id: "ads", label: "Ads list", what: "blocks known ad requests" },
    { id: "antiadblock", label: "Anti-Adblock list", what: "blocks scripts that nag about ad blockers" },
    { id: "annoyances", label: "Annoyances list", what: "blocks cookie banners and similar pop-overs" },
    { id: "malware", label: "Malware / Phishing list", what: "blocks known dangerous sites" },
    { id: "custom", label: "Your custom blocking patterns", what: "blocks the patterns you added yourself" },
  ];

  function featureById(id) {
    return FEATURES.find((f) => f.id === id) || null;
  }

  // Which features are actually ON for this user (nothing to test otherwise).
  function testableFeatures(state) {
    const on = state.rulesetsEnabled || {};
    const ids = [];
    if (state.referrerPrivacy !== false) ids.push("referrer");
    if (state.popupRedirectProtection !== false) ids.push("popups");
    if (on.ads || on.trackers) ids.push("cleanup");
    for (const id of ["trackers", "ads", "antiadblock", "annoyances", "malware"]) {
      if (on[id]) ids.push(id);
    }
    if (on.custom && (state.customPatterns || []).length > 0) ids.push("custom");
    return ids;
  }

  // ---- The guided test ("bisect") -----------------------------------------
  // A session is {phase, candidates, disabled, result}. `disabled` is what is
  // switched off RIGHT NOW for the test the user is looking at.
  //   phase "all":     everything off. Fixed? -> we're involved; else "not us".
  //   phase "search":  half the candidates off. Fixed? -> culprit is in that
  //                    half; still broken -> it's in the other half.
  //   phase "confirm": only the last suspect off. Fixed? -> found it; else
  //                    more than one setting is involved.
  // Assumes ONE culprit; the confirm step is what catches the multi-cause case.

  function halfOf(list) {
    return list.slice(0, Math.ceil(list.length / 2));
  }

  function startSession(testable) {
    if (testable.length === 0) {
      return { phase: "done", candidates: [], disabled: [], result: { kind: "nothing-to-test" } };
    }
    return { phase: "all", candidates: testable.slice(), disabled: testable.slice(), result: null };
  }

  function nextStep(session, worked) {
    const s = { ...session, candidates: session.candidates.slice(), disabled: session.disabled.slice() };

    if (s.phase === "all") {
      if (!worked) return { ...s, phase: "done", disabled: [], result: { kind: "not-us" } };
      if (s.candidates.length === 1) {
        return { ...s, phase: "done", disabled: [], result: { kind: "culprit", feature: s.candidates[0] } };
      }
      return { ...s, phase: "search", disabled: halfOf(s.candidates) };
    }

    if (s.phase === "search") {
      const tested = s.disabled;
      const rest = s.candidates.filter((c) => !tested.includes(c));
      const candidates = worked ? tested : rest;
      if (candidates.length === 1) {
        // The half we just tested was exactly this one feature and it fixed
        // the site: already confirmed, no extra round needed.
        if (worked && tested.length === 1) {
          return { ...s, phase: "done", candidates, disabled: [], result: { kind: "culprit", feature: candidates[0] } };
        }
        return { ...s, phase: "confirm", candidates, disabled: candidates.slice() };
      }
      return { ...s, candidates, disabled: halfOf(candidates) };
    }

    if (s.phase === "confirm") {
      if (worked) {
        return { ...s, phase: "done", disabled: [], result: { kind: "culprit", feature: s.candidates[0] } };
      }
      return { ...s, phase: "done", disabled: [], result: { kind: "multiple" } };
    }

    return s;
  }

  // ---- Hostname helpers ------------------------------------------------------
  const TWO_PART_SUFFIXES = new Set([
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz",
    "co.za", "com.br", "com.mx", "com.cn", "com.tw", "com.hk", "com.sg", "co.in", "co.il",
    "com.tr", "com.ar",
  ]);

  // Approximation of "the part you'd register" (eTLD+1) without shipping the
  // public-suffix list: last two labels, or three for common 2-part suffixes.
  function registrableDomain(host) {
    if (!host) return "";
    const parts = host.toLowerCase().split(".");
    if (parts.length <= 2) return parts.join(".");
    const lastTwo = parts.slice(-2).join(".");
    return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
  }

  function hostMatchesDomain(host, domain) {
    return host === domain || host.endsWith("." + domain);
  }

  function hostFromUrl(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  // Strips query string and fragment (they routinely carry tokens/IDs) and
  // caps the path -- used for anything that gets displayed or copied.
  function sanitizeUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.length > 60 ? u.pathname.slice(0, 60) + "..." : u.pathname;
      return u.origin + path;
    } catch {
      return String(url).slice(0, 80);
    }
  }

  // ---- declarativeNetRequest-style matching -------------------------------
  const DNR_TYPE = {
    fetch: "xmlhttprequest", xhr: "xmlhttprequest", img: "image", script: "script",
    css: "stylesheet", media: "media", iframe: "sub_frame", font: "font", ping: "ping",
    other: "other",
  };

  // Adblock-style urlFilter -> RegExp. `*` wildcard, `^` separator (anything
  // but letter/digit/_ - . % , or the end of the URL), `||` domain anchor,
  // leading/trailing `|` start/end anchors. Case-insensitive (DNR default).
  function filterToRegex(filter) {
    let f = filter;
    let prefix = "";
    let suffix = "";
    if (f.startsWith("||")) {
      prefix = "^[a-z][a-z0-9+.\\-]*://(?:[^/?#]*\\.)?";
      f = f.slice(2);
    } else if (f.startsWith("|")) {
      prefix = "^";
      f = f.slice(1);
    }
    if (f.endsWith("|")) {
      suffix = "$";
      f = f.slice(0, -1);
    }
    let body = "";
    for (const ch of f) {
      if (ch === "*") body += ".*";
      else if (ch === "^") body += "(?:[^\\w\\-.%]|$)";
      else body += ch.replace(/[.+?${}()|[\]\\/]/g, "\\$&");
    }
    return new RegExp(prefix + body + suffix, "i");
  }

  // For "||host^..." / "||host/..." filters: the host, which lets us look
  // candidates up by hostname instead of regex-testing all ~50,000 rules.
  // A bare "||host" (no terminator) also matches host-PREFIXES, so those
  // stay in the slow generic list.
  function anchorHost(urlFilter) {
    if (!urlFilter || !urlFilter.startsWith("||")) return null;
    const m = /^([a-z0-9.\-]+)([\/^:?])/i.exec(urlFilter.slice(2));
    if (!m || m[1].endsWith(".") || !m[1].includes(".")) return null;
    return m[1].toLowerCase();
  }

  function conditionOk(c, dnrType, reqHost, initHost) {
    if (c.resourceTypes) {
      if (!c.resourceTypes.includes(dnrType)) return false;
    } else if (dnrType === "main_frame") {
      return false;
    }
    if (c.excludedResourceTypes && c.excludedResourceTypes.includes(dnrType)) return false;
    if (c.domainType) {
      const third = !!initHost && registrableDomain(initHost) !== registrableDomain(reqHost);
      if (c.domainType === "thirdParty" && !third) return false;
      if (c.domainType === "firstParty" && third) return false;
    }
    if (c.initiatorDomains) {
      if (!initHost || !c.initiatorDomains.some((d) => hostMatchesDomain(initHost, d))) return false;
    }
    if (c.excludedInitiatorDomains && initHost &&
        c.excludedInitiatorDomains.some((d) => hostMatchesDomain(initHost, d))) return false;
    if (c.requestDomains && !c.requestDomains.some((d) => hostMatchesDomain(reqHost, d))) return false;
    if (c.excludedRequestDomains &&
        c.excludedRequestDomains.some((d) => hostMatchesDomain(reqHost, d))) return false;
    return true;
  }

  // rulesets: [{name, rules: [DNR rule objects]}]
  function createMatcher(rulesets) {
    const hostIndex = new Map();
    const generic = [];
    for (const rs of rulesets) {
      for (const rule of rs.rules) {
        const entry = { ruleset: rs.name, rule, re: null };
        const key = anchorHost(rule.condition && rule.condition.urlFilter);
        if (key) {
          if (!hostIndex.has(key)) hostIndex.set(key, []);
          hostIndex.get(key).push(entry);
        } else {
          generic.push(entry);
        }
      }
    }

    function testEntry(entry, url, dnrType, reqHost, initHost) {
      const c = entry.rule.condition || {};
      if (!conditionOk(c, dnrType, reqHost, initHost)) return false;
      if (c.urlFilter) {
        if (!entry.re) {
          try {
            entry.re = filterToRegex(c.urlFilter);
          } catch {
            entry.re = false;
          }
        }
        if (!entry.re || !entry.re.test(url)) return false;
      }
      return true;
    }

    // request: {url, type (our kinds or a DNR type), initiator (hostname)}
    // -> {verdict: "block"|"allow"|null, winner, matches: [{ruleset, rule}]}
    function match(request) {
      const url = request.url;
      const reqHost = hostFromUrl(url);
      const initHost = (request.initiator || "").toLowerCase();
      const dnrType = DNR_TYPE[request.type] || request.type || "other";

      const candidates = [];
      const labels = reqHost.split(".");
      for (let i = 0; i < labels.length - 1; i++) {
        const list = hostIndex.get(labels.slice(i).join("."));
        if (list) candidates.push(...list);
      }
      candidates.push(...generic);

      const matches = [];
      for (const entry of candidates) {
        if (testEntry(entry, url, dnrType, reqHost, initHost)) {
          matches.push({ ruleset: entry.ruleset, rule: entry.rule });
        }
      }

      // DNR: highest priority wins; on a tie, allow beats block.
      let winner = null;
      for (const m of matches) {
        const t = m.rule.action && m.rule.action.type;
        if (t !== "block" && t !== "allow" && t !== "allowAllRequests") continue;
        const p = m.rule.priority || 1;
        if (!winner) {
          winner = m;
          continue;
        }
        const wp = winner.rule.priority || 1;
        const wAllow = winner.rule.action.type !== "block";
        if (p > wp || (p === wp && !wAllow && t !== "block")) winner = m;
      }
      const verdict = winner ? (winner.rule.action.type === "block" ? "block" : "allow") : null;
      return { verdict, winner, matches };
    }

    return { match };
  }

  // ---- "Did the site NEED this?" ranking ------------------------------------
  // Whole-word tokens that mark a request as telemetry/advertising. Matched
  // per alphabetic token (not substrings), so "static" or "downloads" don't
  // trip "stat" or "ads".
  const ANALYTICS_TOKENS = new Set([
    "analytics", "metric", "metrics", "telemetry", "beacon", "collect", "track", "tracking",
    "tracker", "pixel", "stats", "log", "logs", "logging", "event", "events", "ping", "unagi",
    "fls", "ad", "ads", "adserver", "doubleclick", "pagead", "gtm", "tag",
  ]);

  function looksLikeTelemetry(url) {
    let text = url;
    try {
      const u = new URL(url);
      text = u.hostname + u.pathname;
    } catch {
      // fall through with the raw string
    }
    return text.toLowerCase().split(/[^a-z]+/).some((t) => ANALYTICS_TOKENS.has(t));
  }

  // Higher = more likely the page actually depends on it. Heuristic only.
  function suspectScore(item, siteHost) {
    let score = 0;
    const sameSite = registrableDomain(hostFromUrl(item.url)) === registrableDomain(siteHost);
    if (sameSite) score += 3;
    if (["fetch", "xhr", "media", "script"].includes(item.kind)) score += 1;
    if (looksLikeTelemetry(item.url)) score -= 2;
    return score;
  }

  function suspectLabel(score) {
    if (score >= 3) return "possibly needed";
    if (score >= 1) return "unclear";
    return "probably harmless";
  }

  const api = {
    FEATURES, featureById, testableFeatures,
    startSession, nextStep,
    registrableDomain, hostMatchesDomain, hostFromUrl, sanitizeUrl,
    filterToRegex, anchorHost, createMatcher,
    suspectScore, suspectLabel,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ATBDiag = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
