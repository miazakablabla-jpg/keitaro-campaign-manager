VENV   ?= .venv
PYTHON ?= python3
PY      = $(VENV)/bin/python

.PHONY: install demo migrate run test clean

$(PY):
	$(PYTHON) -m venv $(VENV)
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -r requirements.txt

install: $(PY)                       ## виртуальное окружение + зависимости
	@test -f .env || cp .env.example .env

demo: install                        ## эмулятор Keitaro + приложение, без ключа
	$(PY) scripts/demo.py

migrate: install                     ## применить миграции к DATABASE_URL из .env
	$(PY) -m alembic upgrade head

run: migrate                         ## приложение против Keitaro из .env
	$(PY) -m uvicorn app.main:app --reload --port 8000

test: install                        ## тесты
	$(PY) -m pytest -q

clean:
	rm -rf $(VENV) .pytest_cache demo.db
