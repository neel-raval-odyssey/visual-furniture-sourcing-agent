"""Model-boundary helpers that need no weights."""

import pytest

torch = pytest.importorskip("torch")

from vfsa_vision import model  # noqa: E402


def test_device_selection_never_switches_an_explicit_request(monkeypatch):
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    monkeypatch.setattr(torch.backends.mps, "is_built", lambda: True)
    assert model.select_device("cpu") == ("cpu", "CPU requested")
    device, reason = model.select_device("auto")
    assert device == "cpu" and "not available" in reason
    with pytest.raises(model.ModelUnavailable) as error:
        model.select_device("mps")
    assert error.value.code == "device_unavailable"


def test_auto_uses_mps_when_available(monkeypatch):
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: True)
    assert model.select_device("auto")[0] == "mps"


def test_uncached_model_is_reported_without_downloading(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    with pytest.raises(model.ModelUnavailable) as error:
        model.resolve_snapshot("google/siglip2-base-patch16-384", None, tmp_path)
    assert error.value.code == "model_not_cached"
