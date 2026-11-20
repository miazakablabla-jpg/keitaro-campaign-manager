import pytest

from app.services.weights import Slot, WeightsError, distribute, validate_for_publish


def shares(*slots: Slot) -> list[int]:
    result = distribute(list(slots))
    return [result[s.key] for s in slots]


def test_even_split_rounds_to_100():
    assert shares(Slot(1, True, False, 0), Slot(2, True, False, 0), Slot(3, True, False, 0)) == [34, 33, 33]


def test_four_offers_get_25_each():
    assert shares(*(Slot(i, True, False, 0) for i in range(4))) == [25, 25, 25, 25]


def test_removed_offer_gets_zero():
    assert shares(Slot(1, True, False, 50), Slot(2, False, False, 50), Slot(3, True, False, 0)) == [50, 0, 50]


def test_pinned_weight_is_kept_and_rest_split():
    assert shares(Slot(1, True, True, 25), Slot(2, True, False, 0), Slot(3, True, False, 0)) == [25, 38, 37]


def test_removed_pinned_offer_does_not_count():
    assert shares(Slot(1, False, True, 60), Slot(2, True, False, 0)) == [0, 100]


def test_pinned_over_100_is_rejected():
    with pytest.raises(WeightsError):
        distribute([Slot(1, True, True, 70), Slot(2, True, True, 40)])


def test_publish_requires_exactly_100():
    validate_for_publish([Slot(1, True, True, 30), Slot(2, True, False, 70)])
    with pytest.raises(WeightsError):
        validate_for_publish([Slot(1, True, True, 30), Slot(2, True, True, 30)])
    with pytest.raises(WeightsError):
        validate_for_publish([Slot(1, False, False, 0)])
