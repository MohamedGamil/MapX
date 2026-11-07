# Synthetic fixture for M5-17-R1 (mapx arch init --preset fastapi). Not a real application.
# The full-stack template's init_db (review of M5-17-R1): core seeds the database through the
# services and the models.
from app.models.order import Order
from app.services.orders import place_order


def init_db(session) -> Order:
    place_order(session)
    return Order(total=0)
