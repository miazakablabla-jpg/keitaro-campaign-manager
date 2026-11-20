from app.services.creator import parse_geo


def test_parse_geo():
    assert parse_geo("mx, AU;ro AU") == ["MX", "AU", "RO"]


def test_refs_and_offer_search(client):
    refs = client.get("/api/refs").json()
    assert refs["domains"][0]["name"] == "in.posdk.xyz"
    assert refs["groups"] == [{"id": 1, "name": "FORTESTS"}]

    found = client.get("/api/offers/search", params={"q": "spin"}).json()
    assert [o["id"] for o in found] == [3718]
    assert client.get("/api/offers/search", params={"q": "3718"}).json()[0]["id"] == 3718
    # удалённые офферы в поиск не попадают
    assert client.get("/api/offers/search", params={"q": "Удалённый"}).json() == []


def test_create_campaign_builds_two_streams(client, fake):
    resp = client.post(
        "/api/campaigns",
        json={"name": "My campaign", "geo": "mx,au", "offer_id": 3720, "domain_id": 1, "group_id": 1, "traffic_source_id": 1},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["name"] == "My campaign"
    assert data["url"] == f"https://in.posdk.xyz/{data['alias']}"

    k_campaign = fake.campaigns[data["id"]]
    assert (k_campaign["domain_id"], k_campaign["group_id"], k_campaign["traffic_source_id"]) == (1, 1, 1)
    assert k_campaign["type"] == "position"

    k_streams = sorted((s for s in fake.streams.values() if s["campaign_id"] == data["id"]), key=lambda s: s["position"])
    geo, offers = k_streams
    assert geo["schema"] == "redirect"
    assert geo["action_payload"] == "https://google.com"
    assert [(f["name"], f["mode"], f["payload"]) for f in geo["filters"]] == [("country", "accept", ["MX", "AU"])]
    assert offers["filters"] == []
    assert [(o["offer_id"], o["share"]) for o in offers["offers"]] == [(3720, 100)]

    # в обёртке: гео-поток хранится «как поток», поток с оффером разобран
    s1, s2 = data["streams"]
    assert s1["has_offers"] is False and s1["offers"] == []
    assert s2["has_offers"] is True
    assert [(o["offer_id"], o["share"], o["status"]) for o in s2["offers"]] == [(3720, 100, "active")]


def test_create_campaign_validation(client, fake):
    base = {"name": "x", "geo": "MX", "offer_id": 3720, "domain_id": 1, "group_id": 1, "traffic_source_id": 1}
    assert client.post("/api/campaigns", json={**base, "geo": "Mexico"}).status_code == 400
    assert client.post("/api/campaigns", json={**base, "offer_id": 999999}).status_code == 400
    assert len(fake.campaigns) == 1  # в трекере осталась только демо-кампания
