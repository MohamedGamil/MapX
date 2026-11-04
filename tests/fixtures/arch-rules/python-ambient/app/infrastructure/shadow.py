# None of these is ambient: os is a parameter, sys a local, environ an attribute of an object, and a
# comment or a string only names it (os.environ, sys.argv).
import os
import sys


def param(os: dict) -> str:
    return os.environ


def local() -> str:
    sys = type('S', (), {'argv': []})
    return str(sys.argv)


class Probe:
    environ = {}

    def read(self) -> dict:
        return self.environ


def text() -> str:
    return 'os.environ and sys.argv'
