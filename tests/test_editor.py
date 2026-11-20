"""Сценарий из видео, шаг за шагом, на демо-кампании эмулятора (id=1)."""

from app.models import Offer

CID = 1


def offers_stream(data: dict) -> dict:
    return next(s for s in data["streams"] if s["has_offers"])


def local(data: dict) -> list[tuple[int, int, str]]:
    return [(o["offer_id"], o["share"], o["status"]) for o in offers_stream(data)["offers"]]


def remote(fake, stream_id: int) -> list[tuple[int, int]]:
    return [(o["offer_id"], o["share"]) for o in fake.streams[stream_id]["offers"]]


def link_id(data: dict, offer_id: int) -> int:
    return next(o["id"] for o in offers_stream(data)["offers"] if o["offer_id"] == offer_id)


def test_fetch_parses_only_streams_with_offers(client):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    flow1, flow2 = data["streams"]
    assert flow1["name"] == "Flow 1" and flow1["has_offers"] is False and flow1["offers"] == []
    assert local(data) == [(3717, 34, "active"), (3718, 33, "active"), (3719, 33, "active")]
    assert flow2["is_dirty"] is False


def test_add_is_local_until_push(client, fake):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    sid = offers_stream(data)["id"]

    data = client.post(f"/api/streams/{sid}/offers", json={"offer_id": 3720}).json()
    assert local(data) == [(3717, 25, "active"), (3718, 25, "active"), (3719, 25, "active"), (3720, 25, "added")]
    assert offers_stream(data)["is_dirty"] is True
    assert len(remote(fake, sid)) == 3  # в Keitaro пока ничего не поменялось

    data = client.post(f"/api/streams/{sid}/push").json()
    assert offers_stream(data)["is_dirty"] is False
    assert remote(fake, sid) == [(3717, 25), (3718, 25), (3719, 25), (3720, 25)]
    assert all(o["status"] == "active" for o in offers_stream(data)["offers"])


def test_cancel_drops_unpublished_links_but_keeps_offer(client, fake, db_session):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    sid = offers_stream(data)["id"]
    client.post(f"/api/streams/{sid}/offers", json={"offer_id": 3720})
    data = client.post(f"/api/streams/{sid}/offers", json={"offer_id": 3721}).json()
    assert len(offers_stream(data)["offers"]) == 5

    data = client.post(f"/api/streams/{sid}/cancel").json()
    assert local(data) == [(3717, 34, "active"), (3718, 33, "active"), (3719, 33, "active")]
    assert offers_stream(data)["is_dirty"] is False
    with db_session() as db:
        assert db.get(Offer, 3720) is not None  # оффер остался, удалилась только привязка


def test_remove_push_and_bring_back(client, fake):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    sid = offers_stream(data)["id"]

    data = client.post(f"/api/stream-offers/{link_id(data, 3718)}/remove").json()
    assert local(data) == [(3717, 50, "active"), (3718, 0, "removing"), (3719, 50, "active")]
    assert offers_stream(data)["is_dirty"] is True

    data = client.post(f"/api/streams/{sid}/push").json()
    assert remote(fake, sid) == [(3717, 50), (3719, 50)]
    assert local(data) == [(3717, 50, "active"), (3718, 0, "removed"), (3719, 50, "active")]
    assert offers_stream(data)["is_dirty"] is False

    data = client.post(f"/api/stream-offers/{link_id(data, 3718)}/restore").json()
    assert offers_stream(data)["is_dirty"] is True
    data = client.post(f"/api/streams/{sid}/push").json()
    assert sorted(remote(fake, sid)) == [(3717, 34), (3718, 33), (3719, 33)]


def test_cancel_reverts_remove(client):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    sid = offers_stream(data)["id"]
    client.post(f"/api/stream-offers/{link_id(data, 3718)}/remove")
    data = client.post(f"/api/streams/{sid}/cancel").json()
    assert local(data) == [(3717, 34, "active"), (3718, 33, "active"), (3719, 33, "active")]


