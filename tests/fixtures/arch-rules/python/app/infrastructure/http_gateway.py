# Synthetic (M5-19): references to modules outside the workspace, labelled in expected-externals.json.
import os
import os.path as osp
from flask import Flask, request
from requests.adapters import HTTPAdapter
import sqlalchemy
from app.domain.missing import Gone


class HttpGateway(Flask):
    def run(self) -> None:
        HTTPAdapter()
        sqlalchemy.create_engine('sqlite://')
        os.getenv('HOME')
        osp.join('a', 'b')
        # M5-22: package attribution (pip/Poetry/uv), labelled in expected-externals.json.
        yaml.safe_load('a: 1')
        Image.new('RGB', (1, 1))
        json.dumps({})


import json
import tomllib
from collections import OrderedDict
import yaml
from PIL import Image
import jinja2
from markupsafe import Markup
import urllib3
import socks
import pytest
from pluggy import HookspecMarker
import sklearn
import acme_missing
