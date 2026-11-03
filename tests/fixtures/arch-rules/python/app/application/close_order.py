from app.domain._journal import Journal
from app.domain.rounding import round_amount, _round_half_even


class CloseOrder:
    def run(self) -> None:
        Journal().record()
        round_amount(1)
        _round_half_even(1)
