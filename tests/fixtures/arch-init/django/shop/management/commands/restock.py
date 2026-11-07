# Synthetic fixture for M5-17 (mapx arch init --preset django). Not a real application.
from shop.models import Order


class Command:
    def handle(self):
        return Order.objects.count()
