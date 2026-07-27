import os
import collections.abc as collections_abc
import json, pathlib
import urllib.parse
from pathlib import Path
from package.module import load as load_item, save
from . import sibling
from ..services.worker import run as run_worker
from tools import *
from package.api import (
    fetch as fetch_item,
    publish,
)


def use_imports():
    return Path.cwd(), load_item(), sibling.start(), run_worker()
