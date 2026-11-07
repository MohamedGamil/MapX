from app.infrastructure.sql_order_repository import SqlOrderRepository
from app.domain.money import Money
from app.domain.ids.order_id import OrderId
from app.domain.ledger_helper import LedgerHelper


class Order:
    def run(self) -> None:
        SqlOrderRepository().run()
        Money().run()
        OrderId().run()
        LedgerHelper().run()
