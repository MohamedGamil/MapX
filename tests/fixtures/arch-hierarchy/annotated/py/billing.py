# Synthetic fixture for M5-17-R1 (review): bases named through import aliases, and a decorated class.
from dataclasses import dataclass

from django.db import models as m
from django.db.models import Model as DM


class Invoice(DM):
    pass


class Refund(m.Model):
    pass


@dataclass
class Credit(DM):
    pass
