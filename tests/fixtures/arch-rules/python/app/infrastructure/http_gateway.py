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
