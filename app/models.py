"""Локальная копия кампаний Keitaro.

ID кампаний, потоков и офферов совпадают с ID в Keitaro. Своё ID есть только
у привязки «оффер в потоке» (StreamOffer).

У каждой привязки два набора полей:
  * черновик — ``active`` / ``share``: что пользователь видит и меняет в редакторе;
  * опубликовано — ``published_active`` / ``published_share``: что сейчас лежит в Keitaro.
Поток «не опубликован» (жёлтый), если черновик хоть одной привязки
отличается от опубликованного состояния.
"""

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Campaign(Base):
    __tablename__ = "campaigns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    name: Mapped[str] = mapped_column(String(255))
    alias: Mapped[str] = mapped_column(String(64))
    domain_id: Mapped[int | None] = mapped_column(Integer)
    domain_name: Mapped[str | None] = mapped_column(String(255))
    group_id: Mapped[int | None] = mapped_column(Integer)
    traffic_source_id: Mapped[int | None] = mapped_column(Integer)
    created_by_us: Mapped[bool] = mapped_column(Boolean, default=False)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    streams: Mapped[list["Stream"]] = relationship(
        back_populates="campaign",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Stream.position",
    )


class Offer(Base):
    """Справочник офферов Keitaro (только то, что нужно для отображения)."""

    __tablename__ = "offers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    name: Mapped[str] = mapped_column(String(512))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Stream(Base):
    __tablename__ = "streams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    position: Mapped[int] = mapped_column(Integer, default=0)
    type: Mapped[str | None] = mapped_column(String(32))
    schema: Mapped[str | None] = mapped_column(String(32))
    state: Mapped[str | None] = mapped_column(String(32))
    # Поток с офферами — тот, который редактор разбирает и показывает.
    # Остальные потоки храним «как поток», без разбора содержимого.
    has_offers: Mapped[bool] = mapped_column(Boolean, default=False)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    campaign: Mapped[Campaign] = relationship(back_populates="streams")
    offer_links: Mapped[list["StreamOffer"]] = relationship(
        back_populates="stream",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="StreamOffer.id",
    )

    @property
    def is_dirty(self) -> bool:
        return any(link.is_dirty for link in self.offer_links)


class StreamOffer(Base):
    __tablename__ = "stream_offers"
    __table_args__ = (UniqueConstraint("stream_id", "offer_id", name="uq_stream_offer"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("streams.id", ondelete="CASCADE"), index=True)
    offer_id: Mapped[int] = mapped_column(ForeignKey("offers.id"), index=True)

    # Черновик
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    share: Mapped[int] = mapped_column(Integer, default=0)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)

    # Состояние в Keitaro после последнего Fetch / Push
    published_active: Mapped[bool] = mapped_column(Boolean, default=False)
    published_share: Mapped[int] = mapped_column(Integer, default=0)

    # Привязка создана в редакторе и ещё ни разу не публиковалась:
    # Cancel удаляет её из базы целиком (сам оффер в справочнике остаётся).
    is_new: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    stream: Mapped[Stream] = relationship(back_populates="offer_links")
    offer: Mapped[Offer] = relationship(lazy="joined")

    @property
    def is_dirty(self) -> bool:
        if self.active != self.published_active:
            return True
        return self.active and self.share != self.published_share

    @property
    def status(self) -> str:
        """active — в потоке; added — добавлен, ждёт публикации;
        removing — удалён, ждёт публикации; removed — в архиве (серый)."""
        if self.active:
            return "active" if self.published_active else "added"
        return "removing" if self.published_active else "removed"
