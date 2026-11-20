"""Эмулятор нужной части Keitaro Admin API v1 — для локальной разработки и тестов.

Данные живут в памяти процесса. Запуск:
    uvicorn fake_keitaro.app:app --port 8001
Проверяет заголовок Api-Key (значение задаётся FAKE_KEITARO_KEY, по умолчанию fake-key).
"""

import copy
import os
from datetime import datetime, timezone
from itertools import count

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request

API_KEY = os.environ.get("FAKE_KEITARO_KEY", "fake-key")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class Store:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.ids = count(100)
        self.domains = [
            {"id": 1, "name": "in.posdk.xyz", "state": "active", "network_status": "active"},
            {"id": 2, "name": "go.example-track.com", "state": "active", "network_status": "active"},
        ]
        self.groups = [{"id": 1, "name": "FORTESTS", "position": 1, "type": "campaigns"}]
        self.sources = [{"id": 1, "name": "FORTESTS", "state": "active"}]
        names = [
            "Miaflow [BEAUTY-RO-BE_0008] [pl - prize ro -] 1. Основной, Румыния JS",
            "Miaflow [BEAUTY-RO-BE_0009] [pl - spin ro -] 2. Основной, Румыния JS",
            "Miaflow [BEAUTY-RO-BE_0010] [pl - wheel ro -] 3. Основной, Румыния JS",
            "Hairex [HAIR-MX-0001] Мексика JS",
            "Hairex [HAIR-MX-0002] Мексика LP",
            "Slimfit [DIET-AU-0003] Австралия",
            "Slimfit [DIET-AU-0004] Австралия пре-ленд",
            "Joint+ [HEALTH-RO-0011] Румыния",
        ]
        self.offers = {
            oid: {"id": oid, "name": name, "state": "active", "archive": 0, "country": []}
            for oid, name in zip(range(3717, 3717 + len(names)), names)
        }
        self.offers[3725] = {"id": 3725, "name": "Удалённый оффер", "state": "deleted", "archive": 1, "country": []}
        self.campaigns: dict[int, dict] = {}
        self.streams: dict[int, dict] = {}
        self._seed_demo()

    def _seed_demo(self) -> None:
        """Кампания как в видео: AU → google, остальные → 3 оффера."""
        cid = 1
        self.campaigns[cid] = {
            "id": cid, "alias": "wVqN1R", "name": "campaign 2", "type": "position", "state": "active",
            "group_id": 1, "traffic_source_id": 1, "domain_id": 1, "cost_type": "CPC", "cost_value": 0,
            "created_at": _now(), "updated_at": _now(),
        }
        self._make_stream({
            "campaign_id": cid, "type": "regular", "name": "Flow 1", "position": 1, "schema": "redirect",
            "action_type": "http", "action_payload": "https://google.com",
            "filters": [{"name": "country", "mode": "accept", "payload": ["AU"]}],
        })
        self._make_stream({
            "campaign_id": cid, "type": "regular", "name": "Flow 2", "position": 2, "schema": "landings",
            "action_type": "http",
            "offers": [
                {"offer_id": 3717, "share": 34, "state": "active"},
                {"offer_id": 3718, "share": 33, "state": "active"},
                {"offer_id": 3719, "share": 33, "state": "active"},
            ],
        })

    def next_id(self) -> int:
        return next(self.ids)

    def _make_stream(self, body: dict) -> dict:
        sid = self.next_id()
        stream = {
            "id": sid, "campaign_id": body["campaign_id"], "type": body.get("type", "regular"),
            "name": body.get("name", f"Flow {sid}"), "position": body.get("position", 1), "weight": 100,
            "state": body.get("state", "active"), "action_type": body.get("action_type", "http"),
            "action_payload": body.get("action_payload"), "schema": body.get("schema", "landings"),
            "filters": [], "landings": [], "offers": [], "triggers": [],
            "created_at": _now(), "updated_at": _now(),
        }
        self.streams[sid] = stream
        self._apply_stream(stream, body)
        return stream

    def _apply_stream(self, stream: dict, body: dict) -> None:
        for key in ("name", "position", "type", "state", "schema", "action_type", "action_payload", "weight"):
            if key in body:
                stream[key] = body[key]
        if "filters" in body:
            stream["filters"] = [{"id": self.next_id(), **f} for f in body["filters"]]
        if "offers" in body:
            # Как в Keitaro: массив offers заменяет текущий список целиком.
            offers = []
            for o in body["offers"]:
                if o["offer_id"] not in self.offers:
                    raise HTTPException(400, {"error": f"Offer {o['offer_id']} not found"})
                offers.append({
                    "id": self.next_id(), "stream_id": stream["id"], "offer_id": o["offer_id"],
                    "share": o["share"], "state": o.get("state", "active"),
                    "created_at": _now(), "updated_at": _now(),
                })
            stream["offers"] = offers
        stream["updated_at"] = _now()


