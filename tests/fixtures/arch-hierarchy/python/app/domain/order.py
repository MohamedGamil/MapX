# Synthetic fixture (M5-09): extends django.db.models.Model through BaseModel.
from app.support.base_model import BaseModel


class Order(BaseModel):
    total = 0

    def pay(self):
        pass
