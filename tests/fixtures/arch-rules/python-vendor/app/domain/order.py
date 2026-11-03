import sqlalchemy
import pytest


class Order:
    def save(self):
        pytest.importorskip("sqlite3")
        return sqlalchemy.text("select 1")
