import unittest

from planning_rules import cycle_day_off


class CycleDayOffTests(unittest.TestCase):
    def test_f1_anchor_cycle(self):
        self.assertEqual(cycle_day_off("2026-07-20", "F1", "2026-07-20"), "F1")
        self.assertEqual(cycle_day_off("2026-07-20", "F1", "2026-07-27"), "F2")
        self.assertEqual(cycle_day_off("2026-07-20", "F1", "2026-07-28"), "F2")
        self.assertIsNone(cycle_day_off("2026-07-20", "F1", "2026-07-21"))

    def test_f2_anchor_cycle(self):
        self.assertEqual(cycle_day_off("2026-07-20", "F2", "2026-07-20"), "F2")
        self.assertEqual(cycle_day_off("2026-07-20", "F2", "2026-07-21"), "F2")
        self.assertEqual(cycle_day_off("2026-07-20", "F2", "2026-07-28"), "F1")


if __name__ == "__main__":
    unittest.main()
