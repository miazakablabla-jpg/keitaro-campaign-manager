"""«Создаватор» кампаний: кампания + 2 потока одним действием."""

import re
import secrets
import string
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.config import get_settings
from app.keitaro import KeitaroClient, KeitaroError
from app.models import Campaign
from app.services.editor import EditorError, sync_campaign
from app.services.offers import ensure_offer

_GEO_RE = re.compile(r"^[A-Z]{2}$")
_ALIAS_ALPHABET = string.ascii_letters + string.digits


@dataclass
class CampaignInput:
    name: str
    geo: list[str]
    offer_id: int
    domain_id: int
    group_id: int
    traffic_source_id: int


def parse_geo(raw: str | list[str]) -> list[str]:
    """'mx, AU;ro' → ['MX', 'AU', 'RO'] (без повторов, порядок сохраняется)."""
    items = raw if isinstance(raw, list) else re.split(r"[\s,;]+", raw)
    codes: list[str] = []
    for item in items:
        code = item.strip().upper()
        if not code:
            continue
        if not _GEO_RE.match(code):
            raise EditorError(f"«{item.strip()}» — не код страны. Нужны двухбуквенные коды ISO, например MX,AU,RO")
        if code not in codes:
            codes.append(code)
    if not codes:
        raise EditorError("Укажите хотя бы одну страну")
    return codes


def apply_prefix(raw: str) -> str:
    """«campaign1» → «test_ivanov_campaign1», если в настройках задан префикс."""
    name = raw.strip()
    prefix = get_settings().campaign_prefix
    if prefix and not name.startswith(prefix):
        name = prefix + name
    if not name or name == prefix:
        raise EditorError("Укажите название кампании")
    return name


def random_alias(length: int = 6) -> str:
    return "".join(secrets.choice(_ALIAS_ALPHABET) for _ in range(length))


def geo_stream_body(campaign_id: int, geo: list[str]) -> dict:
    return {
        "campaign_id": campaign_id,
        "type": "regular",
        "name": f"Geo {','.join(geo)} → Google",
        "position": 1,
        "state": "active",
        "schema": "redirect",
        "action_type": "http",
        "action_payload": get_settings().geo_redirect_url,
        "filters": [{"name": "country", "mode": "accept", "payload": geo}],
    }


def offers_stream_body(campaign_id: int, offer_id: int) -> dict:
    return {
        "campaign_id": campaign_id,
        "type": "regular",
        "name": "Offers",
        "position": 2,
        "state": "active",
        "schema": "landings",
        "action_type": "http",
        "offers": [{"offer_id": offer_id, "share": 100, "state": "active"}],
    }


def create_campaign(db: Session, kt: KeitaroClient, data: CampaignInput) -> Campaign:
    name = apply_prefix(data.name)
    geo = parse_geo(data.geo)

    try:
        offer = kt.get_offer(data.offer_id)
    except KeitaroError as exc:
        if exc.status_code == 404:
            raise EditorError(f"Оффер {data.offer_id} не найден в Keitaro") from exc
        raise

    kc = kt.create_campaign(
        {
            "name": name,
            "alias": random_alias(),
            "type": "position",  # ротация потоков по позиции: сначала гео, потом офферы
            "state": "active",
            "cost_type": "CPC",
            "cost_value": 0,
            "cost_auto": True,
            "domain_id": data.domain_id,
            "group_id": data.group_id,
            "traffic_source_id": data.traffic_source_id,
        }
    )
    campaign_id = int(kc["id"])

    try:
        kt.create_stream(geo_stream_body(campaign_id, geo))
        kt.create_stream(offers_stream_body(campaign_id, data.offer_id))
    except KeitaroError:
        # Не оставляем в трекере кампанию без потоков.
        try:
            kt.archive_campaign(campaign_id)
        except KeitaroError:
            pass
        raise

    ensure_offer(db, kt, data.offer_id, offer.get("name"))
    return sync_campaign(db, kt, campaign_id, created_by_us=True, domain_id=data.domain_id)
