#!/usr/bin/env python3
"""
Convert EasyList / EasyPrivacy (Adblock Plus filter syntax) into Safari
declarativeNetRequest (Manifest V3) static ruleset JSON files.

Usage:
    python3 convert_filterlists.py
    python3 convert_filterlists.py --max-rules 25000
    python3 convert_filterlists.py --offline   # reuse previously downloaded raw lists

Network-request blocking only (v1 non-goal: cosmetic/element-hiding rules,
which this script skips entirely). Re-run this script any time you want to
refresh rules/ads.json and rules/trackers.json from the latest upstream lists.
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

ADS_SOURCES = [
    ("https://easylist.to/easylist/easylist.txt", "easylist.txt"),
]
TRACKER_SOURCES = [
    ("https://easylist.to/easylist/easyprivacy.txt", "easyprivacy.txt"),
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
# or already implied) rather than disqualifying the whole rule.
IGNORED_OPTIONS = {"popup", "important", "match-case", "badfilter", "elemhide", "generichide", "genericblock", "document", "1p", "3p"}


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


def write_ruleset(rules, filename):
    encoded = json.dumps(rules, separators=(",", ":")).encode("utf-8")
    targets = [os.path.join(OUTPUT_DIR, filename)]
    if os.path.isdir(XCODE_RESOURCES_RULES_DIR):
        targets.append(os.path.join(XCODE_RESOURCES_RULES_DIR, filename))
    for out_path in targets:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(encoded)
        print(f"  -> wrote {len(rules):,} rules to {out_path} ({len(encoded):,} bytes)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-rules", type=int, default=20000,
                     help="Max rules per output ruleset (default 20000; keep comfortably under Safari's DNR limits -- verify current limits in Apple's WebExtensions docs before raising this).")
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

    print("\nDone. Rebuild the app in Xcode (Cmd+B / Cmd+R) so the new rules are packaged in.")


if __name__ == "__main__":
    main()
