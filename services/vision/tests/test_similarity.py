import math

import pytest

from vfsa_vision.similarity import SimilarityError, cosine_similarity, l2_normalize, rank_key


def test_equal_vectors_have_similarity_near_one():
    v = [0.3, -1.2, 4.5, 0.01]
    assert cosine_similarity(v, v) == pytest.approx(1.0, abs=1e-12)
    assert cosine_similarity(v, [x * 7 for x in v]) == pytest.approx(1.0, abs=1e-12)


def test_known_values():
    assert cosine_similarity([1, 0], [0, 1]) == pytest.approx(0.0)
    assert cosine_similarity([1, 0], [-1, 0]) == pytest.approx(-1.0)
    assert cosine_similarity([1, 1], [1, 0]) == pytest.approx(1 / math.sqrt(2))


def test_normalization_gives_unit_length():
    n = l2_normalize([3, 4])
    assert n == pytest.approx([0.6, 0.8])


@pytest.mark.parametrize(
    "a,b",
    [([], []), ([0, 0], [1, 0]), ([math.nan, 1], [1, 1]), ([math.inf, 1], [1, 1]), ([1, 2], [1, 2, 3])],
)
def test_invalid_vectors_raise(a, b):
    with pytest.raises(SimilarityError):
        cosine_similarity(a, b)


def test_results_are_finite_and_bounded():
    import random

    rng = random.Random(7)
    for _ in range(200):
        a = [rng.uniform(-1, 1) for _ in range(64)]
        b = [rng.uniform(-1, 1) for _ in range(64)]
        value = cosine_similarity(a, b)
        assert math.isfinite(value) and -1.0 <= value <= 1.0


def test_ranking_is_descending_with_id_tiebreak():
    items = [("b", 0.5), ("a", 0.5), ("c", 0.9), ("d", -0.1)]
    ordered = sorted(items, key=lambda x: rank_key(*x))
    assert [i for i, _ in ordered] == ["c", "a", "b", "d"]
    assert sorted(reversed(items), key=lambda x: rank_key(*x)) == ordered
