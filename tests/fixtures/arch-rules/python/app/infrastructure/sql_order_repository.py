from app.domain.order import Order


class SqlOrderRepository:
    def run(self) -> None:
        Order().run()
