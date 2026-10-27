"""Command line entry point.

    python -m vfsa_vision embed        < request.json   # JSON result on stdout
    python -m vfsa_vision environment [--model ID]       # no weights loaded
    python -m vfsa_vision download --model ID            # explicit setup step (network)

`embed` and `environment` run with the Hugging Face hub forced offline.
Machine-readable output goes to stdout; diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from . import DEFAULT_MODEL_ID, PROTOCOL, PROTOCOL_VERSION

EXIT_OK = 0
EXIT_INPUT = 1
EXIT_REQUEST = 2
EXIT_MODEL = 3
EXIT_INTERNAL = 4


class Embedder(Protocol):
    model_id: str
    revision: str
    device: str
    device_reason: str
    requested_device: str
    architecture: str
    model_type: str
    versions: dict

    def preprocessing(self) -> dict: ...

    def embed(self, images: list[Any]) -> list[list[float]]: ...


EmbedderFactory = Callable[[str, "str | None", str], Embedder]


def _force_offline() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def _error(code: str, message: str, **extra: Any) -> dict:
    return {
        "protocol": PROTOCOL,
        "protocolVersion": PROTOCOL_VERSION,
        "status": "error",
        "error": {"code": code, "message": message, **extra},
    }


def default_embedder_factory(cache_dir: Path | None = None) -> EmbedderFactory:
    def factory(model_id: str, revision: str | None, device: str) -> Embedder:
        from .model import DEFAULT_CACHE_DIR, SiglipImageEmbedder

        return SiglipImageEmbedder(model_id, revision, device, cache_dir or DEFAULT_CACHE_DIR)

    return factory


def run_embed(raw: object, factory: EmbedderFactory) -> tuple[int, dict]:
    import PIL

    from .images import ImageProblem, load_image
    from .model import ModelUnavailable
    from .protocol import RequestError, parse_request
    from .similarity import SimilarityError, cosine_similarity, rank_key

    try:
        request = parse_request(raw)
    except RequestError as error:
        return EXIT_REQUEST, _error("invalid_request", str(error))

    try:
        reference = load_image(request.reference.path, request.reference.sha256)
    except ImageProblem as problem:
        return EXIT_INPUT, _error("reference_image_invalid", f"reference image: {problem.message}", problem=problem.code)

    # Selection policy: the first image in the order given that loads and decodes.
    # The caller orders a listing's images (declared primary first); later
    # images are only tried when earlier ones are unusable.
    selected: list[tuple[str, Any, Any]] = []
    unusable: dict[str, list[dict]] = {}
    for group in request.groups:
        rejected: list[dict] = []
        chosen = None
        for spec in group.images:
            try:
                chosen = (spec, load_image(spec.path, spec.sha256))
                break
            except ImageProblem as problem:
                if problem.fatal:
                    return EXIT_INPUT, _error(
                        "candidate_image_invalid",
                        f"group {group.id}, image {spec.ref}: {problem.message}",
                        problem=problem.code,
                        groupId=group.id,
                        imageRef=spec.ref,
                    )
                rejected.append({"ref": spec.ref, "problem": problem.code, "message": problem.message})
        unusable[group.id] = rejected
        if chosen:
            selected.append((group.id, chosen[0], chosen[1]))

    try:
        embedder = factory(request.model_id, request.revision, request.device)
    except ModelUnavailable as error:
        return EXIT_MODEL, _error(error.code, error.message)

    if embedder.model_id != request.model_id:
        return EXIT_INTERNAL, _error("model_mismatch", "loaded model does not match the requested checkpoint")

    images = [reference.image] + [loaded.image for _, _, loaded in selected]
    vectors = embedder.embed(images)
    if len(vectors) != len(images) or len({len(v) for v in vectors}) != 1:
        return EXIT_INTERNAL, _error("invalid_embeddings", "embedding count or dimensions are inconsistent")

    try:
        scored = [
            (gid, spec, loaded, cosine_similarity(vectors[0], vec))
            for (gid, spec, loaded), vec in zip(selected, vectors[1:], strict=True)
        ]
    except SimilarityError as error:
        return EXIT_INTERNAL, _error("invalid_embeddings", str(error))

    scored.sort(key=lambda s: rank_key(s[0], s[3]))
    embedded_ids = {s[0] for s in scored}
    groups_out: list[dict] = [
        {
            "id": gid,
            "status": "embedded",
            "selectedImage": {"ref": spec.ref, **loaded.info()},
            "embeddingCosineSimilarity": score,
            "rejectedImages": unusable[gid],
        }
        for gid, spec, loaded, score in scored
    ]
    groups_out += [
        {"id": g.id, "status": "no_usable_image", "rejectedImages": unusable[g.id]}
        for g in sorted(request.groups, key=lambda g: g.id)
        if g.id not in embedded_ids
    ]

    return EXIT_OK, {
        "protocol": PROTOCOL,
        "protocolVersion": PROTOCOL_VERSION,
        "status": "ok",
        "model": {
            "id": embedder.model_id,
            "revision": embedder.revision,
            "architecture": embedder.architecture,
            "modelType": embedder.model_type,
            "embeddingDim": len(vectors[0]),
            "featureSource": "get_image_features (pooled image embedding), L2-normalized",
            "dtype": "float32",
        },
        "device": {"type": embedder.device, "requested": embedder.requested_device, "reason": embedder.device_reason},
        "preprocessing": embedder.preprocessing(),
        "runtime": {
            "python": platform.python_version(),
            "pillow": PIL.__version__,
            **embedder.versions,
        },
        "reference": {"id": request.reference_id, **reference.info()},
        "groups": groups_out,
    }


def run_environment(model_id: str, revision: str | None, cache_dir: Path | None) -> dict:
    import PIL
    import PIL.features
    import torch
    import transformers

    from .model import DEFAULT_CACHE_DIR, ModelUnavailable, resolve_snapshot, select_device

    device, reason = select_device("auto")
    try:
        _, commit = resolve_snapshot(model_id, revision, cache_dir or DEFAULT_CACHE_DIR)
        cache = {"cached": True, "revision": commit}
    except ModelUnavailable as error:
        cache = {"cached": False, "revision": None, "reason": error.message}
    return {
        "protocol": PROTOCOL,
        "protocolVersion": PROTOCOL_VERSION,
        "status": "ok",
        "runtime": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "pillow": PIL.__version__,
        },
        "imageFormats": {"avif": bool(PIL.features.check("avif")), "webp": bool(PIL.features.check("webp"))},
        "device": {"auto": device, "reason": reason, "mpsBuilt": torch.backends.mps.is_built()},
        "model": {"id": model_id, "requestedRevision": revision, **cache},
    }


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m vfsa_vision")
    sub = parser.add_subparsers(dest="command", required=True)
    embed = sub.add_parser("embed", help="read a JSON request on stdin, write a JSON result on stdout")
    env = sub.add_parser("environment", help="report runtime, device and cache status (no weights loaded)")
    env.add_argument("--model", default=DEFAULT_MODEL_ID)
    env.add_argument("--revision")
    dl = sub.add_parser("download", help="explicitly download a checkpoint into the local cache")
    dl.add_argument("--model", required=True)
    dl.add_argument("--revision")
    for p in (embed, env, dl):
        p.add_argument("--cache-dir", type=Path)
    args = parser.parse_args(argv)

    if args.command == "download":
        from .model import DEFAULT_CACHE_DIR, download
        from .protocol import MODEL_ID

        if not MODEL_ID.fullmatch(args.model):
            print("error: only official google/siglip2-* checkpoints are supported", file=sys.stderr)
            return EXIT_REQUEST
        print(f"Downloading {args.model} into {args.cache_dir or DEFAULT_CACHE_DIR} ...", file=sys.stderr)
        path, commit = download(args.model, args.revision, args.cache_dir or DEFAULT_CACHE_DIR)
        _emit({"status": "ok", "model": {"id": args.model, "revision": commit}})
        return EXIT_OK

    _force_offline()
    if args.command == "environment":
        _emit(run_environment(args.model, args.revision, args.cache_dir))
        return EXIT_OK

    try:
        raw = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        _emit(_error("invalid_request", "stdin is not valid JSON"))
        return EXIT_REQUEST
    try:
        code, payload = run_embed(raw, default_embedder_factory(args.cache_dir))
        json.dumps(payload)
    except Exception as error:  # noqa: BLE001 - always answer with a structured error
        code, payload = EXIT_INTERNAL, _error("internal_error", f"{type(error).__name__} during embedding")
    if payload["status"] == "error":
        print(f"error: {payload['error']['code']}: {payload['error']['message']}", file=sys.stderr)
    _emit(payload)
    return code
