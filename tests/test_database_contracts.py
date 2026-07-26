import unittest

from database import Database


class SummaryCursor:
    def __init__(self):
        self.executed = []

    def execute(self, query):
        self.executed.append(query)

    def fetchall(self):
        return [{
            "id": "week-1", "name": "Semana 1", "start_date": __import__("datetime").date(2026, 7, 20),
            "end_date": __import__("datetime").date(2026, 7, 26), "status": "published",
            "version": 3, "published_at": None, "assignment_count": 4, "position_count": 8,
        }]


class DatabaseContractTests(unittest.TestCase):
    def test_week_summaries_reuse_provided_cursor(self):
        cursor = SummaryCursor()
        database = object.__new__(Database)
        summaries = database._week_summaries(cursor, {"role": "staff"})
        self.assertEqual(summaries[0]["assignmentCount"], 4)
        self.assertEqual(summaries[0]["positionCount"], 8)
        self.assertEqual(len(cursor.executed), 1)
        self.assertIn("status='published'", cursor.executed[0])


if __name__ == "__main__":
    unittest.main()
