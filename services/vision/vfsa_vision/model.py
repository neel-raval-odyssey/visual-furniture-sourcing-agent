"""SigLIP 2 model loading and image embedding (PyTorch + Transformers).

Weights are loaded only from the local cache (`local_files_only=True`); the
`download` command is the only code path allowed to fetch them. The official
pretrained processor does all model preprocessing.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path

from PIL import Image

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CACHE_DIR = PACKAGE_ROOT / ".cache" / "huggingface"
# Files needed to load the processor and model; skips duplicate weight formats.
ALLOW_PATTERNS = ["*.json", "*.safetensors", "*.model", "*.txt"]
EXPECTED_MODEL_TYPES = ("siglip", "siglip2")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
BATCH_SIZE = 8


class ModelUnavailable(RuntimeError):
    """The checkpoint is not in the local cache, or the device cannot be used."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def select_device(requested: str) -> tuple[str, str]:
    """Returns (device, reason). Never switches away from an explicit request."""
    import torch

    built = torch.backends.mps.is_built()
    available = torch.backends.mps.is_available()
    if requested == "cpu":
        return "cpu", "CPU requested"
    if requested == "mps":
        if not available:
            raise ModelUnavailable("device_unavailable", f"MPS was requested but is not available ({_mps_reason(built)})")
        return "mps", "MPS requested and available"
    if available:
        return "mps", "MPS (Apple silicon GPU) is available"
    return "cpu", f"MPS not used: {_mps_reason(built)}"


def _mps_reason(built: bool) -> str:
    if not built:
        return "this PyTorch build has no MPS support"
    return "MPS is built but not available on this machine (requires Apple silicon and a supported macOS)"


def resolve_snapshot(model_id: str, revision: str | None, cache_dir: Path) -> tuple[Path, str]:
    """Finds a cached snapshot without network access. Returns (path, commit)."""
    from huggingface_hub import snapshot_download

    try:
        path = Path(
            snapshot_download(
                model_id,
                revision=revision,
                cache_dir=str(cache_dir),
                local_files_only=True,
                allow_patterns=ALLOW_PATTERNS,
            )
        )
    except Exception:  # noqa: BLE001 - every failure here means "not cached"
        raise ModelUnavailable(
            "model_not_cached",
            f"{model_id}{'@' + revision if revision else ''} is not in the local model cache; "
            "run the explicit download step first (see services/vision/README.md)",
        ) from None
    commit = path.name
    if not COMMIT.fullmatch(commit):
        raise ModelUnavailable("model_revision_unknown", "cached snapshot has no resolvable commit hash")
    if revision and COMMIT.fullmatch(revision) and revision != commit:
        raise ModelUnavailable("model_revision_mismatch", "cached snapshot does not match the requested revision")
    return path, commit


def download(model_id: str, revision: str | None, cache_dir: Path) -> tuple[Path, str]:
    """Explicit setup step: fetches the checkpoint into the project-local cache."""
    from huggingface_hub import snapshot_download

    path = Path(
        snapshot_download(model_id, revision=revision, cache_dir=str(cache_dir), allow_patterns=ALLOW_PATTERNS)
    )
    return path, path.name


def _plain(value: object) -> object:
    """JSON-safe copy of a processor setting (e.g. SizeDict -> dict)."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict) or hasattr(value, "items"):
        return {str(k): _plain(v) for k, v in dict(value.items()).items() if v is not None}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if hasattr(value, "__dict__"):
        return {k: _plain(v) for k, v in vars(value).items() if v is not None and not k.startswith("_")}
    return str(value)


def _resample_name(value: object) -> object:
    try:
        return Image.Resampling(value).name.lower()
    except (ValueError, TypeError):
        return value


class SiglipImageEmbedder:
    """Image encoder of one SigLIP 2 checkpoint, on one device, in fp32 eval mode."""

    def __init__(self, model_id: str, revision: str | None, device: str, cache_dir: Path = DEFAULT_CACHE_DIR):
        import torch
        import transformers
        from transformers import AutoModel, AutoProcessor

        snapshot, commit = resolve_snapshot(model_id, revision, cache_dir)
        self.device, self.device_reason = select_device(device)
        self.requested_device = device
        self.model_id = model_id
        self.revision = commit
        self._torch = torch
        self.processor = AutoProcessor.from_pretrained(str(snapshot), local_files_only=True)
        model = AutoModel.from_pretrained(str(snapshot), local_files_only=True, dtype=torch.float32)
        model_type = getattr(model.config, "model_type", None)
        if model_type not in EXPECTED_MODEL_TYPES or not hasattr(model, "get_image_features"):
            raise ModelUnavailable("unexpected_architecture", f"checkpoint has model type {model_type!r}, not SigLIP")
        self.model = model.to(self.device).eval()
        self.architecture = type(model).__name__
        self.model_type = model_type
        self.versions = {"torch": torch.__version__, "transformers": transformers.__version__}

    def preprocessing(self) -> dict:
        ip = getattr(self.processor, "image_processor", self.processor)
        settings = {
            "imageProcessor": type(ip).__name__,
            "size": getattr(ip, "size", None),
            "resample": _resample_name(getattr(ip, "resample", None)),
            "doResize": getattr(ip, "do_resize", None),
            "doRescale": getattr(ip, "do_rescale", None),
            "rescaleFactor": getattr(ip, "rescale_factor", None),
            "doNormalize": getattr(ip, "do_normalize", None),
            "imageMean": list(getattr(ip, "image_mean", []) or []),
            "imageStd": list(getattr(ip, "image_std", []) or []),
            "beforeProcessor": "EXIF orientation applied; transparency composited onto white; converted to RGB",
            "crop": "none (whole image, no segmentation or background removal)",
        }
        return {k: _plain(v) for k, v in settings.items()}

    def embed(self, images: Sequence[Image.Image]) -> list[list[float]]:
        torch = self._torch
        vectors: list[list[float]] = []
        with torch.inference_mode():
            for start in range(0, len(images), BATCH_SIZE):
                batch = list(images[start : start + BATCH_SIZE])
                inputs = self.processor(images=batch, return_tensors="pt")
                inputs = {k: v.to(self.device) for k, v in inputs.items() if hasattr(v, "to")}
                out = self.model.get_image_features(**inputs)
                # Transformers 5 returns a pooled output object; 4.x returned the tensor.
                features = out if isinstance(out, torch.Tensor) else out.pooler_output
                vectors.extend(features.detach().to("cpu").double().tolist())
        return vectors
