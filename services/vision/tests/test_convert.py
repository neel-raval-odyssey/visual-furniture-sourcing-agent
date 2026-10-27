import json

import PIL.features
import pytest
from PIL import Image

from conftest import image_bytes, write
from vfsa_vision import cli


@pytest.mark.skipif(not PIL.features.check("avif"), reason="Pillow built without AVIF")
def test_converts_avif_to_a_new_png_without_touching_the_original(tmp_path):
    data = image_bytes("AVIF", size=(40, 30))
    src, digest = write(tmp_path / "x.avif", data)
    out = tmp_path / "x.png"
    code, payload = cli.run_convert(src, digest, str(out))
    assert code == cli.EXIT_OK
    assert payload["source"] == {"format": "AVIF", "sha256": digest}
    assert payload["output"]["width"] == 40 and payload["output"]["format"] == "PNG"
    assert Image.open(out).format == "PNG"
    assert (tmp_path / "x.avif").read_bytes() == data


def test_refuses_overwrite_bad_hash_and_relative_output(tmp_path):
    src, digest = write(tmp_path / "x.png", image_bytes("PNG"))
    (tmp_path / "taken.png").write_bytes(b"existing")
    assert cli.run_convert(src, digest, str(tmp_path / "taken.png"))[1]["error"]["code"] == "output_exists"
    assert (tmp_path / "taken.png").read_bytes() == b"existing"
    code, payload = cli.run_convert(src, "0" * 64, str(tmp_path / "y.png"))
    assert (code, payload["error"]["problem"]) == (cli.EXIT_INPUT, "hash_mismatch")
    assert cli.run_convert(src, digest, "rel.png")[1]["error"]["code"] == "invalid_request"


def test_main_emits_json(tmp_path, capsys):
    src, digest = write(tmp_path / "x.webp", image_bytes("WEBP"))
    assert cli.main(["convert", "--input", src, "--sha256", digest, "--output", str(tmp_path / "o.png")]) == cli.EXIT_OK
    assert json.loads(capsys.readouterr().out)["status"] == "ok"
