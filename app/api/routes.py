from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.keitaro import KeitaroClient, get_keitaro
from app.models import Campaign
from app.schemas import AddOffer, CampaignCreate, CampaignOut, NameIn, PinOffer
from app.services import editor
from app.services.creator import CampaignInput, create_campaign
from app.services.offers import catalog
from app.services.stats import campaign_stats

router = APIRouter(prefix="/api")

Db = Depends(get_db)
Kt = Depends(get_keitaro)


def _campaign_out(db: Session, stream_id: int, warnings: list[str] | None = None) -> CampaignOut:
    stream = editor.get_stream(db, stream_id)
    db.refresh(stream.campaign)
    return CampaignOut.of(stream.campaign, warnings)


@router.get("/meta")
def meta():
    """Что нужно фронту знать о подключении (ключ наружу не отдаём)."""
    s = get_settings()
    fake = s.keitaro_api_key == "fake-key"
    base = s.keitaro_url.rstrip("/").removesuffix("/admin_api/v1")
    return {
        "fake_keitaro": fake,
        "keitaro_admin_url": None if fake else f"{base}/admin/",
        "geo_redirect_url": s.geo_redirect_url,
    }


# --- справочники Keitaro -------------------------------------------------
@router.get("/refs")
def refs(kt: KeitaroClient = Kt):
    """Домены, группы кампаний и источники для формы создания."""
    return {
        "domains": [{"id": d["id"], "name": d["name"]} for d in kt.list_domains() if d.get("state") != "deleted"],
        "groups": [{"id": g["id"], "name": g["name"]} for g in kt.list_campaign_groups()],
        "sources": [{"id": s["id"], "name": s["name"]} for s in kt.list_traffic_sources() if s.get("state") != "deleted"],
    }


@router.post("/refs/groups")
def create_group(body: NameIn, kt: KeitaroClient = Kt):
    g = kt.create_campaign_group(body.name.strip())
    return {"id": g["id"], "name": g["name"]}


@router.post("/refs/sources")
def create_source(body: NameIn, kt: KeitaroClient = Kt):
    s = kt.create_traffic_source(body.name.strip())
    return {"id": s["id"], "name": s["name"]}


@router.get("/offers/search")
def search_offers(q: str = Query("", max_length=200), kt: KeitaroClient = Kt):
    return catalog.search(kt, q)


# --- часть 1: создание ---------------------------------------------------
@router.post("/campaigns", response_model=CampaignOut, response_model_by_alias=True)
def create(body: CampaignCreate, db: Session = Db, kt: KeitaroClient = Kt):
    campaign = create_campaign(db, kt, CampaignInput(**body.model_dump()))
    return CampaignOut.of(campaign)


# --- часть 2: редактор ---------------------------------------------------
@router.get("/keitaro/campaigns")
def keitaro_campaigns(db: Session = Db, kt: KeitaroClient = Kt):
    """Кампании из трекера + отметка, какие уже загружены в обёртку."""
    known = set(db.scalars(select(Campaign.id)))
    rows = [c for c in kt.list_campaigns() if c.get("state") != "deleted"]
    rows.sort(key=lambda c: c["id"], reverse=True)
    return [{"id": c["id"], "name": c["name"], "alias": c.get("alias"), "imported": c["id"] in known} for c in rows]


@router.get("/campaigns/{campaign_id}", response_model=CampaignOut, response_model_by_alias=True)
def get_campaign(campaign_id: int, db: Session = Db):
    campaign = db.get(Campaign, campaign_id)
    if campaign is None:
        raise HTTPException(404, "Кампания ещё не загружена. Нажмите Fetch streams")
    return CampaignOut.of(campaign)


@router.get("/campaigns/{campaign_id}/stats")
def stats(campaign_id: int, period: str = Query("today", max_length=16), kt: KeitaroClient = Kt):
    """Клики, уникальные, боты, конверсии и доход по кампании, потокам, офферам и дням."""
    return campaign_stats(kt, campaign_id, period)


@router.post("/campaigns/{campaign_id}/fetch", response_model=CampaignOut, response_model_by_alias=True)
def fetch_streams(campaign_id: int, db: Session = Db, kt: KeitaroClient = Kt):
    return CampaignOut.of(editor.sync_campaign(db, kt, campaign_id))


@router.post("/streams/{stream_id}/offers", response_model=CampaignOut, response_model_by_alias=True)
def add_offer(stream_id: int, body: AddOffer, db: Session = Db, kt: KeitaroClient = Kt):
    editor.add_offer(db, kt, stream_id, body.offer_id)
    return _campaign_out(db, stream_id)


@router.post("/streams/{stream_id}/cancel", response_model=CampaignOut, response_model_by_alias=True)
def cancel(stream_id: int, db: Session = Db):
    editor.cancel_stream(db, stream_id)
    return _campaign_out(db, stream_id)


@router.post("/streams/{stream_id}/push", response_model=CampaignOut, response_model_by_alias=True)
def push(stream_id: int, db: Session = Db, kt: KeitaroClient = Kt):
    _, warnings = editor.push_stream(db, kt, stream_id)
    return _campaign_out(db, stream_id, warnings)


@router.post("/stream-offers/{link_id}/remove", response_model=CampaignOut, response_model_by_alias=True)
def remove(link_id: int, db: Session = Db):
    stream = editor.remove_offer(db, link_id)
    return _campaign_out(db, stream.id)


@router.post("/stream-offers/{link_id}/restore", response_model=CampaignOut, response_model_by_alias=True)
def restore(link_id: int, db: Session = Db):
    stream = editor.restore_offer(db, link_id)
    return _campaign_out(db, stream.id)


@router.post("/stream-offers/{link_id}/pin", response_model=CampaignOut, response_model_by_alias=True)
def pin(link_id: int, body: PinOffer, db: Session = Db):
    stream = editor.pin_offer(db, link_id, body.share)
    return _campaign_out(db, stream.id)


@router.post("/stream-offers/{link_id}/unpin", response_model=CampaignOut, response_model_by_alias=True)
def unpin(link_id: int, db: Session = Db):
    stream = editor.unpin_offer(db, link_id)
    return _campaign_out(db, stream.id)
