# Synthetic fixture for M5-17-R1 (mapx arch init --preset fastapi). Not a real application.
from app.core.config import settings


def get_session():
    return settings.database_url
