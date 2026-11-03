# Synthetic fixture for M5-17 (mapx arch init --preset django). Not a real application.
from django.db import models


class Order(models.Model):
    total = models.IntegerField()
