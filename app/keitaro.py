"""Тонкий клиент Keitaro Admin API v1 (https://admin-api.docs.keitaro.io/)."""

from typing import Any

import httpx

from app.config import Settings, get_settings


class KeitaroError(Exception):
    def __init__(self, message: str, status_code: int | None = None, payload: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class KeitaroClient:
    def __init__(self, settings: Settings | None = None, http: httpx.Client | None = None):
        settings = settings or get_settings()
        base = settings.keitaro_url.rstrip("/")
        if not base.endswith("/admin_api/v1"):
            base += "/admin_api/v1"
        self._http = http or httpx.Client(timeout=settings.keitaro_timeout)
        self._base = base
        self._headers = {"Api-Key": settings.keitaro_api_key, "Accept": "application/json"}

    # --- низкий уровень -------------------------------------------------
    def _request(self, method: str, path: str, **kwargs) -> Any:
        url = f"{self._base}/{path.lstrip('/')}"
        try:
            resp = self._http.request(method, url, headers=self._headers, **kwargs)
        except httpx.HTTPError as exc:
            raise KeitaroError(f"Keitaro недоступен: {exc}") from exc
        if resp.status_code >= 400:
            try:
                payload = resp.json()
            except ValueError:
                payload = resp.text
            raise KeitaroError(
                f"Keitaro {method} /{path.lstrip('/')} → {resp.status_code}: {_error_text(payload)}",
                status_code=resp.status_code,
                payload=payload,
            )
        if not resp.content:
            return None
        return resp.json()

    # --- справочники ----------------------------------------------------
    def list_domains(self) -> list[dict]:
        return self._request("GET", "domains")

    def list_campaign_groups(self) -> list[dict]:
        return self._request("GET", "groups", params={"type": "campaigns"})

    def create_campaign_group(self, name: str) -> dict:
        return self._request("POST", "groups", json={"name": name, "type": "campaigns"})

    def list_traffic_sources(self) -> list[dict]:
        return self._request("GET", "traffic_sources")

    def create_traffic_source(self, name: str) -> dict:
        return self._request("POST", "traffic_sources", json={"name": name})

    def list_offers(self) -> list[dict]:
        return self._request("GET", "offers")

    def get_offer(self, offer_id: int) -> dict:
        return self._request("GET", f"offers/{offer_id}")

    # --- кампании -------------------------------------------------------
    def list_campaigns(self) -> list[dict]:
        return self._request("GET", "campaigns")

    def get_campaign(self, campaign_id: int) -> dict:
        return self._request("GET", f"campaigns/{campaign_id}")

    def create_campaign(self, body: dict) -> dict:
        return self._request("POST", "campaigns", json=body)

    def archive_campaign(self, campaign_id: int) -> None:
        self._request("DELETE", f"campaigns/{campaign_id}")

    # --- потоки ---------------------------------------------------------
    def list_streams(self, campaign_id: int) -> list[dict]:
        return self._request("GET", f"campaigns/{campaign_id}/streams")

    def get_stream(self, stream_id: int) -> dict:
        return self._request("GET", f"streams/{stream_id}")

    def create_stream(self, body: dict) -> dict:
        return self._request("POST", "streams", json=body)

    def update_stream(self, stream_id: int, body: dict) -> dict:
        return self._request("PUT", f"streams/{stream_id}", json=body)


def _error_text(payload: Any) -> str:
    if isinstance(payload, dict):
        for key in ("error", "message", "errors", "detail"):
            if key in payload:
                return str(payload[key])
    return str(payload)[:500]


def get_keitaro() -> KeitaroClient:
    return KeitaroClient()
