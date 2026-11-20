"""Справочник офферов: поиск для автокомплита и локальная копия названий."""

import threading
import time

from sqlalchemy.orm import Session

from app.config import get_settings
from app.keitaro import KeitaroClient, KeitaroError
from app.models import Offer


class OfferCatalog:
    """Кэш GET /offers. В API нет поиска и пагинации, поэтому фильтруем сами."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._offers: list[dict] = []
        self._loaded_at = 0.0

    def all(self, kt: KeitaroClient, force: bool = False) -> list[dict]:
        ttl = get_settings().offers_cache_ttl
        with self._lock:
            if force or not self._offers or time.monotonic() - self._loaded_at > ttl:
                self._offers = [o for o in kt.list_offers() if _is_usable(o)]
                self._loaded_at = time.monotonic()
            return self._offers

    def search(self, kt: KeitaroClient, q: str, limit: int = 20) -> list[dict]:
        q = q.strip()
        offers = self.all(kt)
        if not q:
            return [_short(o) for o in offers[:limit]]
        needle = q.casefold()
        exact, by_id, by_name = [], [], []
        for o in offers:
            oid = str(o["id"])
            if oid == q:
                exact.append(o)
            elif oid.startswith(q):
                by_id.append(o)
            elif needle in str(o.get("name", "")).casefold():
                by_name.append(o)
        return [_short(o) for o in (exact + by_id + by_name)[:limit]]

    def name_of(self, kt: KeitaroClient, offer_id: int) -> str | None:
        for force in (False, True):
            for o in self.all(kt, force=force):
                if o["id"] == offer_id:
                    return o.get("name")
        return None

    def reset(self) -> None:
        with self._lock:
            self._offers = []
            self._loaded_at = 0.0


catalog = OfferCatalog()


def _is_usable(o: dict) -> bool:
    return o.get("state", "active") != "deleted" and not o.get("archive")


def _short(o: dict) -> dict:
    return {"id": o["id"], "name": o.get("name") or f"Offer #{o['id']}"}


def ensure_offer(db: Session, kt: KeitaroClient, offer_id: int, name: str | None = None) -> Offer:
    """Создаёт или обновляет оффер в локальном справочнике."""
    offer = db.get(Offer, offer_id)
    if name is None and (offer is None or offer.name.startswith("Offer #")):
        try:
            name = catalog.name_of(kt, offer_id)
        except KeitaroError:
            name = None
    if offer is None:
        offer = Offer(id=offer_id, name=name or f"Offer #{offer_id}")
        db.add(offer)
        db.flush()  # чтобы следующий db.get в той же сессии нашёл оффер
    elif name and offer.name != name:
        offer.name = name
    return offer
