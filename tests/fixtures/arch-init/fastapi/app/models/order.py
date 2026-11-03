# Synthetic fixture for M5-17-R1 (mapx arch init --preset fastapi). Not a real application.
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

from app.routers.orders import router  # the violation: a model reaches up into a router


class Base(DeclarativeBase):
    pass


class Order(Base):
    __tablename__ = "orders"
    total: int


ROUTER = router
URL = settings.database_url
