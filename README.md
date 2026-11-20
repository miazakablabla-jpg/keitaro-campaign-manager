# Keitaro campaign manager

Обёртка над [Keitaro Admin API](https://admin-api.docs.keitaro.io/) на **FastAPI + SQLAlchemy 2 + Alembic**. Фронт написан на HTML и jQuery (с jQuery UI Autocomplete).

1. **Создание кампании.** На входе название, гео и оффер. Приложение создаёт в Keitaro кампанию с доменом, группой и источником и два потока:
   * **Flow 1:** фильтр «Страна, принимать» по указанному гео, редирект на `https://google.com`;
   * **Flow 2:** без фильтров, выбранный оффер на 100%.
2. **Редактор существующей кампании.** Добавляет и удаляет офферы в потоках, пересчитывает и закрепляет веса, публикует правки в Keitaro (Push) и откатывает их (Cancel). Логика повторяет обёртку из видео, подробности ниже.

В комплекте есть **эмулятор Keitaro** (`fake_keitaro/`). С ним проект запускается и тестируется без настоящего трекера и ключа.

---

## Быстрый старт

Нужен Python 3.11 или новее.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env        # впишите KEITARO_URL и KEITARO_API_KEY
alembic upgrade head        # создаст таблицы (SQLite по умолчанию)
uvicorn app.main:app --reload --port 8000
```

Интерфейс открывается на http://localhost:8000, Swagger на http://localhost:8000/docs.

### Настройки (`.env`)

| Переменная | По умолчанию | Что это |
|---|---|---|
| `KEITARO_URL` | `http://127.0.0.1:8001` | Адрес трекера, можно без `/admin_api/v1` |
| `KEITARO_API_KEY` | `fake-key` | Ключ из «Профиль → API ключи» |
| `DATABASE_URL` | `sqlite:///./keitaro_manager.db` | Любой URL SQLAlchemy, например Postgres: `postgresql+psycopg://…` (нужно доустановить `psycopg[binary]`) |
| `GEO_REDIRECT_URL` | `https://google.com` | Куда первый поток отправляет посетителей из выбранного гео |
| `OFFERS_CACHE_TTL` | `60` | Сколько секунд кэшируется список офферов для автокомплита |

### Запуск без настоящего Keitaro

```bash
# терминал 1: эмулятор Admin API с демо-кампанией из видео (AU → google, 3 оффера)
uvicorn fake_keitaro.app:app --port 8001

# терминал 2: приложение (KEITARO_URL=http://127.0.0.1:8001, KEITARO_API_KEY=fake-key)
uvicorn app.main:app --reload --port 8000
```

Удаление офферов прямо в Keitaro можно сымитировать служебной ручкой эмулятора:

```bash
curl -X POST http://127.0.0.1:8001/admin_api/v1/_debug/streams/102/offers \
  -H 'Api-Key: fake-key' -H 'Content-Type: application/json' \
  -d '{"offers":[{"offer_id":3717,"share":100}]}'
```

### Миграции

```bash
alembic upgrade head                                  # применить
alembic revision --autogenerate -m "что поменялось"   # после правок в app/models.py
alembic downgrade -1                                  # откатить последнюю
```

URL базы Alembic берёт из `DATABASE_URL`, см. `alembic/env.py`.

### Тесты

```bash
pytest -q
```

Тесты гоняют весь сценарий из видео через HTTP API приложения. Вместо Keitaro подставлен эмулятор, сеть не нужна.

---

## Как работает редактор

1. Выберите кампанию в списке (он загружается из Keitaro) и нажмите **Fetch streams**.
2. Потоки с офферами разбираются и показываются с весами. Потоки без офферов (например, гео-редирект на google) сохраняются только как поток, их содержимое не разбирается.

| Действие | Что происходит |
|---|---|
| **Add** | Поиск оффера по ID или названию (автокомплит → `/api/offers/search` → `GET /offers` в Keitaro). Оффер добавляется, веса пересчитываются, поток становится **жёлтым** (не опубликован). В Keitaro пока ничего не меняется |
| **Remove** | Оффер становится серым, его вес 0%, остальные веса пересчитываются, поток жёлтый |
| **Push to Keitaro** | `PUT /streams/{id}` с активными офферами и их весами. Затем поток перечитывается из Keitaro, и база приводится к тому, что реально сохранилось в трекере |
| **Cancel** | Откат неопубликованных правок. Офферы, добавленные после последней публикации, отвязываются от потока (сам оффер в справочнике `offers` остаётся). Удалённые возвращаются, веса становятся как в Keitaro, поток снова белый |
| **Bring back** | Возвращает оффер из архива, поток жёлтый |
| **📌 (закрепить вес)** | Закреплённый вес не меняется при добавлениях и удалениях. Остаток `100 − Σзакреплённых` делится поровну между остальными офферами. Закреплённое число можно поменять прямо в поле |
| **Fetch streams повторно** | Офферы, о которых обёртка знала, но которых больше нет в Keitaro, **не удаляются**, а уходят в архив (`removed`, серые) с кнопкой Bring back. Fetch приводит черновик к состоянию Keitaro |

**Веса** всегда целые и в сумме дают 100: 3 оффера → 34/33/33, 4 → 25/25/25/25, закреплённый 25% + 2 оффера → 25/38/37. Push запрещён, если в потоке нет активных офферов или сумма не равна 100 (такое бывает, если закрепить все веса). Закрепить веса больше чем на 100% нельзя.

### Модель данных

```
campaigns      id = ID в Keitaro, name, alias, domain, group, source
streams        id = ID в Keitaro, campaign_id, name, position, schema, has_offers
offers         id = ID в Keitaro, name — локальный справочник офферов
stream_offers  привязка «оффер в потоке»:
                 active / share            — черновик (что видно в редакторе)
                 published_active / _share — что сейчас лежит в Keitaro
                 pinned                    — вес закреплён
                 is_new                    — ещё не публиковался (Cancel удалит привязку)
```

Поток «жёлтый», если черновик хотя бы одной привязки отличается от опубликованного состояния. Статус оффера в UI определяется так:

| | опубликован | не опубликован |
|---|---|---|
| **активен в черновике** | `active` | `added` |
| **не активен** | `removing` | `removed` (архив) |

### Что уходит в Keitaro при создании кампании

```jsonc
POST /campaigns   {"name", "alias": <6 случайных символов>, "type": "position",
                   "domain_id", "group_id", "traffic_source_id", "cost_type": "CPC", ...}
POST /streams     {"campaign_id", "type": "regular", "name": "Geo MX,AU → Google", "position": 1,
                   "schema": "redirect", "action_type": "http", "action_payload": "https://google.com",
                   "filters": [{"name": "country", "mode": "accept", "payload": ["MX","AU"]}]}
POST /streams     {"campaign_id", "type": "regular", "name": "Offers", "position": 2,
                   "schema": "landings", "action_type": "http",
                   "offers": [{"offer_id": 3749, "share": 100, "state": "active"}]}
```

Если создание потока упало, кампания отправляется в архив (`DELETE /campaigns/{id}`), чтобы в трекере не остался «огрызок».

## Структура

```
app/
  main.py             FastAPI, статика, обработчики ошибок
  config.py           настройки из .env
  db.py, models.py    SQLAlchemy
  keitaro.py          клиент Admin API (httpx)
  schemas.py          ответы API
  api/routes.py       HTTP-ручки
  services/
    creator.py        часть 1: кампания + 2 потока
    editor.py         часть 2: Fetch / Add / Remove / Bring back / Pin / Cancel / Push
    weights.py        пересчёт весов
    offers.py         кэш и поиск офферов, локальный справочник
  static/             index.html + app.js (jQuery) + app.css
alembic/              миграции
fake_keitaro/app.py   эмулятор Keitaro Admin API
tests/                pytest
```

## API

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/refs` | домены, группы кампаний, источники |
| POST | `/api/refs/groups`, `/api/refs/sources` | создать группу или источник `{name}` |
| GET | `/api/offers/search?q=` | автокомплит офферов |
| POST | `/api/campaigns` | создать кампанию `{name, geo, offer_id, domain_id, group_id, traffic_source_id}` |
| GET | `/api/keitaro/campaigns` | кампании из трекера |
| GET | `/api/campaigns/{id}` | кампания из локальной базы |
| POST | `/api/campaigns/{id}/fetch` | Fetch streams |
| POST | `/api/streams/{id}/offers` | Add `{offer_id}` |
| POST | `/api/streams/{id}/cancel` | Cancel |
| POST | `/api/streams/{id}/push` | Push |
| POST | `/api/stream-offers/{id}/remove` | Remove |
| POST | `/api/stream-offers/{id}/restore` | Bring back |
| POST | `/api/stream-offers/{id}/pin` | закрепить `{share?}` |
| POST | `/api/stream-offers/{id}/unpin` | открепить |

## Допущения о Keitaro API

В OpenAPI-спецификации Keitaro не описаны три вещи. Сделано по тому, как ведёт себя трекер:
* фильтр по стране называется `country`, режим `accept`, в `payload` передаётся список ISO-кодов;
* `action_type: "http"` означает обычный HTTP-редирект;
* `PUT /streams/{id}` с массивом `offers` **заменяет** список офферов потока целиком.

После Push обёртка перечитывает поток и сверяет результат с отправленным. Если Keitaro сохранил что-то другое, в интерфейсе появится предупреждение.