def test_offers_deleted_in_keitaro_become_removed_on_fetch(client, kt, fake):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    sid = offers_stream(data)["id"]
    # пользователь удалил два оффера прямо в Keitaro
    kt._request("POST", f"_debug/streams/{sid}/offers", json={"offers": [{"offer_id": 3717, "share": 100}]})

    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    assert local(data) == [(3717, 100, "active"), (3718, 0, "removed"), (3719, 0, "removed")]

    data = client.post(f"/api/stream-offers/{link_id(data, 3719)}/restore").json()
    assert local(data) == [(3717, 50, "active"), (3718, 0, "removed"), (3719, 50, "added")]


def test_pinned_weight_survives_recalculation(client, fake):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    sid = offers_stream(data)["id"]
    data = client.post(f"/api/streams/{sid}/offers", json={"offer_id": 3720}).json()  # 25/25/25/25
    data = client.post(f"/api/stream-offers/{link_id(data, 3717)}/pin", json={}).json()
    assert offers_stream(data)["offers"][0]["pinned"] is True

    data = client.post(f"/api/stream-offers/{link_id(data, 3718)}/remove").json()
    assert local(data) == [(3717, 25, "active"), (3718, 0, "removing"), (3719, 38, "active"), (3720, 37, "added")]

    data = client.post(f"/api/stream-offers/{link_id(data, 3718)}/restore").json()
    assert [o[1] for o in local(data)] == [25, 25, 25, 25]

    data = client.post(f"/api/stream-offers/{link_id(data, 3717)}/pin", json={"share": 40}).json()
    assert [o[1] for o in local(data)] == [40, 20, 20, 20]

    client.post(f"/api/streams/{sid}/push")
    assert remote(fake, sid) == [(3717, 40), (3718, 20), (3719, 20), (3720, 20)]


def test_pin_dropped_when_weight_changed_in_keitaro(client, kt):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    sid = offers_stream(data)["id"]
    data = client.post(f"/api/stream-offers/{link_id(data, 3717)}/pin", json={}).json()
    client.post(f"/api/streams/{sid}/push")
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    assert offers_stream(data)["offers"][0]["pinned"] is True  # своё же опубликованное закрепление держим

    kt._request("POST", f"_debug/streams/{sid}/offers", json={"offers": [{"offer_id": 3717, "share": 100}]})
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    assert offers_stream(data)["offers"][0]["pinned"] is False
    data = client.post(f"/api/stream-offers/{link_id(data, 3719)}/restore").json()
    assert [o[1] for o in local(data)] == [50, 0, 50]


def test_push_rejects_weights_not_summing_to_100(client, fake):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    sid = offers_stream(data)["id"]
    for oid in (3717, 3718, 3719):
        data = client.post(f"/api/stream-offers/{link_id(data, oid)}/pin", json={"share": 30}).json()
    assert offers_stream(data)["total_share"] == 90

    resp = client.post(f"/api/streams/{sid}/push")
    assert resp.status_code == 400
    assert "100%" in resp.json()["detail"]
    assert remote(fake, sid) == [(3717, 34), (3718, 33), (3719, 33)]


def test_pin_over_100_is_rejected(client):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    data = client.post(f"/api/stream-offers/{link_id(data, 3717)}/pin", json={"share": 80}).json()
    resp = client.post(f"/api/stream-offers/{link_id(data, 3718)}/pin", json={"share": 30})
    assert resp.status_code == 400
    data = client.get(f"/api/campaigns/{CID}").json()
    assert [o[1] for o in local(data)] == [80, 10, 10]


def test_add_duplicate_and_unknown_offer(client):
    data = client.post(f"/api/campaigns/{CID}/fetch").json()
    sid = offers_stream(data)["id"]
    assert client.post(f"/api/streams/{sid}/offers", json={"offer_id": 3717}).status_code == 400
    assert client.post(f"/api/streams/{sid}/offers", json={"offer_id": 999999}).status_code == 400
