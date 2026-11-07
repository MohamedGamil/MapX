# Synthetic fixture for M5-17 (mapx arch init --preset django). Not a real application.
from shop.models import Order


class OrderSerializer:
    model = Order
