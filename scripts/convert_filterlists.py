#!/usr/bin/env python3
"""
Convert EasyList / EasyPrivacy (Adblock Plus filter syntax) into Safari
declarativeNetRequest (Manifest V3) static ruleset JSON files, plus a
cosmetic (element-hiding) selector map for content.js to apply at runtime.

Usage:
    python3 convert_filterlists.py
    python3 convert_filterlists.py --max-rules 25000
    python3 convert_filterlists.py --offline   # reuse previously downloaded raw lists

Network-request blocking rules (ads.json/trackers.json) come from the ##/#@#
lines are excluded there and instead parsed separately into cosmetic.json --
see build_cosmetic_rules(). Re-run this script any time you want to refresh
all three files from the latest upstream lists.
"""
import argparse
import json
import os
import re
import sys
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(SCRIPT_DIR, "raw")
OUTPUT_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "ExtensionSource", "rules"))
# xcrun safari-web-extension-converter was run with --copy-resources, which copies
# ExtensionSource files into the Xcode project rather than referencing them in place.
# Mirror freshly generated rules there too so a rebuild in Xcode picks them up.
XCODE_RESOURCES_RULES_DIR = os.path.normpath(os.path.join(
    SCRIPT_DIR, "..", "Ad Tracker Blocker", "Ad Tracker Blocker Extension", "Resources", "rules"
))
# The Chrome/Edge package is a flat unpacked folder (no build step), so mirror
# there too rather than making people remember to copy files across by hand.
WINDOWS_RULES_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "WindowsExtension", "rules"))

ADS_SOURCES = [
    ("https://easylist.to/easylist/easylist.txt", "easylist.txt"),
    # Peter Lowe's Ad and tracking server list -- long-established, actively
    # maintained (checked live: last-modified same day as of writing),
    # genuine ABP syntax. Supplementary coverage beyond EasyList alone.
    ("https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext", "peter-lowe.txt"),
]
TRACKER_SOURCES = [
    ("https://easylist.to/easylist/easyprivacy.txt", "easyprivacy.txt"),
]
# Separate category (its own toggle in the popup, its own ruleset) rather
# than folded into ads/trackers -- a malware/phishing block is a different
# kind of decision than an ad/tracker one, worth keeping independently
# switchable. Both verified live and in ABP syntax before adding.
MALWARE_SOURCES = [
    ("https://malware-filter.gitlab.io/urlhaus-filter/urlhaus-filter-ag-online.txt", "urlhaus.txt"),
    ("https://malware-filter.gitlab.io/phishing-filter/phishing-filter-ag.txt", "phishing.txt"),
]

# Options that change semantics in ways declarativeNetRequest can't safely
# replicate via a simple block/allow + urlFilter rule; if present, skip the rule.
DISQUALIFYING_OPTIONS = {
    "csp", "redirect", "redirect-rule", "removeparam", "empty", "mp4",
    "rewrite", "uritransform", "webrtc", "ping-only", "inline-script",
    "inline-font", "cname",
}

# ABP resource-type option -> DNR resourceTypes enum value
TYPE_MAP = {
    "script": "script",
    "image": "image",
    "stylesheet": "stylesheet",
    "object": "object",
    "xmlhttprequest": "xmlhttprequest",
    "xhr": "xmlhttprequest",
    "subdocument": "sub_frame",
    "document": "main_frame",
    "font": "font",
    "media": "media",
    "websocket": "websocket",
    "ping": "ping",
    "other": "other",
}

# Options we recognize but intentionally ignore (no DNR equivalent needed,
# or already implied) rather than disqualifying the whole rule. "all" (used
# throughout the malware/phishing lists) means "every resource type," which
# is DNR's default when resourceTypes is omitted anyway.
IGNORED_OPTIONS = {"popup", "important", "match-case", "badfilter", "elemhide", "generichide", "genericblock", "document", "1p", "3p", "all"}


