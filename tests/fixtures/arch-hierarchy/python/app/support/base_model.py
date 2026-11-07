# Synthetic fixture (M5-09): an intermediate base over a Django model outside the workspace.
from django.db import models

from app.http.mailer import Mailer


class BaseModel(models.Model):
    def notify(self):
        return Mailer()
