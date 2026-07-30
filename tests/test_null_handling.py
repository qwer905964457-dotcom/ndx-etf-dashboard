import math
import sys
import types
import unittest
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo


try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    requests_stub = types.ModuleType("requests")

    class StubSession:
        def __init__(self):
            self.headers = {}

    requests_stub.Session = StubSession
    requests_stub.Response = object
    sys.modules["requests"] = requests_stub

try:
    import bs4  # noqa: F401
except ModuleNotFoundError:
    bs4_stub = types.ModuleType("bs4")
    bs4_stub.BeautifulSoup = object
    sys.modules["bs4"] = bs4_stub

import update_data
import update_realtime


MISSING_VALUES = (None, "", " ", "-", "--", "暂无数据", "null", "None", "NaN", "N/A", False)


class RealtimeNullHandlingTests(unittest.TestCase):
    def test_missing_values_are_not_numbers(self):
        for value in MISSING_VALUES:
            with self.subTest(value=value):
                self.assertIsNone(update_realtime.parse_num(value))
                self.assertIsNone(update_realtime.parse_pct(value))
                self.assertFalse(update_realtime.valid_number(value))

    def test_missing_premium_has_no_zone(self):
        for value in MISSING_VALUES:
            with self.subTest(value=value):
                self.assertEqual(update_realtime.zone_label(value), "暂无数据")

    def test_real_zero_remains_a_valid_number(self):
        self.assertEqual(update_realtime.parse_num(0), 0)
        self.assertEqual(update_realtime.parse_pct("0%"), 0)
        self.assertTrue(update_realtime.valid_number(0))
        self.assertEqual(update_realtime.zone_label(0), "底仓区")

    def test_missing_premium_cannot_be_alertable_even_with_fresh_timestamp(self):
        now = datetime(2026, 7, 31, 10, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        status = {"date": "2026-07-31", "is_trading_session": True}
        item = {
            "price": "--",
            "iopv": None,
            "premium": "",
            "data_time": "2026-07-31 10:00:00",
            "quality": "public_page",
        }
        with patch.object(update_realtime, "now_cn", return_value=now):
            update_realtime.apply_signal_status(item, status)
        self.assertIsNone(item["price"])
        self.assertIsNone(item["iopv"])
        self.assertIsNone(item["premium"])
        self.assertFalse(item["can_alert"])
        self.assertEqual(item["status"], "暂无数据")
        self.assertEqual(item["fresh_label"], "溢价暂无数据，不提醒")


class DailyNullHandlingTests(unittest.TestCase):
    def test_missing_values_are_not_parsed_as_zero(self):
        for value in MISSING_VALUES:
            with self.subTest(value=value):
                self.assertIsNone(update_data.parse_number(value))
                self.assertIsNone(update_data.parse_percent(value))
                self.assertFalse(update_data.valid_number(value))

    def test_non_finite_values_are_rejected(self):
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                self.assertFalse(update_data.valid_number(value))
                self.assertFalse(update_realtime.valid_number(value))

    def test_invalid_existing_fund_values_are_sanitized(self):
        fund = {"premium": "--", "fee": False}
        update_data.sanitize_fund_numbers(fund)
        self.assertIsNone(fund["premium"])
        self.assertIsNone(fund["fee"])

    def test_missing_premium_cannot_receive_a_score(self):
        fund = {"premium": None, "fee": 0.6}
        update_data.refresh_score(fund)
        self.assertIsNone(fund["score"])
        self.assertEqual(fund["grade"], "数据待补")


if __name__ == "__main__":
    unittest.main()
