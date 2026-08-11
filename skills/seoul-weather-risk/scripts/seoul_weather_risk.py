#!/usr/bin/env python3
"""Read-only HTTPS client for the ASK Seoul seoul-weather-risk skill API."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import unicodedata
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


SKILL_BUNDLE_ID = "seoul-weather-risk"
PROXY_BASE_URL_ENV = "KSKILL_PROXY_BASE_URL"
DEFAULT_PROXY_BASE_URL = "https://k-skill-proxy.nomadamas.org"
LOCAL_DIRECT_ENV = "KSKILL_LOCAL_DIRECT"
SKILL_API_BASE_URL_ENV = "ASK_SEOUL_SKILL_API_BASE_URL"
MARKETPLACE_API_KEY_ENV = "MARKETPLACE_API_KEY"
PROXY_DISABLED_VALUES = frozenset({"off", "false", "0", "disable", "disabled", "none"})
LOCAL_DIRECT_ENABLED_VALUES = frozenset({"1", "true", "on", "yes"})
LOCAL_DIRECT_DOTENV_NAMES = frozenset({
    LOCAL_DIRECT_ENV,
    SKILL_API_BASE_URL_ENV,
    MARKETPLACE_API_KEY_ENV,
})
PROXY_ROUTE_ROOT = "/v1/ask-seoul/weather-risk"
LOCATION_MAPPING_PATH = pathlib.Path(__file__).resolve().parents[1] / "references" / "admin-dong-place-map.json"
LOCATION_MAPPING_VERSION = "kma_admin_dong_grid_20260325"
LOCATION_MAPPING_SIZE = 427
EXACT_PRODUCT_IDS = frozenset({
    "weather_place_risk_window",
})
STATUS_CODES = {
    401: "unauthorized",
    403: "forbidden",
    404: "unknown_product",
    409: "cursor_expired",
    429: "rate_limited",
    503: "product_not_ready",
}


class SkillError(RuntimeError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class _NoRedirect(HTTPRedirectHandler):
    """Do not silently move a read request to an unreviewed proxy origin."""

    def redirect_request(self, _req: Request, _fp: Any, _code: int, _msg: str, _headers: Any, _newurl: str) -> None:
        return None


@dataclass(frozen=True)
class ApiConfig:
    base_url: str
    mode: str = "hosted_proxy"
    bearer_token: str | None = None


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _local_direct_config(values: dict[str, str]) -> ApiConfig:
    base_url = values.get(SKILL_API_BASE_URL_ENV, "").strip()
    bearer_token = values.get(MARKETPLACE_API_KEY_ENV, "").strip()
    if not base_url or base_url == "replace-me":
        raise SkillError("local_direct_not_configured", "local direct API base URL이 필요합니다.")
    if not bearer_token or bearer_token == "replace-me":
        raise SkillError("local_direct_not_configured", "local direct Marketplace API key가 필요합니다.")

    parsed = urlparse(base_url)
    local_http = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if (parsed.scheme != "https" and not local_http) or not parsed.netloc or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise SkillError("invalid_local_direct_base_url", "local direct API base URL은 HTTPS origin이어야 합니다.")
    if parsed.username or parsed.password:
        raise SkillError("invalid_local_direct_base_url", "local direct API base URL에 사용자 정보는 포함할 수 없습니다.")
    return ApiConfig(base_url=base_url.rstrip("/"), mode="local_direct", bearer_token=bearer_token)


def _current_directory_dotenv() -> dict[str, str]:
    path = pathlib.Path.cwd() / ".env"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}

    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        name = name.strip()
        if name in LOCAL_DIRECT_DOTENV_NAMES:
            values[name] = value.strip().strip('"').strip("'")
    return values


def _api_config(environ: dict[str, str] | None = None) -> ApiConfig:
    values = ({**_current_directory_dotenv(), **os.environ} if environ is None else environ)
    if values.get(LOCAL_DIRECT_ENV, "").strip().casefold() in LOCAL_DIRECT_ENABLED_VALUES:
        return _local_direct_config(values)
    configured = values.get(PROXY_BASE_URL_ENV, "").strip()
    if configured.casefold() in PROXY_DISABLED_VALUES:
        raise SkillError("proxy_disabled", f"{PROXY_BASE_URL_ENV}가 비활성화되어 있습니다.")
    base_url = (configured if configured and configured != "replace-me" else DEFAULT_PROXY_BASE_URL).rstrip("/")

    parsed = urlparse(base_url)
    local_http = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if (parsed.scheme != "https" and not local_http) or not parsed.netloc or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise SkillError("invalid_proxy_base_url", "k-skill proxy base URL은 HTTPS origin이어야 합니다.")
    if parsed.username or parsed.password:
        raise SkillError("invalid_proxy_base_url", "k-skill proxy base URL에 사용자 정보는 포함할 수 없습니다.")
    return ApiConfig(base_url=base_url)


def _error_payload(raw: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _problem_error(status: int, raw: bytes, headers: Any) -> SkillError:
    problem = _error_payload(raw)
    code = problem.get("code") if isinstance(problem.get("code"), str) else STATUS_CODES.get(status, "api_error")
    message = problem.get("detail") if isinstance(problem.get("detail"), str) else problem.get("title")
    if not isinstance(message, str) or not message:
        message = f"ASK Seoul API가 HTTP {status} 응답을 반환했습니다."
    details = {"status": status}
    for name in ("type", "title", "product_id", "blockers", "request_id"):
        if name in problem:
            details[name] = problem[name]
    retry_after = headers.get("Retry-After") if headers else None
    if retry_after:
        details["retry_after"] = retry_after
    return SkillError(code, message, details)


def _request_json(config: ApiConfig, path: str, query: dict[str, str] | None = None) -> dict[str, Any]:
    url = f"{config.base_url}{path}"
    if query:
        url = f"{url}?{urlencode(query)}"
    headers = {
        "Accept": "application/json",
        "User-Agent": "k-skill-seoul-weather-risk/1",
    }
    if config.bearer_token:
        headers["Authorization"] = f"Bearer {config.bearer_token}"
    request = Request(url, headers=headers)
    try:
        with build_opener(_NoRedirect).open(request, timeout=15) as response:
            raw = response.read()
            content_type = response.headers.get_content_type()
            request_id = response.headers.get("X-Request-Id")
    except HTTPError as exc:
        # HTTPError is also a file object. Close it after reading so repeated
        # typed failures do not leak a response handle into the caller's stderr.
        raw = exc.read()
        try:
            error = _problem_error(exc.code, raw, exc.headers)
        finally:
            exc.close()
        raise error from exc
    except URLError as exc:
        raise SkillError("network_error", "ASK Seoul API에 연결할 수 없습니다.") from exc

    if content_type != "application/json":
        raise SkillError("malformed_response", "ASK Seoul API 성공 응답의 Content-Type이 JSON이 아닙니다.")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SkillError("malformed_response", "ASK Seoul API 성공 응답이 JSON 객체가 아닙니다.") from exc
    if not isinstance(payload, dict):
        raise SkillError("malformed_response", "ASK Seoul API 성공 응답이 JSON 객체가 아닙니다.")
    if request_id:
        payload["request_id"] = request_id
    return payload


def _contract_error(message: str) -> SkillError:
    return SkillError("response_contract_invalid", message)


def _require(value: dict[str, Any], name: str, expected: type | tuple[type, ...]) -> Any:
    item = value.get(name)
    if not isinstance(item, expected):
        raise _contract_error(f"ASK Seoul API 응답의 {name} 계약이 올바르지 않습니다.")
    return item


def _validate_bundle(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("bundle_id") != SKILL_BUNDLE_ID:
        raise _contract_error("ASK Seoul API 응답의 bundle_id가 일치하지 않습니다.")
    _require(payload, "registration_ready", bool)
    products = _require(payload, "products", list)
    ids: list[str] = []
    for product in products:
        if not isinstance(product, dict):
            raise _contract_error("ASK Seoul API bundle의 product 항목이 객체가 아닙니다.")
        product_id = _require(product, "product_id", str)
        _require(product, "registration_ready", bool)
        blockers = _require(product, "blockers", list)
        if not all(isinstance(blocker, str) for blocker in blockers):
            raise _contract_error("ASK Seoul API bundle의 blockers 계약이 올바르지 않습니다.")
        publication_id = product.get("publication_id")
        if publication_id is not None and not isinstance(publication_id, str):
            raise _contract_error("ASK Seoul API bundle의 publication_id 계약이 올바르지 않습니다.")
        ids.append(product_id)
    if set(ids) != EXACT_PRODUCT_IDS or len(ids) != len(EXACT_PRODUCT_IDS):
        raise _contract_error("ASK Seoul API bundle의 제품 목록이 이 스킬의 단일 제품과 다릅니다.")
    return payload


def _validate_product(payload: dict[str, Any], product_id: str) -> dict[str, Any]:
    if payload.get("bundle_id") != SKILL_BUNDLE_ID or payload.get("product_id") != product_id:
        raise _contract_error("ASK Seoul API product 응답의 bundle_id 또는 product_id가 일치하지 않습니다.")
    _require(payload, "registration_ready", bool)
    blockers = _require(payload, "blockers", list)
    if not all(isinstance(blocker, str) for blocker in blockers):
        raise _contract_error("ASK Seoul API product 응답의 blockers 계약이 올바르지 않습니다.")
    publication_id = payload.get("publication_id")
    if publication_id is not None and not isinstance(publication_id, str):
        raise _contract_error("ASK Seoul API product 응답의 publication_id 계약이 올바르지 않습니다.")
    metadata = _require(payload, "metadata", dict)
    columns = metadata.get("columns", [])
    if not isinstance(columns, list) or any(not isinstance(column, dict) or not isinstance(column.get("name"), str) for column in columns):
        raise _contract_error("ASK Seoul API product metadata.columns 계약이 올바르지 않습니다.")
    return payload


def _validate_data(payload: dict[str, Any], product_id: str, requested_limit: int) -> dict[str, Any]:
    if payload.get("bundle_id") != SKILL_BUNDLE_ID or payload.get("product_id") != product_id:
        raise _contract_error("ASK Seoul API data 응답의 bundle_id 또는 product_id가 일치하지 않습니다.")
    publication_id = _require(payload, "publication_id", str)
    if not publication_id:
        raise _contract_error("ASK Seoul API data 응답의 publication_id가 비어 있습니다.")
    row_count = _require(payload, "row_count", int)
    limit = _require(payload, "limit", int)
    has_more = _require(payload, "has_more", bool)
    rows = _require(payload, "rows", list)
    next_cursor = payload.get("next_cursor")
    if row_count < 0 or row_count != len(rows) or limit != requested_limit or not 1 <= limit <= 500:
        raise _contract_error("ASK Seoul API data page의 row_count 또는 limit 계약이 올바르지 않습니다.")
    if next_cursor is not None and not isinstance(next_cursor, str):
        raise _contract_error("ASK Seoul API data page의 next_cursor 계약이 올바르지 않습니다.")
    if has_more != (next_cursor is not None):
        raise _contract_error("ASK Seoul API data page의 has_more와 next_cursor가 일치하지 않습니다.")
    if not all(isinstance(row, dict) for row in rows):
        raise _contract_error("ASK Seoul API data page의 rows 계약이 올바르지 않습니다.")
    return payload


def _filters(values: list[str]) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise SkillError("invalid_filter", "필터는 column=value 형식이어야 합니다.")
        name, expected = value.split("=", 1)
        name = name.strip()
        if not name or name in parsed:
            raise SkillError("invalid_filter", "필터 이름은 비어 있거나 중복될 수 없습니다.")
        parsed[name] = expected
    return parsed


def _time_bound(value: str, edge: str) -> str:
    if (
        len(value) == len("YYYY-MM-DD")
        and value[4] == "-"
        and value[7] == "-"
        and value[:4].isdigit()
        and value[5:7].isdigit()
        and value[8:10].isdigit()
    ):
        suffix = "00:00:00" if edge == "from" else "23:59:59"
        return f"{value} {suffix}"
    return value


def _normalize_location_name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).strip().split())


def _location_mapping_error(message: str) -> SkillError:
    return SkillError("location_mapping_invalid", message)


def _load_location_mapping(path: pathlib.Path = LOCATION_MAPPING_PATH) -> tuple[str, list[dict[str, str]]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _location_mapping_error("행정동 매핑 reference를 읽을 수 없습니다.") from exc

    if not isinstance(payload, dict) or payload.get("mapping_version") != LOCATION_MAPPING_VERSION:
        raise _location_mapping_error("행정동 매핑 버전이 지원 계약과 다릅니다.")
    if not isinstance(payload.get("source"), str) or not payload["source"]:
        raise _location_mapping_error("행정동 매핑의 source가 올바르지 않습니다.")
    if not isinstance(payload.get("generated_at"), str) or not payload["generated_at"]:
        raise _location_mapping_error("행정동 매핑의 generated_at이 올바르지 않습니다.")

    locations = payload.get("locations")
    if not isinstance(locations, list) or len(locations) != LOCATION_MAPPING_SIZE:
        raise _location_mapping_error("행정동 매핑 행 수가 지원 계약과 다릅니다.")

    normalized: list[dict[str, str]] = []
    place_ids: set[str] = set()
    location_keys: set[tuple[str, str]] = set()
    for row in locations:
        if not isinstance(row, dict) or set(row) != {"admin_dong", "gu", "place_id"}:
            raise _location_mapping_error("행정동 매핑 행의 필드 계약이 올바르지 않습니다.")
        if not all(isinstance(row[name], str) and row[name].strip() for name in ("admin_dong", "gu", "place_id")):
            raise _location_mapping_error("행정동 매핑 행에 비어 있거나 문자열이 아닌 값이 있습니다.")

        admin_dong = _normalize_location_name(row["admin_dong"])
        gu = _normalize_location_name(row["gu"])
        place_id = row["place_id"].strip()
        if not place_id.startswith("seoul_admd_") or len(place_id) != len("seoul_admd_") + 10 or not place_id.removeprefix("seoul_admd_").isdigit():
            raise _location_mapping_error("행정동 매핑의 place_id 형식이 올바르지 않습니다.")
        if place_id in place_ids or (admin_dong, gu) in location_keys:
            raise _location_mapping_error("행정동 매핑에 중복된 place_id 또는 행정동·자치구가 있습니다.")

        place_ids.add(place_id)
        location_keys.add((admin_dong, gu))
        normalized.append({"admin_dong": admin_dong, "gu": gu, "place_id": place_id})

    return payload["mapping_version"], normalized


def _alias_keys(canonical: str) -> set[str]:
    compact = re.sub(r"\s+", "", canonical)
    without_je = re.sub(r"제(?=\d)", "", compact)
    return {
        compact,
        without_je,
        compact.replace(".", "·"),
        compact.replace(".", ""),
        without_je.replace(".", "·"),
        without_je.replace(".", ""),
    }


def _location_indexes(locations: list[dict[str, str]]) -> tuple[dict[str, list[dict[str, str]]], dict[str, list[dict[str, str]]]]:
    canonical_index: dict[str, list[dict[str, str]]] = {}
    alias_index: dict[str, list[dict[str, str]]] = {}
    for row in locations:
        canonical_index.setdefault(row["admin_dong"], []).append(row)
        for alias in _alias_keys(row["admin_dong"]):
            alias_index.setdefault(alias, []).append(row)
    return canonical_index, alias_index


def _resolve_admin_dong(admin_dong: str, gu: str | None = None) -> dict[str, str]:
    normalized_dong = _normalize_location_name(admin_dong)
    normalized_gu = _normalize_location_name(gu) if gu is not None else None
    _version, locations = _load_location_mapping()

    canonical_index, alias_index = _location_indexes(locations)
    candidates = canonical_index.get(normalized_dong)
    if candidates is None:
        candidates = alias_index.get(re.sub(r"\s+", "", normalized_dong))
    if not candidates:
        raise SkillError("unknown_admin_dong", f"지원하는 서울 행정동이 아닙니다: {normalized_dong}")

    candidates = list(candidates)

    if normalized_gu is not None:
        known_gus = {row["gu"] for row in locations}
        if normalized_gu not in known_gus:
            raise SkillError("unknown_gu", f"지원하는 서울 자치구가 아닙니다: {normalized_gu}")
        candidates = [row for row in candidates if row["gu"] == normalized_gu]
        if not candidates:
            raise SkillError("unknown_admin_dong", f"{normalized_gu}의 지원 행정동이 아닙니다: {normalized_dong}")

    candidates.sort(key=lambda item: (item["gu"], item["place_id"]))
    if len(candidates) > 1:
        raise SkillError(
            "ambiguous_admin_dong",
            "동명이므로 자치구를 함께 입력해야 합니다.",
            {"candidates": candidates},
        )
    return candidates[0]


def _validate_product_id(product_id: str) -> None:
    if product_id not in EXACT_PRODUCT_IDS:
        raise SkillError("unknown_product", f"지원하지 않는 product_id입니다: {product_id}")


def _bundle(config: ApiConfig) -> dict[str, Any]:
    if config.mode == "local_direct":
        return _validate_bundle(_request_json(config, f"/skill/v1/bundles/{SKILL_BUNDLE_ID}"))
    return _validate_bundle(_request_json(config, f"{PROXY_ROUTE_ROOT}/bundle"))


def _detail(config: ApiConfig, product_id: str) -> dict[str, Any]:
    _validate_product_id(product_id)
    if config.mode == "local_direct":
        return _validate_product(_request_json(config, f"/skill/v1/products/{product_id}"), product_id)
    return _validate_product(_request_json(config, f"{PROXY_ROUTE_ROOT}/product"), product_id)


def _data(config: ApiConfig, product_id: str, query: dict[str, str], limit: int) -> dict[str, Any]:
    _validate_product_id(product_id)
    if config.mode == "local_direct":
        return _validate_data(_request_json(config, f"/skill/v1/products/{product_id}/data", query), product_id, limit)
    return _validate_data(_request_json(config, f"{PROXY_ROUTE_ROOT}/data", query), product_id, limit)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="seoul-weather-risk ASK Seoul HTTPS client")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("preflight", help="live API 환경 설정 확인(네트워크 호출 없음)")
    commands.add_parser("catalog", help="weather_place_risk_window bundle 조회")

    describe = commands.add_parser("describe", help="제품 metadata 조회")
    describe.add_argument("--product-id", required=True)

    query = commands.add_parser("query", help="제품 data page 조회")
    query.add_argument("--product-id", required=True)
    query.add_argument("--filter", action="append", default=[], metavar="COLUMN=VALUE")
    query.add_argument("--admin-dong", help="서울 행정동 이름")
    query.add_argument("--gu", help="동명이명 해소용 서울 자치구 이름")
    query.add_argument("--from", dest="from_value")
    query.add_argument("--to", dest="to_value")
    query.add_argument("--limit", type=int, default=100)
    query.add_argument("--cursor")
    query.add_argument("--fast", action="store_true", help="metadata 조회를 생략하고 안전한 data-only 질문 경로 사용")
    return parser


def run(argv: list[str]) -> int:
    args = _parser().parse_args(argv)
    try:
        config = _api_config()
        if args.command == "preflight":
            result = {
                "status": "ok",
                "mode": config.mode,
                "live_network": False,
                "user_api_key_required": config.mode == "local_direct",
                "proxy_base_url_configured": config.mode == "hosted_proxy",
                "local_direct_base_url_configured": config.mode == "local_direct",
            }
        elif args.command == "catalog":
            result = _bundle(config)
        elif args.command == "describe":
            _bundle(config)
            result = _detail(config, args.product_id)
        else:
            if not 1 <= args.limit <= 500:
                raise SkillError("invalid_limit", "limit은 1부터 500 사이여야 합니다.")
            if args.fast and args.filter:
                raise SkillError("invalid_fast_query", "fast query에서는 --filter를 사용할 수 없습니다.")
            detail = None
            if not args.fast:
                _bundle(config)
                detail = _detail(config, args.product_id)
            filters = _filters(args.filter)
            if args.gu is not None and args.admin_dong is None:
                raise SkillError("invalid_location_input", "--gu는 --admin-dong과 함께 사용해야 합니다.")
            if args.admin_dong is not None:
                if not _normalize_location_name(args.admin_dong):
                    raise SkillError("invalid_location_input", "--admin-dong은 비어 있을 수 없습니다.")
                if args.gu is not None and not _normalize_location_name(args.gu):
                    raise SkillError("invalid_location_input", "--gu는 비어 있을 수 없습니다.")
                if "place_id" in filters:
                    raise SkillError(
                        "conflicting_location_input",
                        "--admin-dong과 place_id 필터는 동시에 사용할 수 없습니다.",
                    )
                resolved = _resolve_admin_dong(args.admin_dong, args.gu)
                filters["place_id"] = resolved["place_id"]
            if not args.fast:
                allowed_columns = {column["name"] for column in detail["metadata"].get("columns", [])}
                unknown = sorted(set(filters) - allowed_columns)
                if unknown:
                    raise SkillError("unknown_filter", f"공개 projection에 없는 필터입니다: {', '.join(unknown)}")
            request_query = {**filters, "limit": str(args.limit)}
            if args.from_value is not None:
                request_query["from"] = _time_bound(args.from_value, "from")
            if args.to_value is not None:
                request_query["to"] = _time_bound(args.to_value, "to")
            if args.cursor is not None:
                request_query["cursor"] = args.cursor
            result = _data(config, args.product_id, request_query, args.limit)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except SkillError as exc:
        error = {"code": exc.code, "message": exc.message}
        if exc.details:
            error["details"] = exc.details
        print(json.dumps({"error": error}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
