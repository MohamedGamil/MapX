# Synthetic fixture for M5-17-R1 (mapx arch init --preset django). Not a real application.
# A model outside models.py: only its base, models.Model, puts it in Models.
from django.db import models


class Invoice(models.Model):
    total = models.IntegerField()
