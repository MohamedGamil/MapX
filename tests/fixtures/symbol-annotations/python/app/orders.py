# Synthetic fixture (M5-10): Python decorators and docstring tags on symbols.
from dataclasses import dataclass


@dataclass(frozen=True)
class Order:
    """An order.

    .. deprecated:: 2.0
       Use OrderV2.

    @internal
    """

    @app.route("/orders/<id>",
               methods=["GET"])
    @staticmethod
    def run(order_id):
        '''Runs it.

        .. versionadded:: 1.5
        '''
        return order_id

    def plain(self):
        return 1


@typing_extensions.deprecated("use run_v2")
def run_legacy():
    """No tags here."""
    return 0
