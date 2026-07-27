from .worker import run as execute
import app.tools as tools
import app.worker
from . import service
from app import exported
from .missing import absent
import requests


def local():
    return "local"


def start():
    return [
        local(),
        execute(),
        tools.multiply(2, 3),
        app.worker.run(),
        service.Service(),
        exported(),
        absent(),
        requests.get("https://example.test"),
    ]
