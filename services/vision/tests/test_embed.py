"""`embed` command with a mocked model boundary (no weights, no network)."""

import io
import json
import math

import pytest

from conftest import image_bytes, write
from vfsa_vision import PROTOCOL, PROTOCOL_VERSION, cli
from vfsa_vision.model import ModelUnavailable

MODEL = "google/siglip2-base-patch16-384"
COMMIT = "a" * 40


class FakeEmbedder:
    """Embeds an image as its top-left pixel colour: deterministic and model-free."""

    def __init__(self, model_id, revision, device, *, vectors=None):
        self.model_id = model_id
        self.revision = COMMIT
        self.device = "cpu"
        self.device_reason = "test"
        self.requested_device = device
        self.architecture = "FakeModel"
        self.model_type = "siglip"
        self.versions = {"torch": "test", "transformers": "test"}
        self.calls = []
        self._vectors = vectors

    def preprocessing(self):
        return {"imageProcessor": "Fake"}

    def embed(self, images):
        self.calls.append(len(images))
        if self._vectors is not None:
            return self._vectors
        return [[float(c) for c in image.getpixel((0, 0))] for image in images]


def factory(**kwargs):
    made = []

    def make(model_id, revision, device):
        made.append(FakeEmbedder(model_id, revision, device, **kwargs))
        return made[-1]

    make.made = made
    return make


@pytest.fixture
def files(tmp_path):
    def add(name, data):
        path, digest = write(tmp_path / name, data)
        return {"path": path, "sha256": digest}

    return add


def request(reference, groups, **overrides):
    body = {
        "protocol": PROTOCOL,
        "protocolVersion": PROTOCOL_VERSION,
        "model": {"id": MODEL, "revision": None},
        "device": "auto",
        "reference": {"id": "ref-1", **reference},
        "groups": groups,
    }
    body.update(overrides)
    return body


def group(gid, *images):
    return {"id": gid, "images": [{"ref": f"{gid}-{i}.png", **img} for i, img in enumerate(images)]}


def test_ranks_groups_by_cosine_with_deterministic_ties(files):
    ref = files("ref.png", image_bytes(color=(200, 30, 30)))
    near = files("near.png", image_bytes(color=(190, 40, 30)))
    far = files("far.png", image_bytes(color=(10, 30, 220)))
    same = files("same.png", image_bytes(color=(200, 30, 30)))
    make = factory()
    code, out = cli.run_embed(
        request(ref, [group("g-far", far), group("g-same-b", same), group("g-near", near), group("g-same-a", same)]),
        make,
    )
    assert code == cli.EXIT_OK
    assert out["status"] == "ok"
    ids = [g["id"] for g in out["groups"]]
    assert ids == ["g-same-a", "g-same-b", "g-near", "g-far"]
    scores = [g["embeddingCosineSimilarity"] for g in out["groups"]]
    assert scores == sorted(scores, reverse=True)
    assert scores[0] == pytest.approx(1.0) and all(math.isfinite(s) and -1 <= s <= 1 + 1e-9 for s in scores)
    assert out["model"] == {
        "id": MODEL,
        "revision": COMMIT,
        "architecture": "FakeModel",
        "modelType": "siglip",
        "embeddingDim": 3,
        "featureSource": "get_image_features (pooled image embedding), L2-normalized",
        "dtype": "float32",
    }
    assert out["reference"]["sha256"] == ref["sha256"]
    assert make.made[0].calls == [5]  # reference + one image per group, in one model call
    for g in out["groups"]:
        assert "confidence" not in g and "designSimilarityIndex" not in g and "classification" not in g


def test_falls_back_to_next_image_and_records_why(files, tmp_path):
    ref = files("ref.png", image_bytes())
    broken = files("broken.png", b"not an image")
    good = files("good.png", image_bytes(color=(1, 2, 3)))
    missing = {"path": str(tmp_path / "missing.png"), "sha256": "0" * 64}
    code, out = cli.run_embed(request(ref, [group("g", missing, broken, good), group("h", missing)]), factory())
    assert code == cli.EXIT_OK
    g, h = out["groups"]
    assert g["status"] == "embedded"
    assert g["selectedImage"]["ref"] == "g-2.png"
    assert [r["problem"] for r in g["rejectedImages"]] == ["missing_file", "unsupported_format"]
    assert h == {"id": "h", "status": "no_usable_image", "rejectedImages": [{"ref": "h-0.png", "problem": "missing_file", "message": "image file not found"}]}
    assert "embeddingCosineSimilarity" not in h


def test_only_the_first_usable_image_is_scored(files):
    ref = files("ref.png", image_bytes(color=(200, 30, 30)))
    first = files("first.png", image_bytes(color=(10, 30, 220)))
    better = files("better.png", image_bytes(color=(200, 30, 30)))
    make = factory()
    _, out = cli.run_embed(request(ref, [group("g", first, better)]), make)
    assert out["groups"][0]["selectedImage"]["ref"] == "g-0.png"
    assert out["groups"][0]["embeddingCosineSimilarity"] < 0.5  # not the max over images
    assert make.made[0].calls == [2]


def test_reference_problems_and_tampered_files_abort(files, tmp_path):
    ref = files("ref.png", image_bytes())
    code, out = cli.run_embed(request({"path": str(tmp_path / "nope.png"), "sha256": "0" * 64}, [group("g", ref)]), factory())
    assert (code, out["error"]["code"]) == (cli.EXIT_INPUT, "reference_image_invalid")
    changed = {**files("c.png", image_bytes()), "sha256": "f" * 64}
    code, out = cli.run_embed(request(ref, [group("g", changed)]), factory())
    assert (code, out["error"]["code"], out["error"]["problem"]) == (cli.EXIT_INPUT, "candidate_image_invalid", "hash_mismatch")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.update(protocolVersion=2),
        lambda r: r.update(groups=[]),
        lambda r: r.update(device="cuda"),
        lambda r: r.update(model={"id": "openai/clip-vit-base-patch32", "revision": None}),
        lambda r: r.update(extra=True),
        lambda r: r["reference"].update(path="relative.png"),
        lambda r: r["groups"].append(r["groups"][0]),
    ],
)
def test_invalid_requests_are_rejected_before_any_model_load(files, mutate):
    ref = files("ref.png", image_bytes())
    body = request(ref, [group("g", ref)])
    mutate(body)
    make = factory()
    code, out = cli.run_embed(body, make)
    assert (code, out["error"]["code"]) == (cli.EXIT_REQUEST, "invalid_request")
    assert make.made == []


def test_model_unavailable_is_reported(files):
    ref = files("ref.png", image_bytes())

    def unavailable(*_):
        raise ModelUnavailable("model_not_cached", "not cached")

    code, out = cli.run_embed(request(ref, [group("g", ref)]), unavailable)
    assert (code, out["error"]["code"]) == (cli.EXIT_MODEL, "model_not_cached")


def test_invalid_embeddings_are_rejected(files):
    ref = files("ref.png", image_bytes())
    for vectors in ([[1.0, 0.0]], [[1.0, 0.0], [math.nan, 1.0]], [[0.0, 0.0], [1.0, 1.0]], [[1.0], [1.0, 2.0]]):
        code, out = cli.run_embed(request(ref, [group("g", ref)]), factory(vectors=vectors))
        assert (code, out["error"]["code"]) == (cli.EXIT_INTERNAL, "invalid_embeddings")


def test_main_reports_invalid_json_on_stdout(monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
    assert cli.main(["embed"]) == cli.EXIT_REQUEST
    out = json.loads(capsys.readouterr().out)
    assert out["error"]["code"] == "invalid_request"
