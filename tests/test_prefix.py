"""Правило теста: свои кампании называются test_фамилия_…, чужие не трогаем."""

BODY = {"geo": "MX", "offer_id": 3720, "domain_id": 1, "group_id": 1, "traffic_source_id": 1}


def test_creator_adds_prefix_once(client, prefix):
    a = client.post("/api/campaigns", json={**BODY, "name": "campaign1"}).json()
    b = client.post("/api/campaigns", json={**BODY, "name": "test_me_campaign2"}).json()
    assert a["name"] == "test_me_campaign1" and a["editable"] is True
    assert b["name"] == "test_me_campaign2"
    assert client.post("/api/campaigns", json={**BODY, "name": "test_me_"}).status_code == 400


def test_foreign_campaign_is_read_only(client, prefix, fake):
    data = client.post("/api/campaigns/1/fetch").json()  # «campaign 2» — без префикса
    assert data["editable"] is False
    stream = next(s for s in data["streams"] if s["has_offers"])
    link = stream["offers"][0]["id"]

    for resp in (
        client.post(f"/api/streams/{stream['id']}/offers", json={"offer_id": 3720}),
        client.post(f"/api/stream-offers/{link}/remove"),
        client.post(f"/api/stream-offers/{link}/pin", json={}),
        client.post(f"/api/streams/{stream['id']}/cancel"),
        client.post(f"/api/streams/{stream['id']}/push"),
    ):
        assert resp.status_code == 403
        assert "чужая" in resp.json()["detail"]
    # в Keitaro ничего не поменялось, а статистика доступна
    assert [o["share"] for o in fake.streams[stream["id"]]["offers"]] == [34, 33, 33]
    assert client.get("/api/campaigns/1/stats", params={"period": "today"}).status_code == 200


def test_campaign_list_marks_mine(client, prefix):
    client.post("/api/campaigns", json={**BODY, "name": "x"})
    rows = {c["name"]: c["mine"] for c in client.get("/api/keitaro/campaigns").json()}
    assert rows == {"test_me_x": True, "campaign 2": False}
    assert client.get("/api/meta").json()["campaign_prefix"] == "test_me_"
