from datetime import datetime, timezone

from pydantic import BaseModel, Field

from app.models import Campaign, Stream, StreamOffer
from app.services.editor import is_editable


class CampaignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    geo: str | list[str] = Field(description="Коды стран: 'MX,AU,RO' или ['MX','AU']")
    offer_id: int
    domain_id: int
    group_id: int
    traffic_source_id: int


class AddOffer(BaseModel):
    offer_id: int


class PinOffer(BaseModel):
    share: int | None = Field(default=None, ge=0, le=100)


class NameIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class LinkOut(BaseModel):
    id: int
    offer_id: int
    offer_name: str
    share: int
    published_share: int
    pinned: bool
    status: str  # active | added | removing | removed

    @classmethod
    def of(cls, link: StreamOffer) -> "LinkOut":
        return cls(
            id=link.id,
            offer_id=link.offer_id,
            offer_name=link.offer.name,
            share=link.share,
            published_share=link.published_share,
            pinned=link.pinned,
            status=link.status,
        )


class StreamOut(BaseModel):
    id: int
    name: str
    position: int
    type: str | None
    schema_: str | None = Field(serialization_alias="schema")
    state: str | None
    has_offers: bool
    is_dirty: bool
    total_share: int
    offers: list[LinkOut]

    @classmethod
    def of(cls, s: Stream) -> "StreamOut":
        return cls(
            id=s.id,
            name=s.name,
            position=s.position,
            type=s.type,
            schema_=s.schema,
            state=s.state,
            has_offers=s.has_offers,
            is_dirty=s.is_dirty,
            total_share=sum(link.share for link in s.offer_links if link.active),
            offers=[LinkOut.of(link) for link in s.offer_links],
        )


class CampaignOut(BaseModel):
    id: int
    name: str
    alias: str
    url: str | None
    domain_id: int | None
    group_id: int | None
    traffic_source_id: int | None
    synced_at: datetime | None
    streams: list[StreamOut]
    editable: bool = True
    warnings: list[str] = []

    @classmethod
    def of(cls, c: Campaign, warnings: list[str] | None = None) -> "CampaignOut":
        return cls(
            id=c.id,
            name=c.name,
            alias=c.alias,
            url=campaign_url(c.domain_name, c.alias),
            domain_id=c.domain_id,
            group_id=c.group_id,
            traffic_source_id=c.traffic_source_id,
            # SQLite не хранит часовой пояс; в базу всегда пишем UTC.
            synced_at=c.synced_at.replace(tzinfo=timezone.utc) if c.synced_at and not c.synced_at.tzinfo else c.synced_at,
            streams=[StreamOut.of(s) for s in c.streams],
            editable=is_editable(c),
            warnings=warnings or [],
        )


def campaign_url(domain: str | None, alias: str) -> str | None:
    if not domain or not alias:
        return None
    base = domain if domain.startswith(("http://", "https://")) else f"https://{domain}"
    return f"{base.rstrip('/')}/{alias}"
