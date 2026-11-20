from datetime import date

from app.services.stats import campaign_stats


def test_stats_endpoint_shapes_and_totals(client):
    client.post("/api/campaigns/1/fetch")
    data = client.get("/api/campaigns/1/stats", params={"period": "7d"}).json()
    assert data["interval"] == "7_days_ago"
    assert len(data["daily"]) == 7
    streams = data["streams"]
    # итог кампании = сумма по потокам, по дням — тоже
    assert data["totals"]["clicks"] == sum(s["clicks"] for s in streams.values())
    assert data["totals"]["clicks"] == sum(d["clicks"] for d in data["daily"])
    # клики потока с офферами = сумма по его офферам
    offers = {k: v for k, v in data["offers"].items() if k.startswith("102:")}
    assert set(offers) == {"102:3717", "102:3718", "102:3719"}
    assert sum(o["clicks"] for o in offers.values()) == streams["102"]["clicks"]


def test_unknown_period_is_400(client):
    assert client.get("/api/campaigns/1/stats", params={"period": "decade"}).status_code == 400


def test_missing_days_are_filled_with_zeros(kt):
    class Empty:
        def build_report(self, body):
            return {"rows": [{"day": "2026-11-18", "clicks": 5}] if body["dimensions"] == ["day"] else []}

    data = campaign_stats(Empty(), 1, "7d", today=date(2026, 11, 20))
    assert [d["day"] for d in data["daily"]][0] == "2026-11-14"
    assert [d["clicks"] for d in data["daily"]] == [0, 0, 0, 0, 5, 0, 0]
