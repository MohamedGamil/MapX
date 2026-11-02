from app.domain.order import Order
from app.application.internal.pricing_rules import PricingRules
from app.domain.ledger_helper import LedgerHelper
from app.support.clock import Clock


class PlaceOrder:
    def run(self) -> None:
        Order().run()
        PricingRules().run()
        LedgerHelper().run()
        Clock().run()
