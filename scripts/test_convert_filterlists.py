#!/usr/bin/env python3
"""
Tests for convert_filterlists.py's pure parsing/validation functions.

These functions take plain text/data in and structured data out -- no
network, no browser, no filesystem beyond the tiny tmp files a couple of
tests use -- so they're cheap to check automatically instead of only by
eye. Run with:

    python3 scripts/test_convert_filterlists.py
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import convert_filterlists as cf


class ConvertLineTests(unittest.TestCase):
    def test_plain_domain_block(self):
        r = cf.convert_line("||ads.example.com^")
        self.assertIsNotNone(r)
        self.assertFalse(r["is_allow"])
        self.assertEqual(r["condition"]["urlFilter"], "||ads.example.com^")

    def test_allow_rule(self):
        r = cf.convert_line("@@||example.com/ads.js")
        self.assertIsNotNone(r)
        self.assertTrue(r["is_allow"])

    def test_third_party_option(self):
        r = cf.convert_line("||tracker.com^$third-party")
        self.assertEqual(r["condition"]["domainType"], "thirdParty")

    def test_domain_option_include_and_exclude(self):
        r = cf.convert_line("||ads.com^$domain=a.com|~b.com")
        self.assertEqual(r["condition"]["initiatorDomains"], ["a.com"])
        self.assertEqual(r["condition"]["excludedInitiatorDomains"], ["b.com"])

    def test_resource_type_option(self):
        r = cf.convert_line("||ads.com^$script,image")
        self.assertEqual(r["condition"]["resourceTypes"], ["image", "script"])

    def test_disqualifying_option_skips_rule(self):
        self.assertIsNone(cf.convert_line("||ads.com^$csp=default-src 'none'"))
        self.assertIsNone(cf.convert_line("||ads.com^$redirect=noop.js"))

    def test_unknown_option_skips_rule(self):
        self.assertIsNone(cf.convert_line("||ads.com^$some-future-option"))

    def test_regex_filter_skipped(self):
        self.assertIsNone(cf.convert_line("/^https?:\\/\\/ads\\./"))

    def test_cosmetic_line_not_a_network_rule(self):
        self.assertIsNone(cf.convert_line("example.com##.ad-banner"))

    def test_comment_and_blank_skipped(self):
        self.assertIsNone(cf.convert_line("! this is a comment"))
        self.assertIsNone(cf.convert_line(""))

    def test_ignored_option_all_does_not_disqualify(self):
        # Used throughout the malware/phishing lists -- must not be treated
        # as an unknown/disqualifying option.
        r = cf.convert_line("||bad-site.com^$all")
        self.assertIsNotNone(r)


class ParseCosmeticLineTests(unittest.TestCase):
    def test_generic_selector(self):
        domains, selector, is_exception = cf.parse_cosmetic_line("##.ad-banner")
        self.assertEqual(domains, [])
        self.assertEqual(selector, ".ad-banner")
        self.assertFalse(is_exception)

    def test_domain_scoped_selector(self):
        domains, selector, is_exception = cf.parse_cosmetic_line("example.com##.sidebar-ad")
        self.assertEqual(domains, ["example.com"])
        self.assertEqual(selector, ".sidebar-ad")

    def test_multi_domain_and_negated(self):
        domains, _, _ = cf.parse_cosmetic_line("a.com,~b.com##.ad")
        self.assertEqual(domains, ["a.com", "~b.com"])

    def test_exception_line(self):
        domains, selector, is_exception = cf.parse_cosmetic_line("example.com#@#.ad")
        self.assertTrue(is_exception)
        self.assertEqual(domains, ["example.com"])

    def test_extended_css_and_snippets_skipped(self):
        self.assertIsNone(cf.parse_cosmetic_line("example.com#?#.ad:has(> img)"))
        self.assertIsNone(cf.parse_cosmetic_line("example.com#$#some-snippet"))

    def test_lone_wildcard_domain_normalized_to_generic(self):
        domains, selector, _ = cf.parse_cosmetic_line("*###cookie-banner")
        self.assertEqual(domains, [])
        self.assertEqual(selector, "#cookie-banner")

    def test_wildcard_combined_with_negated_domain(self):
        # "generic, except a.com" -- the wildcard carries no extra meaning
        # once combined with a negated domain, so it should just vanish,
        # leaving the same result as "~a.com##selector" alone.
        domains, _, _ = cf.parse_cosmetic_line("~a.com,*##.cookie-notice")
        self.assertEqual(domains, ["~a.com"])

    def test_scriptlet_directive_rejected(self):
        self.assertIsNone(cf.parse_cosmetic_line("example.com##+js(acs, document.oncontextmenu)"))

    def test_procedural_pseudo_class_rejected(self):
        self.assertIsNone(cf.parse_cosmetic_line("example.com##.ad:has-text(Sponsored)"))
        self.assertIsNone(cf.parse_cosmetic_line("example.com##.ad:upward(3)"))

    def test_blank_and_comment_skipped(self):
        self.assertIsNone(cf.parse_cosmetic_line(""))
        self.assertIsNone(cf.parse_cosmetic_line("! a comment"))

    def test_non_cosmetic_line_returns_none(self):
        self.assertIsNone(cf.parse_cosmetic_line("||ads.example.com^"))


class BuildCosmeticRulesTests(unittest.TestCase):
    def test_generic_and_domain_scoped_split_correctly(self):
        lines = ["##.generic-ad", "example.com##.local-ad"]
        data, total = cf.build_cosmetic_rules(lines, max_entries=1000)
        self.assertIn(".generic-ad", data["generic"])
        self.assertEqual(data["domains"]["example.com"], [".local-ad"])
        self.assertEqual(total, 2)

    def test_exception_against_generic_selector_is_kept(self):
        # Regression test for the real bug fixed earlier this session:
        # a #@# exception only reached generic_set through a second,
        # dedicated pass -- without it, an exception targeting a GENERIC
        # selector (the common real-world case) was silently dropped.
        lines = ["##.annoying-banner", "news.example.com#@#.annoying-banner"]
        data, _ = cf.build_cosmetic_rules(lines, max_entries=1000)
        self.assertIn(".annoying-banner", data["generic"])
        self.assertIn("news.example.com", data["exceptions"])
        self.assertIn(".annoying-banner", data["exceptions"]["news.example.com"])

    def test_negated_only_domain_becomes_generic_with_exclusion(self):
        lines = ["~excluded.com##.ad"]
        data, _ = cf.build_cosmetic_rules(lines, max_entries=1000)
        self.assertIn(".ad", data["generic"])
        self.assertIn("excluded.com", data["exceptions"])
        self.assertIn(".ad", data["exceptions"]["excluded.com"])

    def test_procedural_and_scriptlet_lines_excluded_from_output(self):
        lines = [
            "##.real-selector",
            "example.com##+js(acs, foo)",
            "example.com##.ad:has-text(Sponsored)",
        ]
        data, total = cf.build_cosmetic_rules(lines, max_entries=1000)
        self.assertEqual(data["generic"], [".real-selector"])
        self.assertEqual(data["domains"], {})
        self.assertEqual(total, 1)

    def test_max_entries_budget_respected(self):
        lines = [f"##.ad-{i}" for i in range(50)]
        data, total = cf.build_cosmetic_rules(lines, max_entries=10)
        self.assertLessEqual(total, 10)


class ValidateCountTests(unittest.TestCase):
    def setUp(self):
        self._orig_output_dir = cf.OUTPUT_DIR
        self._tmpdir = tempfile.mkdtemp()
        cf.OUTPUT_DIR = self._tmpdir

    def tearDown(self):
        cf.OUTPUT_DIR = self._orig_output_dir

    def _write_existing(self, filename, entries):
        with open(os.path.join(self._tmpdir, filename), "w") as f:
            json.dump(entries, f)

    def test_below_absolute_floor_is_rejected(self):
        problems = cf.validate_count("trackers.json", 5)
        self.assertTrue(problems)
        self.assertIn("sanity floor", problems[0])

    def test_at_or_above_floor_with_no_existing_file_passes(self):
        problems = cf.validate_count("trackers.json", cf.MIN_ABSOLUTE_ENTRIES["trackers.json"])
        self.assertEqual(problems, [])

    def test_big_drop_from_existing_is_rejected_even_above_floor(self):
        self._write_existing("trackers.json", list(range(20000)))
        # Clears the absolute floor (2000) but is a >50% drop from 20000.
        problems = cf.validate_count("trackers.json", 3000)
        self.assertTrue(problems)
        self.assertIn("drop", problems[0])

    def test_similar_count_to_existing_passes(self):
        self._write_existing("trackers.json", list(range(20000)))
        problems = cf.validate_count("trackers.json", 19500)
        self.assertEqual(problems, [])

    def test_cosmetic_json_existing_count_computed_from_structure(self):
        self._write_existing("cosmetic.json", {
            "generic": ["a", "b", "c"],
            "domains": {"x.com": ["d"], "y.com": ["e", "f"]},
            "exceptions": {},
        })
        self.assertEqual(cf.existing_entry_count("cosmetic.json"), 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
