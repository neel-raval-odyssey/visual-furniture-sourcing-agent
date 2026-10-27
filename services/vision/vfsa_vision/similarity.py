"""Cosine similarity and deterministic ranking on plain float vectors.

Pure Python, so it can be tested without PyTorch or model weights.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

# Normalized vectors can give a dot product slightly outside [-1, 1].
COSINE_TOLERANCE = 1e-4


class SimilarityError(ValueError):
    pass


def l2_normalize(vector: Sequence[float]) -> list[float]:
    values = [float(x) for x in vector]
    if not values:
        raise SimilarityError("embedding is empty")
    if not all(math.isfinite(x) for x in values):
        raise SimilarityError("embedding contains non-finite values")
    norm = math.sqrt(math.fsum(x * x for x in values))
    if not math.isfinite(norm) or norm == 0.0:
        raise SimilarityError("embedding has zero or non-finite norm")
    return [x / norm for x in values]


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine of two embeddings, computed on their L2-normalized forms."""
    if len(a) != len(b):
        raise SimilarityError(f"embedding dimensions differ ({len(a)} vs {len(b)})")
    na, nb = l2_normalize(a), l2_normalize(b)
    value = math.fsum(x * y for x, y in zip(na, nb, strict=True))
    if not math.isfinite(value) or abs(value) > 1.0 + COSINE_TOLERANCE:
        raise SimilarityError(f"cosine similarity {value!r} is outside [-1, 1]")
    return value


def rank_key(item_id: str, score: float) -> tuple[float, str]:
    """Descending score; ties broken by ascending id."""
    return (-score, item_id)
