"""Safe loading and validation of local image evidence.

Images are read once into memory, checked against the SHA-256 the caller
validated, decoded with Pillow and converted to RGB. Original files are never
modified.
"""

from __future__ import annotations

import hashlib
import io
import os
import stat
import warnings
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

SUPPORTED_FORMATS = ("PNG", "JPEG", "WEBP", "AVIF")
MAX_FILE_BYTES = 40 * 1024 * 1024
MAX_PIXELS = 40_000_000


class ImageProblem(Exception):
    """An image cannot be used. `fatal` problems abort the whole request."""

    def __init__(self, code: str, message: str, fatal: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.fatal = fatal


@dataclass(frozen=True)
class LoadedImage:
    image: Image.Image
    sha256: str
    format: str
    width: int
    height: int
    source_mode: str

    def info(self) -> dict:
        return {
            "sha256": self.sha256,
            "format": self.format,
            "width": self.width,
            "height": self.height,
            "sourceMode": self.source_mode,
        }


def _read_regular_file(path: str) -> bytes:
    if not os.path.isabs(path):
        raise ImageProblem("invalid_path", "image path must be absolute", fatal=True)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        raise ImageProblem("missing_file", "image file not found") from None
    except OSError:
        raise ImageProblem("unreadable_file", "image file cannot be read") from None
    if stat.S_ISLNK(st.st_mode):
        raise ImageProblem("symlink", "image path is a symbolic link", fatal=True)
    if not stat.S_ISREG(st.st_mode):
        raise ImageProblem("not_regular_file", "image path is not a regular file", fatal=True)
    if st.st_size == 0:
        raise ImageProblem("empty_file", "image file is empty")
    if st.st_size > MAX_FILE_BYTES:
        raise ImageProblem("too_large", f"image file exceeds {MAX_FILE_BYTES} bytes")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        raise ImageProblem("unreadable_file", "image file cannot be opened") from None
    with os.fdopen(fd, "rb") as handle:
        return handle.read(MAX_FILE_BYTES + 1)


def _to_rgb(image: Image.Image) -> Image.Image:
    """RGB for the model. Transparent areas are composited onto white."""
    has_alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
    if has_alpha:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def decode_image(data: bytes, expected_sha256: str) -> LoadedImage:
    if len(data) == 0:
        raise ImageProblem("empty_file", "image file is empty")
    if len(data) > MAX_FILE_BYTES:
        raise ImageProblem("too_large", f"image file exceeds {MAX_FILE_BYTES} bytes")
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_sha256:
        raise ImageProblem(
            "hash_mismatch",
            "image content does not match the SHA-256 validated by the caller (file changed?)",
            fatal=True,
        )
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            probe = Image.open(io.BytesIO(data), formats=list(SUPPORTED_FORMATS))
            fmt = probe.format or "UNKNOWN"
            probe.verify()
            image = Image.open(io.BytesIO(data), formats=list(SUPPORTED_FORMATS))
            if image.width * image.height > MAX_PIXELS:
                raise ImageProblem("too_many_pixels", f"image has more than {MAX_PIXELS} pixels")
            image.load()
        except ImageProblem:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise ImageProblem("too_many_pixels", "image dimensions are too large") from None
        except UnidentifiedImageError:
            raise ImageProblem("unsupported_format", _unsupported_message(data)) from None
        except Exception:  # noqa: BLE001 - any decoder failure means the file is unusable
            raise ImageProblem("decode_failed", "image file is corrupted or cannot be decoded") from None
    source_mode = image.mode
    image = ImageOps.exif_transpose(image)
    rgb = _to_rgb(image)
    return LoadedImage(rgb, digest, fmt, rgb.width, rgb.height, source_mode)


def _unsupported_message(data: bytes) -> str:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fmt = Image.open(io.BytesIO(data)).format
    except Exception:  # noqa: BLE001
        fmt = None
    if fmt:
        return f"image format {fmt} is not supported (supported: {', '.join(SUPPORTED_FORMATS)})"
    return "file is not a decodable image (corrupted or unknown format)"


def load_image(path: str, expected_sha256: str) -> LoadedImage:
    return decode_image(_read_regular_file(path), expected_sha256)
