from app.domain.order import Order
from app.support.uuid import Uuid


class MailGateway:
    def run(self) -> None:
        Order().run()
        Uuid().run()
