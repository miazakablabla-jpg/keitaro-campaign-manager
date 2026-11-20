"""Редактор офферов в потоках кампании.

Жизненный цикл привязки оффера (StreamOffer):

    Add ─────────► added (жёлтый поток) ──Push──► active
                     │ Cancel → привязка удаляется из базы
    active ─Remove─► removing (серый, 0%) ──Push──► removed (архив, серый)
                     │ Cancel → снова active
    removed ─Bring back─► added-как-возврат ──Push──► active
    Fetch: всё, чего нет в Keitaro, уходит в removed; всё, что есть, — active.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.keitaro import KeitaroClient
from app.models import Campaign, Stream, StreamOffer
from app.services.offers import ensure_offer
from app.services.weights import Slot, WeightsError, distribute, validate_for_publish


class EditorError(ValueError):
    pass


class NotFound(LookupError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------
# Fetch: Keitaro → локальная база
# --------------------------------------------------------------------------
def sync_campaign(
    db: Session,
    kt: KeitaroClient,
    campaign_id: int,
    created_by_us: bool = False,
    domain_id: int | None = None,
) -> Campaign:
    kc = kt.get_campaign(campaign_id)
    k_streams = kt.list_streams(campaign_id)

    campaign = db.get(Campaign, campaign_id)
    if campaign is None:
        campaign = Campaign(id=campaign_id, created_by_us=created_by_us)
        db.add(campaign)
    campaign.name = kc.get("name") or f"Campaign #{campaign_id}"
    campaign.alias = kc.get("alias") or ""
    campaign.group_id = _int_or_none(kc.get("group_id"))
    campaign.traffic_source_id = _int_or_none(kc.get("traffic_source_id"))
    # В ответе GET /campaigns/{id} домена может не быть — тогда берём тот, что передали при создании.
    new_domain = _int_or_none(kc.get("domain_id")) or domain_id
    if new_domain and new_domain != campaign.domain_id:
        campaign.domain_id = new_domain
        campaign.domain_name = None
    if campaign.domain_id and not campaign.domain_name:
        domain = next((d for d in kt.list_domains() if d["id"] == campaign.domain_id), None)
        campaign.domain_name = domain["name"] if domain else None
    campaign.synced_at = _now()

    local = {s.id: s for s in campaign.streams}
    seen: set[int] = set()
    for ks in k_streams:
        if ks.get("state") == "deleted":
            continue
        sid = int(ks["id"])
        seen.add(sid)
        stream = local.get(sid)
        if stream is None:
            stream = Stream(id=sid, campaign=campaign)
            db.add(stream)
        _apply_stream(db, kt, stream, ks)

    for sid, stream in local.items():
        if sid not in seen:
            campaign.streams.remove(stream)

    db.commit()
    db.refresh(campaign)
    return campaign


def _apply_stream(db: Session, kt: KeitaroClient, stream: Stream, ks: dict) -> None:
    stream.name = ks.get("name") or f"Flow #{ks['id']}"
    stream.position = int(ks.get("position") or 0)
    stream.type = ks.get("type")
    stream.schema = ks.get("schema")
    stream.state = ks.get("state")
    stream.synced_at = _now()
    _apply_offers(db, kt, stream, ks.get("offers") or [])


def _apply_offers(db: Session, kt: KeitaroClient, stream: Stream, k_offers: list[dict]) -> None:
    """Делает черновик и «опубликованное» состояние равными тому, что в Keitaro.

    Офферы, которые мы знали, но которых в Keitaro больше нет, не удаляются,
    а уходят в архив (removed) — их можно вернуть кнопкой Bring back.
    """
    remote: dict[int, int] = {}
    for ko in k_offers:
        if ko.get("state", "active") != "active":
            continue
        remote[int(ko["offer_id"])] = int(ko.get("share") or 0)

    links = {link.offer_id: link for link in stream.offer_links}
    for offer_id, share in remote.items():
        link = links.get(offer_id)
        if link is None:
            offer = ensure_offer(db, kt, offer_id)
            link = StreamOffer(offer=offer)
            stream.offer_links.append(link)
        elif link.pinned and link.share != share:
            # Закреплённый вес поменяли прямо в Keitaro — закрепление больше не актуально.
            link.pinned = False
        link.active = link.published_active = True
        link.share = link.published_share = share
        link.is_new = False

    for offer_id, link in links.items():
        if offer_id in remote:
            continue
        if link.is_new:
            stream.offer_links.remove(link)
            continue
        link.active = link.published_active = False
        link.share = link.published_share = 0
        link.pinned = False

    # Поток без офферов не разбираем: храним только как поток.
    stream.has_offers = bool(stream.offer_links)


# --------------------------------------------------------------------------
# Локальные правки (до Push)
# --------------------------------------------------------------------------
def get_stream(db: Session, stream_id: int) -> Stream:
    stream = db.get(Stream, stream_id)
    if stream is None:
        raise NotFound(f"Поток {stream_id} не найден. Нажмите Fetch streams")
    return stream


def get_link(db: Session, link_id: int) -> StreamOffer:
    link = db.get(StreamOffer, link_id)
    if link is None:
        raise NotFound(f"Привязка оффера {link_id} не найдена")
    return link


def recalculate(stream: Stream) -> None:
    slots = [Slot(link.id or -i, link.active, link.pinned, link.share) for i, link in enumerate(stream.offer_links, 1)]
    shares = distribute(slots)
    for slot, link in zip(slots, stream.offer_links):
        link.share = shares[slot.key]


def _commit_recalc(db: Session, stream: Stream) -> Stream:
    db.flush()
    try:
        recalculate(stream)
    except WeightsError:
        db.rollback()
        raise
    db.commit()
    db.refresh(stream)
    return stream


def add_offer(db: Session, kt: KeitaroClient, stream_id: int, offer_id: int) -> Stream:
    stream = get_stream(db, stream_id)
    if not stream.has_offers:
        raise EditorError("В этом потоке нет офферов — его содержимое редактор не трогает")
    existing = db.scalar(select(StreamOffer).where(StreamOffer.stream_id == stream_id, StreamOffer.offer_id == offer_id))
    if existing is not None:
        if existing.active:
            raise EditorError(f"Оффер {offer_id} уже есть в потоке")
        existing.active = True
        return _commit_recalc(db, stream)

    try:
        kt.get_offer(offer_id)
    except Exception as exc:  # noqa: BLE001 — нам важно только «есть ли такой оффер»
        raise EditorError(f"Оффер {offer_id} не найден в Keitaro") from exc
    offer = ensure_offer(db, kt, offer_id)
    stream.offer_links.append(StreamOffer(offer=offer, active=True, published_active=False, is_new=True, share=0))
    return _commit_recalc(db, stream)


def remove_offer(db: Session, link_id: int) -> Stream:
    link = get_link(db, link_id)
    if not link.active:
        raise EditorError("Оффер уже удалён")
    link.active = False
    link.pinned = False
    return _commit_recalc(db, link.stream)


def restore_offer(db: Session, link_id: int) -> Stream:
    link = get_link(db, link_id)
    if link.active:
        raise EditorError("Оффер и так в потоке")
    link.active = True
    return _commit_recalc(db, link.stream)


def pin_offer(db: Session, link_id: int, share: int | None) -> Stream:
    link = get_link(db, link_id)
    if not link.active:
        raise EditorError("Закрепить можно только активный оффер")
    if share is not None:
        if not 0 <= share <= 100:
            raise EditorError("Вес должен быть от 0 до 100")
        link.share = share
    link.pinned = True
    return _commit_recalc(db, link.stream)


def unpin_offer(db: Session, link_id: int) -> Stream:
    link = get_link(db, link_id)
    link.pinned = False
    return _commit_recalc(db, link.stream)


def cancel_stream(db: Session, stream_id: int) -> Stream:
    """Откатывает неопубликованные правки потока к состоянию Keitaro."""
    stream = get_stream(db, stream_id)
    for link in list(stream.offer_links):
        if link.is_new:
            stream.offer_links.remove(link)  # сама запись Offer в справочнике остаётся
            continue
        link.active = link.published_active
        link.share = link.published_share
        if not link.active:
            link.pinned = False
    db.commit()
    db.refresh(stream)
    return stream


# --------------------------------------------------------------------------
# Push: локальная база → Keitaro
# --------------------------------------------------------------------------
def push_stream(db: Session, kt: KeitaroClient, stream_id: int) -> tuple[Stream, list[str]]:
    stream = get_stream(db, stream_id)
    slots = [Slot(link.id, link.active, link.pinned, link.share) for link in stream.offer_links]
    try:
        validate_for_publish(slots)
    except WeightsError as exc:
        raise EditorError(str(exc)) from exc

    sent = {link.offer_id: link.share for link in stream.offer_links if link.active}
    body = {"offers": [{"offer_id": oid, "share": share, "state": "active"} for oid, share in sent.items()]}
    kt.update_stream(stream_id, body)

    # Перечитываем поток: в базе должно оказаться ровно то, что теперь в Keitaro.
    ks = kt.get_stream(stream_id)
    got = {int(o["offer_id"]): int(o.get("share") or 0) for o in ks.get("offers") or [] if o.get("state", "active") == "active"}
    _apply_stream(db, kt, stream, ks)
    db.commit()
    db.refresh(stream)

    warnings = []
    if got != sent:
        warnings.append(f"Keitaro сохранил не то, что отправили: отправили {sent}, в трекере {got}")
    return stream, warnings


def _int_or_none(value) -> int | None:
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None
