# Synthetic (M5-22-R1): package attribution through poetry.lock, labelled in expected-externals.json.
import os
import requests
import yaml
import urllib3
import pytest
from pluggy import HookspecMarker
import acme_missing


class Gateway:
    def fetch(self, url):
        os.getcwd()
        return requests.get(url)
