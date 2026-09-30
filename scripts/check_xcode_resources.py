#!/usr/bin/env python3
"""
Fails if the Xcode project and the extension sources have drifted apart.

Two checks, both for the quiet failure mode where the Mac build still
succeeds but ships a broken extension:

1. Every top-level entry in the extension's Resources/ folder must be
   referenced by project.pbxproj -- both as a PBXBuildFile and in the
   extension target's Resources build phase. Top-level files (unlike the
   icons/ and rules/ folder references) are NOT picked up automatically, so
   a new file added to Resources/ but not to the pbxproj is silently left
   out of the built app.
2. Every top-level file in ExtensionSource/ must be byte-identical to its
   copy in Resources/ (ExtensionSource/ is the source of truth).

Run: python3 scripts/check_xcode_resources.py   (exit 1 on any problem)
"""
import filecmp
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIR = os.path.join(ROOT, "ExtensionSource")
PROJECT_DIR = os.path.join(ROOT, "Ad Tracker Blocker")
RESOURCES_DIR = os.path.join(PROJECT_DIR, "Ad Tracker Blocker Extension", "Resources")
PBXPROJ = os.path.join(PROJECT_DIR, "Ad Tracker Blocker.xcodeproj", "project.pbxproj")


def find_problems():
    problems = []
    with open(PBXPROJ, encoding="utf-8") as f:
        pbx = f.read()

    for name in sorted(os.listdir(RESOURCES_DIR)):
        if name.startswith("."):
            continue
        token = re.escape(name)
        build_file = re.search(rf"/\* {token} in Resources \*/ = \{{isa = PBXBuildFile;", pbx)
        in_phase = re.search(rf"^\s*\w+ /\* {token} in Resources \*/,\s*$", pbx, re.M)
        if not build_file:
            problems.append(f"{name}: in Resources/ but has no PBXBuildFile entry in project.pbxproj")
        elif not in_phase:
            problems.append(f"{name}: has a PBXBuildFile but is missing from the Resources build phase")

    for name in sorted(os.listdir(SOURCE_DIR)):
        src = os.path.join(SOURCE_DIR, name)
        dst = os.path.join(RESOURCES_DIR, name)
        if not os.path.isfile(src):
            continue
        if not os.path.exists(dst):
            problems.append(f"{name}: in ExtensionSource/ but not mirrored to Resources/")
        elif not filecmp.cmp(src, dst, shallow=False):
            problems.append(f"{name}: ExtensionSource/ and Resources/ copies differ")
    return problems


def main():
    problems = find_problems()
    for p in problems:
        print(f"check_xcode_resources: {p}")
    if problems:
        return 1
    print("check_xcode_resources: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
