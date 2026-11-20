import os

# Тесты не должны зависеть от локального .env (настоящий трекер, префикс и т. п.):
# переменные окружения важнее файла .env.
os.environ.update(
    KEITARO_URL="http://keitaro.test",
    KEITARO_API_KEY="fake-key",
    DATABASE_URL="sqlite://",
    CAMPAIGN_PREFIX="",
    REPORT_TIMEZONE="",
    GEO_REDIRECT_URL="https://google.com",
)

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import Settings, get_settings
from app.db import Base, get_db
from app.keitaro import KeitaroClient, get_keitaro
from app.main import app
from app.services.offers import catalog
from fake_keitaro.app import app as fake_app
from fake_keitaro.app import store


get_settings.cache_clear()


@pytest.fixture()
def prefix():
    """Включает правило именования test_me_ на время теста."""
    os.environ["CAMPAIGN_PREFIX"] = "test_me_"
    get_settings.cache_clear()
    yield "test_me_"
    os.environ["CAMPAIGN_PREFIX"] = ""
    get_settings.cache_clear()


@pytest.fixture()
def fake():
    store.reset()
    catalog.reset()
    return store


@pytest.fixture()
def kt(fake):
    """Клиент, который ходит в эмулятор Keitaro без сети."""
    settings = Settings(keitaro_url="http://keitaro.test", keitaro_api_key="fake-key")
    return KeitaroClient(settings, http=TestClient(fake_app))


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    yield Session
    engine.dispose()


@pytest.fixture()
def client(kt, db_session):
    def _db():
        db = db_session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_keitaro] = lambda: kt
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
