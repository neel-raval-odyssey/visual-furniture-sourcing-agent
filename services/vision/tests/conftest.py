"""Shared test setup: no network, synthetic images only, no model weights."""

from __future__ import annotations

import hashlib
import io
import socket
from pathlib import Path

import pytest
from PIL import Image


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("tests must not open network connections")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


def image_bytes(fmt: str = "PNG", size=(32, 24), color=(200, 30, 30), mode="RGB", **save) -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, size, color).save(buffer, format=fmt, **save)
    return buffer.getvalue()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write(path: Path, data: bytes) -> tuple[str, str]:
    path.write_bytes(data)
    return str(path), sha(data)
