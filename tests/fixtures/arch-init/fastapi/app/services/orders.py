# Synthetic fixture for M5-17-R1 (mapx arch init --preset fastapi). Not a real application.
from app.models.order import Order
from app.schemas.order import OrderOut


def place_order(session):
    order = Order(total=1)
    return OrderOut(total=order.total)
