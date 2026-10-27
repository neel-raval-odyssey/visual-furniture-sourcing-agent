import io
import os

import PIL.features
import pytest
from PIL import Image

from conftest import image_bytes, sha, write
from vfsa_vision.images import ImageProblem, decode_image, load_image


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP"])
def test_decodes_supported_formats_to_rgb(tmp_path, fmt):
    path, digest = write(tmp_path / f"x.{fmt.lower()}", image_bytes(fmt))
    loaded = load_image(path, digest)
    assert loaded.format == fmt
    assert loaded.image.mode == "RGB"
    assert (loaded.width, loaded.height) == (32, 24)
    assert loaded.sha256 == digest


@pytest.mark.skipif(not PIL.features.check("avif"), reason="Pillow built without AVIF")
def test_decodes_avif(tmp_path):
    path, digest = write(tmp_path / "x.avif", image_bytes("AVIF"))
    assert load_image(path, digest).format == "AVIF"


def test_original_file_is_unchanged(tmp_path):
    data = image_bytes("PNG", mode="RGBA", color=(0, 0, 0, 0))
    path, digest = write(tmp_path / "a.png", data)
    load_image(path, digest)
    assert (tmp_path / "a.png").read_bytes() == data


def test_transparency_is_composited_onto_white():
    data = image_bytes("PNG", mode="RGBA", color=(0, 0, 0, 0))
    loaded = decode_image(data, sha(data))
    assert loaded.image.getpixel((0, 0)) == (255, 255, 255)
    assert loaded.source_mode == "RGBA"


def test_applies_exif_orientation():
    buffer = io.BytesIO()
    exif = Image.Exif()
    exif[274] = 6  # rotate 90° clockwise for display
    Image.new("RGB", (40, 10), (1, 2, 3)).save(buffer, format="JPEG", exif=exif)
    data = buffer.getvalue()
    loaded = decode_image(data, sha(data))
    assert (loaded.width, loaded.height) == (10, 40)


def test_missing_and_empty_files_are_not_fatal(tmp_path):
    with pytest.raises(ImageProblem) as missing:
        load_image(str(tmp_path / "none.png"), "0" * 64)
    assert (missing.value.code, missing.value.fatal) == ("missing_file", False)
    (tmp_path / "empty.png").write_bytes(b"")
    with pytest.raises(ImageProblem) as empty:
        load_image(str(tmp_path / "empty.png"), "0" * 64)
    assert empty.value.code == "empty_file"


def test_corrupted_image(tmp_path):
    data = image_bytes("PNG")[:60]
    path, digest = write(tmp_path / "broken.png", data)
    with pytest.raises(ImageProblem) as error:
        load_image(path, digest)
    assert error.value.code in ("decode_failed", "unsupported_format")
    assert not error.value.fatal


def test_unsupported_format_is_named(tmp_path):
    path, digest = write(tmp_path / "x.gif", image_bytes("GIF"))
    with pytest.raises(ImageProblem) as error:
        load_image(path, digest)
    assert error.value.code == "unsupported_format"
    assert "GIF" in error.value.message


def test_not_an_image(tmp_path):
    path, digest = write(tmp_path / "x.png", b"plain text, not an image")
    with pytest.raises(ImageProblem) as error:
        load_image(path, digest)
    assert error.value.code == "unsupported_format"


def test_hash_mismatch_is_fatal(tmp_path):
    path, _ = write(tmp_path / "x.png", image_bytes("PNG"))
    with pytest.raises(ImageProblem) as error:
        load_image(path, "0" * 64)
    assert (error.value.code, error.value.fatal) == ("hash_mismatch", True)


def test_rejects_symlinks_directories_and_relative_paths(tmp_path):
    path, digest = write(tmp_path / "real.png", image_bytes("PNG"))
    os.symlink(path, tmp_path / "link.png")
    with pytest.raises(ImageProblem) as link:
        load_image(str(tmp_path / "link.png"), digest)
    assert (link.value.code, link.value.fatal) == ("symlink", True)
    with pytest.raises(ImageProblem) as directory:
        load_image(str(tmp_path), digest)
    assert directory.value.code == "not_regular_file"
    with pytest.raises(ImageProblem) as relative:
        load_image("real.png", digest)
    assert relative.value.code == "invalid_path"
