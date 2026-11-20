"""Демо одной командой: эмулятор Keitaro (:8001) + приложение (:8000).

    python scripts/demo.py        # или: make demo

Демо-режим не трогает .env и вашу основную базу: используется отдельный
файл demo.db, а адрес и ключ Keitaro подменяются на эмулятор.
Ctrl+C останавливает оба процесса.
"""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_PORT = os.environ.get("APP_PORT", "8000")
FAKE_PORT = os.environ.get("FAKE_PORT", "8001")


def main() -> int:
    env = {
        **os.environ,
        "KEITARO_URL": f"http://127.0.0.1:{FAKE_PORT}",
        "KEITARO_API_KEY": "fake-key",
        "FAKE_KEITARO_KEY": "fake-key",
        "DATABASE_URL": "sqlite:///./demo.db",
        # В эмуляторе нет чужих кампаний — правило префикса не включаем, иначе демо-кампания будет только для чтения.
        "CAMPAIGN_PREFIX": os.environ.get("DEMO_CAMPAIGN_PREFIX", ""),
    }
    py = sys.executable

    # Эмулятор хранит данные в памяти, поэтому демо-базу начинаем с чистого листа.
    (ROOT / "demo.db").unlink(missing_ok=True)
    subprocess.run([py, "-m", "alembic", "upgrade", "head"], cwd=ROOT, env=env, check=True)

    procs = [
        subprocess.Popen([py, "-m", "uvicorn", "fake_keitaro.app:app", "--port", FAKE_PORT], cwd=ROOT, env=env),
        subprocess.Popen([py, "-m", "uvicorn", "app.main:app", "--port", APP_PORT], cwd=ROOT, env=env),
    ]
    time.sleep(1.5)
    print(f"\n  Приложение:      http://127.0.0.1:{APP_PORT}")
    print(f"  Swagger:         http://127.0.0.1:{APP_PORT}/docs")
    print(f"  Эмулятор Keitaro: http://127.0.0.1:{FAKE_PORT}/docs")
    print("  Ctrl+C — остановить\n")

    try:
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            if p.poll() is None:
                p.send_signal(signal.SIGINT)
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
    failed = [p.returncode for p in procs if p.returncode and p.returncode > 0]
    return failed[0] if failed else 0


if __name__ == "__main__":
    sys.exit(main())
