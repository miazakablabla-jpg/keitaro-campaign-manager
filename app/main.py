from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.keitaro import KeitaroError
from app.services.editor import EditorError, NotFound
from app.services.stats import StatsError
from app.services.weights import WeightsError

STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Keitaro campaign manager")
app.include_router(router)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


@app.exception_handler(EditorError)
@app.exception_handler(WeightsError)
@app.exception_handler(StatsError)
def _bad_request(_: Request, exc: Exception):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(NotFound)
def _not_found(_: Request, exc: NotFound):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(KeitaroError)
def _keitaro(_: Request, exc: KeitaroError):
    # 404 из трекера отдаём как 404, остальное — как ошибку шлюза.
    status = 404 if exc.status_code == 404 else 502
    return JSONResponse(status_code=status, content={"detail": str(exc)})
