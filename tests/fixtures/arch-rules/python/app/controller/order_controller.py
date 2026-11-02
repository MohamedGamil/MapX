from app.application.place_order import PlaceOrder
from app.controller.base_controller import BaseController
from app.domain.order import Order
from app.application.internal.pricing_rules import PricingRules


class OrderController:
    def run(self) -> None:
        PlaceOrder().run()
        BaseController().run()
        Order().run()
        PricingRules().run()
