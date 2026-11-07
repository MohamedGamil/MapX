# Synthetic (M5-22-R1): package attribution through requirements files alone (no lockfile), labelled in expected-externals.json.
import os
import requests
import yaml
import pytest
from PIL import Image
import acme_missing


class Gateway:
    def fetch(self, url):
        os.getcwd()
        return requests.get(url)
