# Synthetic fixture for M5-17-R1 (mapx arch init --preset fastapi). Not a real application.
from pydantic import BaseModel


class OrderOut(BaseModel):
    total: int