store = Store()


def auth(api_key: str | None = Header(default=None, alias="Api-Key")) -> None:
    if api_key != API_KEY:
        raise HTTPException(401, {"error": "Unauthorized"})


api = APIRouter(prefix="/admin_api/v1", dependencies=[Depends(auth)])


def _get(table: dict, key: int, what: str) -> dict:
    if key not in table:
        raise HTTPException(404, {"error": f"{what} not found"})
    return table[key]


@api.get("/domains")
def domains():
    return store.domains


@api.get("/groups")
def groups(type: str = "campaigns"):
    return [g for g in store.groups if g["type"] == type]


@api.post("/groups")
async def create_group(request: Request):
    body = await request.json()
    group = {"id": store.next_id(), "name": body["name"], "type": body["type"], "position": 0}
    store.groups.append(group)
    return group


@api.get("/traffic_sources")
def sources():
    return store.sources


@api.post("/traffic_sources")
async def create_source(request: Request):
    body = await request.json()
    source = {"id": store.next_id(), "name": body.get("name", ""), "state": "active"}
    store.sources.append(source)
    return source


@api.get("/offers")
def offers():
    return list(store.offers.values())


@api.get("/offers/{offer_id}")
def offer(offer_id: int):
    return _get(store.offers, offer_id, "Offer")


@api.get("/campaigns")
def campaigns():
    return list(store.campaigns.values())


@api.post("/campaigns")
async def create_campaign(request: Request):
    body = await request.json()
    for field in ("alias", "name"):
        if not body.get(field):
            raise HTTPException(400, {"error": f"{field} is required"})
    if any(c["alias"] == body["alias"] for c in store.campaigns.values()):
        raise HTTPException(400, {"error": "alias already taken"})
    cid = store.next_id()
    campaign = {"id": cid, "state": "active", "type": "position", **body, "created_at": _now(), "updated_at": _now()}
    campaign["id"] = cid
    store.campaigns[cid] = campaign
    return campaign


@api.get("/campaigns/{campaign_id}")
def campaign(campaign_id: int):
    return _get(store.campaigns, campaign_id, "Campaign")


@api.delete("/campaigns/{campaign_id}")
def archive_campaign(campaign_id: int):
    _get(store.campaigns, campaign_id, "Campaign")["state"] = "deleted"
    return None


@api.get("/campaigns/{campaign_id}/streams")
def campaign_streams(campaign_id: int):
    _get(store.campaigns, campaign_id, "Campaign")
    rows = [s for s in store.streams.values() if s["campaign_id"] == campaign_id and s["state"] != "deleted"]
    return sorted(rows, key=lambda s: s["position"])


@api.post("/streams")
async def create_stream(request: Request):
    body = await request.json()
    for field in ("campaign_id", "schema", "type", "name", "action_type"):
        if field not in body:
            raise HTTPException(400, {"error": f"{field} is required"})
    _get(store.campaigns, body["campaign_id"], "Campaign")
    return store._make_stream(body)


@api.get("/streams/{stream_id}")
def stream(stream_id: int):
    return _get(store.streams, stream_id, "Stream")


@api.put("/streams/{stream_id}")
async def update_stream(stream_id: int, request: Request):
    s = _get(store.streams, stream_id, "Stream")
    store._apply_stream(s, await request.json())
    return s


@api.delete("/streams/{stream_id}")
def delete_stream(stream_id: int):
    s = _get(store.streams, stream_id, "Stream")
    s["state"] = "deleted"
    return s


# Служебное: «пользователь поменял что-то прямо в Keitaro» — для демо и тестов.
@api.post("/_debug/streams/{stream_id}/offers")
async def debug_set_offers(stream_id: int, request: Request):
    s = _get(store.streams, stream_id, "Stream")
    store._apply_stream(s, {"offers": (await request.json())["offers"]})
    return copy.deepcopy(s)


@api.post("/_debug/reset")
def debug_reset():
    store.reset()
    return {"ok": True}


app = FastAPI(title="Fake Keitaro Admin API")
app.include_router(api)
