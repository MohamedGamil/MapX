# Synthetic fixture for M5-17 (mapx arch init --preset django). Not a real application.
from django import forms

from shop.models import Order


class OrderForm(forms.ModelForm):
    class Meta:
        model = Order
        fields = ['total']
