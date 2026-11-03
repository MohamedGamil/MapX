# Synthetic fixture for M5-17 (mapx arch init --preset django). Not a real application.
from shop.forms import OrderForm
from shop.models import Order


def order_list(request):
    return Order.objects.all()


def order_new(request):
    return OrderForm()
