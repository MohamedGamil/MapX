import os
import sys as system
from os import environ as env_map, getenv


def port() -> int:
    return int(os.getenv('PORT', '80'))


def args() -> list:
    return system.argv[1:]


def home() -> str:
    return env_map['HOME'] or getenv('HOME', '')
