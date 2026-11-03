# Synthetic fixture for M5-17-R1 (mapx arch init --preset fastapi). Not a real application.
from fastapi import APIRouter, Depends

from app.dependencies import get_session
from app.models.order import Order
from app.schemas.order import OrderOut
from app.services.orders import place_order

router = APIRouter(prefix="/orders")


@router.post("/", response_model=OrderOut)
def create_order(session=Depends(get_session)):
    return place_order(session)


@router.get("/blank")
def blank_order() -> Order:
    # Allowed (review of M5-17-R1): the full-stack template's routes use the models directly.
    return Order(total=0)
