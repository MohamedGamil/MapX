# Synthetic fixture for M5-17 (mapx arch init --preset django). Not a real application.
from django.contrib import admin

from shop.models import Order
from shop.views import order_list  # the violation: the admin reaches into a view

admin.site.register(Order)
LISTING = order_list
