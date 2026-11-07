# Synthetic fixture for M5-17-R1 (mapx arch init --preset django). Not a real application.
# Class-based views outside views.py: only their bases (Django's View, a generic view) put them in Views.
from django.views import View
from django.views.generic import ListView

from shop.billing import Invoice


class InvoiceList(ListView):
    model = Invoice


class InvoiceTotal(View):
    def get(self, request):
        return sum(i.total for i in Invoice.objects.all())
