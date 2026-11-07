# Synthetic (M5-22-R1): legacy Poetry attribution, labelled in expected-externals.json.
import requests
import urllib3
import pytest
from pluggy import HookspecMarker


class Gateway:
    def fetch(self, url):
        return requests.get(url)
