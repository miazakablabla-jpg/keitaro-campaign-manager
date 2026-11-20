from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Адрес трекера без /admin_api/v1, например https://tracker.example.com
    keitaro_url: str = "http://127.0.0.1:8001"
    keitaro_api_key: str = "fake-key"
    keitaro_timeout: float = 20.0

    database_url: str = "sqlite:///./keitaro_manager.db"

    # Куда первый поток отправляет посетителей из выбранного гео
    geo_redirect_url: str = "https://google.com"
    # Сколько секунд держать в памяти список офферов для автокомплита
    offers_cache_ttl: int = 60
    # Часовой пояс отчётов; пусто — часовой пояс, настроенный в самом трекере
    report_timezone: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
