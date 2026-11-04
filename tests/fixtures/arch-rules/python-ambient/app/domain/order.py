# Synthetic (M5-24-R1): ambient access, labelled in expected-externals.json.
import os


class Order:
    def currency(self) -> str:
        return os.environ['CURRENCY']
