"""Structured JSON request validation for the `embed` command.

The request comes from the TypeScript shortlist command, which has already
validated the case, manifest and evidence paths. This module rejects anything
that does not match the expected shape instead of guessing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import PROTOCOL, PROTOCOL_VERSION

MODEL_ID = re.compile(r"^google/siglip2-[a-z0-9][a-z0-9.\-]*$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ITEM_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-]{0,199}$")
REVISION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-/]{0,99}$")
DEVICES = ("auto", "mps", "cpu")
MAX_GROUPS = 200
MAX_IMAGES_PER_GROUP = 20


class RequestError(ValueError):
    pass


@dataclass(frozen=True)
class ImageSpec:
    ref: str
    path: str
    sha256: str


@dataclass(frozen=True)
class GroupSpec:
    id: str
    images: tuple[ImageSpec, ...]


@dataclass(frozen=True)
class EmbedRequest:
    model_id: str
    revision: str | None
    device: str
    reference_id: str
    reference: ImageSpec
    groups: tuple[GroupSpec, ...]


def _obj(value: object, where: str, keys: set[str], optional: set[str] = frozenset()) -> dict:
    if not isinstance(value, dict):
        raise RequestError(f"{where} must be an object")
    unknown = set(value) - keys - optional
    if unknown:
        raise RequestError(f"{where} has unknown keys: {', '.join(sorted(unknown))}")
    missing = keys - set(value)
    if missing:
        raise RequestError(f"{where} is missing: {', '.join(sorted(missing))}")
    return value


def _str(value: object, where: str, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value:
        raise RequestError(f"{where} must be a non-empty string")
    if pattern and not pattern.fullmatch(value):
        raise RequestError(f"{where} has an invalid format")
    return value


def _image(value: object, where: str, with_ref: bool) -> ImageSpec:
    keys = {"path", "sha256"} | ({"ref"} if with_ref else set())
    o = _obj(value, where, keys)
    path = _str(o["path"], f"{where}.path")
    if not path.startswith("/") or "\x00" in path:
        raise RequestError(f"{where}.path must be an absolute path")
    ref = _str(o["ref"], f"{where}.ref") if with_ref else "reference"
    return ImageSpec(ref=ref, path=path, sha256=_str(o["sha256"], f"{where}.sha256", SHA256))


def parse_request(raw: object) -> EmbedRequest:
    o = _obj(raw, "request", {"protocol", "protocolVersion", "model", "device", "reference", "groups"})
    if o["protocol"] != PROTOCOL or o["protocolVersion"] != PROTOCOL_VERSION:
        raise RequestError(f"unsupported protocol (expected {PROTOCOL} v{PROTOCOL_VERSION})")
    model = _obj(o["model"], "model", {"id", "revision"})
    model_id = _str(model["id"], "model.id", MODEL_ID)
    revision = None if model["revision"] is None else _str(model["revision"], "model.revision", REVISION)
    device = o["device"]
    if device not in DEVICES:
        raise RequestError(f"device must be one of {', '.join(DEVICES)}")
    ref = _obj(o["reference"], "reference", {"id", "path", "sha256"})
    reference_id = _str(ref["id"], "reference.id", ITEM_ID)
    reference = _image({"path": ref["path"], "sha256": ref["sha256"]}, "reference", with_ref=False)

    groups_raw = o["groups"]
    if not isinstance(groups_raw, list) or not groups_raw:
        raise RequestError("groups must be a non-empty list")
    if len(groups_raw) > MAX_GROUPS:
        raise RequestError(f"at most {MAX_GROUPS} groups are allowed")
    groups: list[GroupSpec] = []
    seen: set[str] = set()
    for i, g in enumerate(groups_raw):
        go = _obj(g, f"groups[{i}]", {"id", "images"})
        gid = _str(go["id"], f"groups[{i}].id", ITEM_ID)
        if gid in seen:
            raise RequestError(f"groups[{i}].id is duplicated")
        seen.add(gid)
        imgs = go["images"]
        if not isinstance(imgs, list) or not imgs or len(imgs) > MAX_IMAGES_PER_GROUP:
            raise RequestError(f"groups[{i}].images must list 1-{MAX_IMAGES_PER_GROUP} images")
        groups.append(
            GroupSpec(gid, tuple(_image(x, f"groups[{i}].images[{j}]", with_ref=True) for j, x in enumerate(imgs)))
        )
    return EmbedRequest(model_id, revision, device, reference_id, reference, tuple(groups))
