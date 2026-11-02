from app.shared.result import Result
from app.domain.audit_trail import AuditTrail


class CancelOrder:
    def run(self) -> None:
        Result().run()
        AuditTrail().run()
