# Synthetic fixture for M5-17-R1 (mapx arch init --preset fastapi). Not a real application.
from fastapi import FastAPI

from app.core.config import settings
from app.routers import orders

app = FastAPI(title=settings.title)
app.include_router(orders.router)
