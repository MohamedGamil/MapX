# Synthetic fixture for M5-17 (mapx arch init --preset django). Not a real application.
from django.urls import path

from shop.views import order_list

urlpatterns = [path('orders/', order_list)]
