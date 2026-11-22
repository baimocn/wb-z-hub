"""Auto-detected outbound versions: parsing, downgrade guard, precedence.

The feed is the only part of the fingerprint that can change without a code
change, so the rules are pinned here: three-part app version from a four-part
build, never move backwards, a manual pin always wins, and a failed check
keeps the last good values.
"""
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import wb_identity
import wb_proxy
import wb_settings
import wb_versionfeed


class ParseTests(unittest.TestCase):
    def test_four_part_build_drops_to_app_version(self):
        self.assertEqual(wb_versionfeed.parse_version("5.9.3.42398134"),
                         ("5.9.3", "5.9.3.42398134"))
        self.assertEqual(wb_versionfeed.parse_version("v2.183.0"),
                         ("2.183.0", "2.183.0"))

    def test_garbage_is_rejected(self):
        for value in ("", "latest", "5.9", "5.9.3-rc1", None):
            self.assertIsNone(wb_versionfeed.parse_version(value))


class DowngradeGuardTests(unittest.TestCase):
    def test_older_than_builtin_is_dropped(self):
        found = {"desktop_cn": "5.0.0", "desktop_intl": "9.9.9", "cli": "2.183.0"}
        accepted = wb_versionfeed.accepted_versions(
            found, floor={"desktop_cn": "5.8.3", "desktop_intl": "5.9.4",
                          "cli": "2.168.2"})
        self.assertNotIn("desktop_cn", accepted)
        self.assertEqual(accepted["desktop_intl"], "9.9.9")
        self.assertEqual(accepted["cli"], "2.183.0")

    def test_equal_and_newer_pass(self):
        accepted = wb_versionfeed.accepted_versions(
            {"desktop_cn": "5.9.3"}, floor={"desktop_cn": "5.9.3"})
        self.assertEqual(accepted, {"desktop_cn": "5.9.3"})


class SettingsRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="version-feed-")

    def test_default_is_empty(self):
        state = wb_settings.identity_versions_auto(self.dir)
        self.assertEqual(state["versions"], {})
        self.assertEqual(state["checked_at"], 0.0)

    def test_round_trip_keeps_detail(self):
        detail = {"desktop_cn": {"build": "5.9.3.42398134",
                                 "source": "www.workbuddy.cn"}}
        wb_settings.set_identity_versions_auto(
            self.dir, {"desktop_cn": "5.9.3"}, detail=detail, checked_at=123.0)
        state = wb_settings.identity_versions_auto(self.dir)
        self.assertEqual(state["versions"], {"desktop_cn": "5.9.3"})
        self.assertEqual(state["detail"], detail)
        self.assertEqual(state["checked_at"], 123.0)


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="version-watch-")
        self.applied = []

    def watcher(self, payload):
        return wb_versionfeed.VersionWatcher(
            self.dir, apply=lambda: self.applied.append(True),
            fetcher=lambda: payload, first_delay=0)

    def test_success_persists_and_applies(self):
        watcher = self.watcher({
            "versions": {"desktop_cn": "5.9.3"},
            "detail": {"desktop_cn": {"build": "5.9.3.1", "source": "x"}},
            "errors": {},
        })
        watcher.check()
        self.assertEqual(wb_settings.identity_versions_auto(self.dir)["versions"],
                         {"desktop_cn": "5.9.3"})
        self.assertEqual(self.applied, [True])

    def test_failure_keeps_last_good_values(self):
        wb_settings.set_identity_versions_auto(
            self.dir, {"desktop_cn": "5.9.3"}, checked_at=time.time())
        watcher = self.watcher({"versions": {}, "detail": {},
                                "errors": {"desktop_cn": "HTTP 500"}})
        status = watcher.check()
        self.assertEqual(status["versions"], {"desktop_cn": "5.9.3"})
        self.assertEqual(status["last_error"], {"desktop_cn": "HTTP 500"})
        self.assertEqual(self.applied, [])


class PrecedenceTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="version-merge-")
        self.old = wb_proxy.ACCOUNTS_DIR
        wb_proxy.ACCOUNTS_DIR = self.dir
        wb_identity.configure_versions({})

    def tearDown(self):
        wb_proxy.ACCOUNTS_DIR = self.old
        wb_identity.configure_versions({})

    def test_manual_pin_beats_auto_and_clearing_falls_back(self):
        wb_settings.set_identity_versions_auto(
            self.dir, {"desktop_cn": "5.9.3"}, checked_at=time.time())
        wb_proxy.apply_identity_versions()
        self.assertEqual(wb_identity.desktop_version("cn"), "5.9.3")

        wb_settings.set_identity_versions(self.dir, {"desktop_cn": "5.8.0"})
        wb_proxy.apply_identity_versions()
        self.assertEqual(wb_identity.desktop_version("cn"), "5.8.0")

        wb_settings.set_identity_versions(self.dir, {})
        wb_proxy.apply_identity_versions()
        self.assertEqual(wb_identity.desktop_version("cn"), "5.9.3")


if __name__ == "__main__":
    unittest.main(verbosity=2)
