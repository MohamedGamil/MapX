# Synthetic fixture (M5-10 review): docstring literal blocks, doctests, comments between decorators.


@app.route("/x")
# a comment between decorators
@functools.lru_cache(maxsize=None)
def handler():
    """Handle.

    Example::

        @internal
        def g(): pass

    >>> handler()
    @internal

    .. deprecated:: 2.0
       Use other.
    """
