import base64
import importlib.util
import json
import pathlib
import sys
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "seoul_weather_risk.py"
SPEC = importlib.util.spec_from_file_location("seoul_weather_risk", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


PLACE_ID = "seoul_admd_1120069000"
PUBLICATION_ID = "publication-1"
MAPPING_REVISION = MODULE._mapping_revision(MODULE._load_location_mapping()[1])


def context(*, zero_result_reason=None, source_population_revision=MAPPING_REVISION):
    return {
        "schema_version": "weather-risk-query-context/v1",
        "place_id": PLACE_ID,
        "requested_from_at": "2026-08-14 00:00:00",
        "requested_to_at": "2026-08-14 23:59:59",
        "available_from_at": "2026-08-14 00:00:00",
        "available_to_at": "2026-08-15 02:00:00",
        "snapshot_as_of_hour": "2026-08-14 00:00:00",
        "forecast_collected_at_min": "2026-08-14 08:00:00",
        "forecast_collected_at_max": "2026-08-14 08:05:00",
        "source_population_revision": source_population_revision,
        "publication_id": PUBLICATION_ID,
        "coverage_status": "covered",
        "freshness_state": "fresh",
        "zero_result_reason": zero_result_reason,
    }


def payload(*, rows=None, zero_result_reason=None, source_population_revision=MAPPING_REVISION, next_cursor=None):
    rows = [] if rows is None else rows
    return {
        "bundle_id": "seoul-weather-risk",
        "product_id": "weather_place_risk_window",
        "publication_id": PUBLICATION_ID,
        "row_count": len(rows),
        "limit": 100,
        "has_more": next_cursor is not None,
        "next_cursor": next_cursor,
        "rows": rows,
        "query_context": context(
            zero_result_reason=zero_result_reason,
            source_population_revision=source_population_revision,
        ),
    }


class WeatherRiskResponseContractTest(unittest.TestCase):
    def test_covered_empty_result_requires_reason(self):
        valid = payload(zero_result_reason="no_upcoming_weather_risk_candidate")
        self.assertIs(MODULE._validate_data(valid, "weather_place_risk_window", 100, PLACE_ID), valid)

        invalid = payload(zero_result_reason=None)
        with self.assertRaises(MODULE.SkillError) as raised:
            MODULE._validate_data(invalid, "weather_place_risk_window", 100, PLACE_ID)
        self.assertEqual(raised.exception.code, "response_contract_invalid")

    def test_mapping_revision_mismatch_fails_closed(self):
        response = payload(source_population_revision=f"{MODULE.LOCATION_MAPPING_VERSION}:{'f' * 64}")
        with self.assertRaises(MODULE.SkillError) as raised:
            MODULE._validate_data(response, "weather_place_risk_window", 100, PLACE_ID)
        self.assertEqual(raised.exception.code, "location_mapping_revision_mismatch")

    def test_next_cursor_must_be_v2_bound_to_publication(self):
        cursor = {
            "v": 2,
            "publication_id": PUBLICATION_ID,
            "query_fingerprint": "a" * 64,
            "forecast_at": "2026-08-14 01:00:00",
            "product_row_id": "place|2026-08-14T01:00:00+09:00",
        }
        encoded = base64.urlsafe_b64encode(json.dumps(cursor, separators=(",", ":")).encode()).decode().rstrip("=")
        response = payload(rows=[{"product_row_id": cursor["product_row_id"]}], next_cursor=encoded)
        self.assertIs(MODULE._validate_data(response, "weather_place_risk_window", 100, PLACE_ID), response)

        cursor["v"] = 1
        invalid = base64.urlsafe_b64encode(json.dumps(cursor).encode()).decode().rstrip("=")
        response = payload(rows=[{"product_row_id": "x"}], next_cursor=invalid)
        with self.assertRaises(MODULE.SkillError) as raised:
            MODULE._validate_data(response, "weather_place_risk_window", 100, PLACE_ID)
        self.assertEqual(raised.exception.code, "response_contract_invalid")

    def test_query_context_place_is_bound_to_request(self):
        response = payload()
        response["query_context"]["place_id"] = "seoul_admd_1111051500"
        with self.assertRaises(MODULE.SkillError):
            MODULE._validate_data(response, "weather_place_risk_window", 100, PLACE_ID)


if __name__ == "__main__":
    unittest.main()