def download(url, dest_path):
    print(f"Downloading {url} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (filterlist-converter)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    with open(dest_path, "wb") as f:
        f.write(data)
    print(f"  -> saved {len(data):,} bytes to {dest_path}")
    return dest_path


def fetch_sources(sources, offline):
    os.makedirs(RAW_DIR, exist_ok=True)
    paths = []
    for url, filename in sources:
        dest = os.path.join(RAW_DIR, filename)
        if offline:
            if not os.path.exists(dest):
                sys.exit(f"--offline given but {dest} does not exist. Run once without --offline first.")
        else:
            download(url, dest)
        paths.append(dest)
    return paths


def is_cosmetic_or_comment(line):
    if not line or line.startswith("!") or line.startswith("[Adblock"):
        return True
    # element hiding / cosmetic filter separators
    if re.search(r"#@#|#\?#|#\$#|##", line):
        return True
    return False


def parse_options(opt_str):
    """Returns (dict of DNR condition fragments, disqualified: bool)."""
    condition = {}
    included_types = []
    excluded_types = []
    for raw_tok in opt_str.split(","):
        tok = raw_tok.strip()
        if not tok:
            continue
        negated = tok.startswith("~")
        name = tok[1:] if negated else tok
        key = name.split("=", 1)[0].lower()

        if key in DISQUALIFYING_OPTIONS:
            return None, True

        if key == "third-party":
            condition["domainType"] = "firstParty" if negated else "thirdParty"
            continue

        if key == "domain":
            _, _, value = name.partition("=")
            included, excluded = [], []
            for d in value.split("|"):
                d = d.strip()
                if not d:
                    continue
                if d.startswith("~"):
                    excluded.append(d[1:])
                else:
                    included.append(d)
            if included:
                condition["initiatorDomains"] = included
            if excluded:
                condition["excludedInitiatorDomains"] = excluded
            continue

        if key in TYPE_MAP:
            (excluded_types if negated else included_types).append(TYPE_MAP[key])
            continue

        if key in IGNORED_OPTIONS:
            continue

        # Unknown option: be conservative and skip the rule rather than
        # risk mis-converting semantics we don't understand.
        return None, True

    if included_types:
        condition["resourceTypes"] = sorted(set(included_types))
    if excluded_types:
        condition["excludedResourceTypes"] = sorted(set(excluded_types))
    return condition, False


def convert_line(line):
    """Returns a dict with keys: pattern, condition, is_allow -- or None if unsupported."""
    line = line.strip()
    if is_cosmetic_or_comment(line):
        return None

    is_allow = line.startswith("@@")
    if is_allow:
        line = line[2:]

    if line.startswith("/") and line.endswith("/") and len(line) > 1:
        # Regex filter -- skip for v1 (DNR regexFilter has its own stricter
        # limits/safety checks and most EasyList regex rules are rare/edge-case).
        return None

    pattern, sep, opt_str = line.partition("$")
    pattern = pattern.strip()
    if not pattern:
        return None

    condition = {}
    if sep:
        parsed, disqualified = parse_options(opt_str)
        if disqualified:
            return None
        condition = parsed

    # Reject patterns that still contain a bare, unescaped "$" inside what
    # we assumed was the URL portion -- indicates our naive split was wrong.
    if "$" in pattern:
        return None

    condition["urlFilter"] = pattern
    return {"condition": condition, "is_allow": is_allow, "pattern": pattern}


# Order matters: "#@#" must be checked as its own token (it doesn't contain
# "##" as a substring, so there's no ambiguity), and we always take the
# earliest-occurring separator in the line as the real domain/selector split.
COSMETIC_SEPARATORS = ["#@#", "#?#", "#$#", "##"]


def parse_cosmetic_line(line):
    """Returns (domains, selector, is_exception) or None if not a (supported) cosmetic line.

    domains is a list of raw domain tokens, each optionally "~"-prefixed for
    negation, exactly as EasyList writes them (e.g. ["a.com", "~b.com"]).
    """
    line = line.strip()
    if not line or line.startswith("!"):
        return None

    best_idx, best_sep = None, None
    for sep in COSMETIC_SEPARATORS:
        idx = line.find(sep)
        if idx != -1 and (best_idx is None or idx < best_idx):
            best_idx, best_sep = idx, sep

    if best_sep is None:
        return None

    # #?# (extended CSS: :has(), :contains(), -abp-* procedural extensions)
    # and #$# (snippets, arbitrary JS) use syntax plain CSS can't express, or
    # that would mean executing arbitrary injected code -- skip both rather
    # than risk it.
    if best_sep in ("#?#", "#$#"):
        return None

    domain_part = line[:best_idx]
    selector = line[best_idx + len(best_sep):].strip()
    if not selector:
        return None

    is_exception = best_sep == "#@#"
    domains = [d.strip() for d in domain_part.split(",") if d.strip()] if domain_part else []
    return domains, selector, is_exception


def build_cosmetic_rules(lines, max_entries):
    """Aggregates ##/#@# lines into {generic, domains, exceptions} for content.js.

    - generic: selectors applied on every site.
    - domains: {domain: [selectors]} applied only when the page's hostname
      is that domain or a subdomain of it.
    - exceptions: {domain: [selectors]} -- generic selectors NOT to apply on
      that domain (from #@# unhiding, or a "##selector" whose domain list is
      entirely ~negated, which ABP treats as "generic except these sites").
    """
    generic = {}
    domain_selectors = {}
    domain_exceptions = {}
    generic_exclude_domains = {}

    for raw in lines:
        parsed = parse_cosmetic_line(raw)
        if parsed is None:
            continue
        domains, selector, is_exception = parsed

        if is_exception:
            for d in domains:
                domain_exceptions.setdefault(d.lstrip("~"), set()).add(selector)
            continue

        positive = [d for d in domains if d and not d.startswith("~")]
        negative = [d[1:] for d in domains if d.startswith("~")]

        if not domains:
            generic[selector] = True
        elif positive:
            for d in positive:
                domain_selectors.setdefault(d, set()).add(selector)
            for d in negative:
                domain_exceptions.setdefault(d, set()).add(selector)
        else:
            # Only negated domains present: applies everywhere except those.
            generic[selector] = True
            generic_exclude_domains.setdefault(selector, set()).update(negative)

    for domain, excluded in domain_exceptions.items():
        if domain in domain_selectors:
            domain_selectors[domain] -= excluded

    # Prefer shorter/simpler selectors when trimming to budget -- same
    # "broad coverage per entry" rationale as the network rule caps.
    generic_list = sorted(generic.keys(), key=len)[: max_entries // 3]
    generic_set = set(generic_list)

    domain_entries = [
        (domain, sel) for domain, sels in domain_selectors.items() for sel in sels
    ]
    domain_entries.sort(key=lambda pair: len(pair[1]))
    domain_entries = domain_entries[: max(0, max_entries - len(generic_list))]

    domains_out = {}
    for domain, sel in domain_entries:
        domains_out.setdefault(domain, []).append(sel)

    exceptions_out = {}
    for selector, excluded_domains in generic_exclude_domains.items():
        if selector in generic_set:
            for d in excluded_domains:
                exceptions_out.setdefault(d, []).append(selector)
    # #@# lines whose target is a generic selector we kept -- the common
    # case (a site-specific unhide fighting a broad, not domain-scoped,
    # hiding rule). Without this, #@# only ever had an effect when it
    # happened to match a *domain-scoped* rule for that same domain, which
    # is the rarer case -- most real EasyList #@# lines target generics.
    for domain, excluded in domain_exceptions.items():
        for sel in excluded:
            if sel in generic_set:
                exceptions_out.setdefault(domain, []).append(sel)

    total = len(generic_list) + sum(len(v) for v in domains_out.values())
    return {"generic": generic_list, "domains": domains_out, "exceptions": exceptions_out}, total


def build_rules(lines, max_rules):
    seen = set()
    allow_rules = []
    block_rules = []

    for line in lines:
        parsed = convert_line(line)
        if parsed is None:
            continue
        key = json.dumps(parsed["condition"], sort_keys=True) + str(parsed["is_allow"])
        if key in seen:
            continue
        seen.add(key)
        (allow_rules if parsed["is_allow"] else block_rules).append(parsed)

    # Prefer shorter/broader patterns when truncating to the cap -- they
    # tend to cover more of the tracking ecosystem per rule spent.
    block_rules.sort(key=lambda r: len(r["pattern"]))
    allow_rules.sort(key=lambda r: len(r["pattern"]))

    budget = max_rules
    allow_keep = allow_rules[: min(len(allow_rules), budget // 4)]  # reserve headroom for allow rules
    budget -= len(allow_keep)
    block_keep = block_rules[:budget]

    rules = []
    next_id = 1
    for r in block_keep:
        rules.append({
            "id": next_id,
            "priority": 1,
            "action": {"type": "block"},
            "condition": r["condition"],
        })
        next_id += 1
    for r in allow_keep:
        rules.append({
            "id": next_id,
            "priority": 2,
            "action": {"type": "allow"},
            "condition": r["condition"],
        })
        next_id += 1

    return rules, len(block_rules), len(allow_rules)


def load_lines(paths):
    lines = []
    for path in paths:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            lines.extend(f.readlines())
    return lines


def write_json(data, filename, count_label):
    encoded = json.dumps(data, separators=(",", ":")).encode("utf-8")
    targets = [os.path.join(OUTPUT_DIR, filename)]
    for extra_dir in (XCODE_RESOURCES_RULES_DIR, WINDOWS_RULES_DIR):
        if os.path.isdir(extra_dir):
            targets.append(os.path.join(extra_dir, filename))
    for out_path in targets:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(encoded)
        print(f"  -> wrote {count_label} to {out_path} ({len(encoded):,} bytes)")


def write_ruleset(rules, filename):
    write_json(rules, filename, f"{len(rules):,} rules")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-rules", type=int, default=20000,
                     help="Max rules for ads.json/trackers.json each (default 20000). Important: declarativeNetRequest's GUARANTEED_MINIMUM_STATIC_RULES (30000) is a COMBINED total across every enabled static ruleset, not per-ruleset -- with 3 rulesets (ads/trackers/malware) now enabled by default, raising this significantly pushes the combined total into the browser's shared 'extra' pool rather than the strictly-guaranteed one. 20000+20000+--max-malware-rules has been the tested-working combination; raise with that in mind.")
    ap.add_argument("--max-malware-rules", type=int, default=10000,
                     help="Max rules for malware.json (default 10000). Deliberately smaller than --max-rules: URLhaus/phishing-filter are current-threats-only lists (refreshed twice daily), not broad EasyList-scale coverage, so they need less budget -- and keeping this smaller helps hold the combined enabled-rule total closer to the guaranteed floor.")
    ap.add_argument("--max-cosmetic-rules", type=int, default=40000,
                     help="Max combined generic+domain-scoped cosmetic selectors (default 40000). These are just CSS selectors in a JSON file fetched once per page, not subject to DNR limits, but kept bounded to control bundle size and per-page injection cost.")
    ap.add_argument("--offline", action="store_true", help="Reuse previously downloaded raw lists instead of re-downloading.")
    args = ap.parse_args()

    print("=== Ads (EasyList) ===")
    ads_paths = fetch_sources(ADS_SOURCES, args.offline)
    ads_lines = load_lines(ads_paths)
    ads_rules, ads_blocks_total, ads_allows_total = build_rules(ads_lines, args.max_rules)
    print(f"  parsed {ads_blocks_total:,} block + {ads_allows_total:,} allow candidate rules")
    write_ruleset(ads_rules, "ads.json")

    print("=== Trackers (EasyPrivacy) ===")
    tracker_paths = fetch_sources(TRACKER_SOURCES, args.offline)
    tracker_lines = load_lines(tracker_paths)
    tracker_rules, tr_blocks_total, tr_allows_total = build_rules(tracker_lines, args.max_rules)
    print(f"  parsed {tr_blocks_total:,} block + {tr_allows_total:,} allow candidate rules")
    write_ruleset(tracker_rules, "trackers.json")

    print("=== Malware/Phishing (URLhaus + phishing-filter) ===")
    malware_paths = fetch_sources(MALWARE_SOURCES, args.offline)
    malware_lines = load_lines(malware_paths)
    malware_rules, mw_blocks_total, mw_allows_total = build_rules(malware_lines, args.max_malware_rules)
    print(f"  parsed {mw_blocks_total:,} block + {mw_allows_total:,} allow candidate rules")
    write_ruleset(malware_rules, "malware.json")

    print("=== Cosmetic (element hiding, from all lists) ===")
    cosmetic_data, cosmetic_total = build_cosmetic_rules(
        ads_lines + tracker_lines + malware_lines, args.max_cosmetic_rules
    )
    print(f"  {len(cosmetic_data['generic']):,} generic + "
          f"{cosmetic_total - len(cosmetic_data['generic']):,} domain-scoped selectors "
          f"across {len(cosmetic_data['domains']):,} domains")
    write_json(cosmetic_data, "cosmetic.json", f"{cosmetic_total:,} cosmetic selectors")

    print("\nDone. Rebuild the app in Xcode (Cmd+B / Cmd+R) so the new rules are packaged in.")


if __name__ == "__main__":
    main()
