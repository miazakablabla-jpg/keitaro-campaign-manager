"""Эмулятор нужной части Keitaro Admin API v1 — для локальной разработки и тестов.

Данные живут в памяти процесса. Запуск:
    uvicorn fake_keitaro.app:app --port 8001
Проверяет заголовок Api-Key (значение задаётся FAKE_KEITARO_KEY, по умолчанию fake-key).
"""

import copy
import hashlib
import os
import random
from datetime import date, datetime, timedelta, timezone
from itertools import count

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request

API_KEY = os.environ.get("FAKE_KEITARO_KEY", "fake-key")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _days_ago(n: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).strftime("%Y-%m-%d %H:%M:%S")


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
            "_created_at": _days_ago(45),
            "campaign_id": cid, "type": "regular", "name": "Flow 1", "position": 1, "schema": "redirect",
            "action_type": "http", "action_payload": "https://google.com",
            "filters": [{"name": "country", "mode": "accept", "payload": ["AU"]}],
        })
        self._make_stream({
            "_created_at": _days_ago(45),
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
            "created_at": body.get("_created_at") or _now(), "updated_at": _now(),
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


# --- отчёты: синтетическая, но стабильная статистика -----------------------
MEASURE_MAP = {
    "clicks": "clicks",
    "campaign_unique_clicks": "unique",
    "bots": "bots",
    "conversions": "conversions",
    "revenue": "revenue",
}


def _rng(*parts) -> random.Random:
    seed = int(hashlib.md5(":".join(map(str, parts)).encode()).hexdigest()[:8], 16)
    return random.Random(seed)


def _range_days(rng: dict) -> list[date]:
    today = date.today()
    interval = rng.get("interval")
    if rng.get("from") and rng.get("to"):
        start, end = date.fromisoformat(rng["from"][:10]), date.fromisoformat(rng["to"][:10])
    elif interval == "yesterday":
        start = end = today - timedelta(days=1)
    elif interval == "7_days_ago":
        start, end = today - timedelta(days=6), today
    elif interval == "1_month_ago":
        start, end = today - timedelta(days=29), today
    elif interval == "first_day_of_this_month":
        start, end = today.replace(day=1), today
    elif interval == "all_time":
        start, end = today - timedelta(days=59), today
    else:
        start = end = today
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def _split(total: int, shares: list[int]) -> list[int]:
    s = sum(shares) or 1
    raw = [total * sh / s for sh in shares]
    out = [int(x) for x in raw]
    for i in sorted(range(len(raw)), key=lambda i: raw[i] - out[i], reverse=True)[: total - sum(out)]:
        out[i] += 1
    return out


def _click_rows(campaign_id: int, days: list[date]) -> list[dict]:
    now = datetime.now()
    day_part = (now.hour * 60 + now.minute) / 1440
    rows = []
    for s in store.streams.values():
        if s["campaign_id"] != campaign_id or s["state"] == "deleted":
            continue
        offers = [o for o in s["offers"] if o.get("state", "active") == "active"]
        born = date.fromisoformat(s["created_at"][:10])
        for d in days:
            if d < born:
                continue
            r = _rng("stream", s["id"], d.isoformat())
            base = r.randint(60, 240) if offers else r.randint(8, 50)
            clicks = int(base * (0.85 if d.weekday() >= 5 else 1.0))
            if d == now.date():
                clicks = int(clicks * max(day_part, 0.05))
            parts = _split(clicks, [o["share"] for o in offers]) if offers else [clicks]
            targets = offers or [None]
            for o, c in zip(targets, parts):
                oid = o["offer_id"] if o else 0
                ro = _rng("offer", s["id"], oid, d.isoformat())
                cr = _rng("cr", oid).uniform(0.015, 0.06) if oid else 0
                payout = _rng("payout", oid).choice([8, 12, 15, 20, 25, 30]) if oid else 0
                conv = sum(1 for _ in range(c) if ro.random() < cr)
                rows.append({
                    "campaign_id": campaign_id, "stream_id": s["id"], "offer_id": oid, "day": d.isoformat(),
                    "clicks": c, "unique": int(c * ro.uniform(0.72, 0.9)), "bots": int(c * ro.uniform(0.01, 0.07)),
                    "conversions": conv, "revenue": float(conv * payout),
                })
    return rows


@api.post("/report/build")
async def build_report(request: Request):
    body = await request.json()
    measures = body.get("measures") or body.get("metrics") or ["clicks"]
    dims = body.get("dimensions") or []
    campaign_id = None
    for f in body.get("filters") or []:
        if f.get("name") == "campaign_id" and f.get("operator") == "EQUALS":
            campaign_id = int(f["expression"])
    if campaign_id is None:
        raise HTTPException(400, {"error": "fake keitaro supports only campaign_id EQUALS filter"})
    unknown = [m for m in measures if m not in MEASURE_MAP]
    if unknown:
        raise HTTPException(400, {"error": f"Unknown measures: {unknown}"})

    groups: dict[tuple, dict] = {}
    for row in _click_rows(campaign_id, _range_days(body.get("range") or {})):
        key = tuple(row[d] for d in dims)
        acc = groups.setdefault(key, {**dict(zip(dims, key)), **{m: 0 for m in measures}})
        for m in measures:
            acc[m] += row[MEASURE_MAP[m]]
    rows = sorted(groups.values(), key=lambda r: tuple(str(r[d]) for d in dims))
    return {"rows": rows, "total": len(rows), "meta": dims + measures}


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
