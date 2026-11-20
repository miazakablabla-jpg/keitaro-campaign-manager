"""Статистика кампании из отчётов Keitaro (POST /report/build)."""

from datetime import date, timedelta
from typing import Any

from app.config import get_settings
from app.keitaro import KeitaroClient

# Период в интерфейсе → interval Keitaro (значения из описания RangeRequest)
INTERVALS = {
    "today": "today",
    "yesterday": "yesterday",
    "7d": "7_days_ago",
    "30d": "1_month_ago",
    "month": "first_day_of_this_month",
    "all": "all_time",
}

MEASURES = ["clicks", "campaign_unique_clicks", "bots", "conversions", "revenue"]
_KEYS = {"clicks": "clicks", "campaign_unique_clicks": "unique", "bots": "bots", "conversions": "conversions", "revenue": "revenue"}


class StatsError(ValueError):
    pass


def _empty() -> dict[str, float]:
    return {"clicks": 0, "unique": 0, "bots": 0, "conversions": 0, "revenue": 0.0}


def _num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _metrics(row: dict) -> dict[str, float]:
    m = _empty()
    for src, dst in _KEYS.items():
        m[dst] = _num(row.get(src))
    for key in ("clicks", "unique", "bots", "conversions"):
        m[key] = int(m[key])
    m["revenue"] = round(m["revenue"], 2)
    return m


def _add(acc: dict, m: dict) -> None:
    for k, v in m.items():
        acc[k] = round(acc[k] + v, 2) if k == "revenue" else acc[k] + v


def _rows(resp: Any) -> list[dict]:
    rows = resp.get("rows", []) if isinstance(resp, dict) else resp or []
    return [r for r in rows if isinstance(r, dict)]


def _report(kt: KeitaroClient, campaign_id: int, interval: str, dimensions: list[str]) -> list[dict]:
    rng: dict[str, str] = {"interval": interval}
    tz = get_settings().report_timezone
    if tz:
        rng["timezone"] = tz
    body = {
        "range": rng,
        "dimensions": dimensions,
        "measures": MEASURES,
        "filters": [{"name": "campaign_id", "operator": "EQUALS", "expression": campaign_id}],
    }
    return _rows(kt.build_report(body))


def _expected_days(period: str, today: date) -> list[date] | None:
    if period == "today":
        return [today]
    if period == "yesterday":
        return [today - timedelta(days=1)]
    if period == "7d":
        return [today - timedelta(days=i) for i in range(6, -1, -1)]
    if period == "30d":
        return [today - timedelta(days=i) for i in range(29, -1, -1)]
    if period == "month":
        return [today.replace(day=d) for d in range(1, today.day + 1)]
    return None


def campaign_stats(kt: KeitaroClient, campaign_id: int, period: str, today: date | None = None) -> dict:
    if period not in INTERVALS:
        raise StatsError(f"Неизвестный период «{period}»")
    interval = INTERVALS[period]
    today = today or date.today()

    by_stream: dict[int, dict] = {}
    totals = _empty()
    for row in _report(kt, campaign_id, interval, ["stream_id"]):
        sid = int(_num(row.get("stream_id")))
        m = _metrics(row)
        by_stream[sid] = m
        _add(totals, m)

    by_offer: dict[str, dict] = {}
    for row in _report(kt, campaign_id, interval, ["stream_id", "offer_id"]):
        sid, oid = int(_num(row.get("stream_id"))), int(_num(row.get("offer_id")))
        if oid:
            by_offer[f"{sid}:{oid}"] = _metrics(row)

    daily: dict[str, dict] = {}
    for row in _report(kt, campaign_id, interval, ["day"]):
        day = str(row.get("day") or "")[:10]
        if day:
            daily[day] = _metrics(row)

    expected = _expected_days(period, today)
    if expected is not None:
        days = [d.isoformat() for d in expected]
    else:
        days = sorted(daily)
    series = [{"day": d, **daily.get(d, _empty())} for d in days]

    return {"period": period, "interval": interval, "totals": totals, "streams": by_stream, "offers": by_offer, "daily": series}
