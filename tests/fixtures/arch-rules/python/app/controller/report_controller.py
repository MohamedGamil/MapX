from app.application.cancel_order import CancelOrder
from app.controller.base_controller import BaseController
from app.infrastructure.sql_order_repository import SqlOrderRepository
from app.application.internal.tax_rules import TaxRules


class ReportController:
    def run(self) -> None:
        CancelOrder().run()
        BaseController().run()
        SqlOrderRepository().run()
        TaxRules().run()
