"""Пересчёт весов офферов в потоке.

Правила (как в видео):
  * удалённые офферы получают 0%;
  * закреплённые (pinned) веса не меняются;
  * остаток 100 − Σзакреплённых делится между незакреплёнными поровну,
    целыми процентами; лишние проценты от деления достаются первым
    офферам по порядку (3 оффера → 34/33/33), чтобы сумма была ровно 100.
"""

from dataclasses import dataclass


class WeightsError(ValueError):
    pass


@dataclass
class Slot:
    key: int
    active: bool
    pinned: bool
    share: int


def distribute(slots: list[Slot]) -> dict[int, int]:
    """Возвращает новые веса {key: share}. Список slots не меняется."""
    result: dict[int, int] = {}
    active = [s for s in slots if s.active]
    for s in slots:
        if not s.active:
            result[s.key] = 0

    pinned = [s for s in active if s.pinned]
    free = [s for s in active if not s.pinned]
    pinned_sum = sum(s.share for s in pinned)
    if pinned_sum > 100:
        raise WeightsError(f"Сумма закреплённых весов {pinned_sum}% больше 100%")

    for s in pinned:
        result[s.key] = s.share

    rest = 100 - pinned_sum
    if free:
        base, extra = divmod(rest, len(free))
        for i, s in enumerate(free):
            result[s.key] = base + (1 if i < extra else 0)
    return result


def validate_for_publish(slots: list[Slot]) -> None:
    active = [s for s in slots if s.active]
    if not active:
        raise WeightsError("В потоке нет ни одного активного оффера")
    total = sum(s.share for s in active)
    if total != 100:
        raise WeightsError(
            f"Сумма весов {total}%, а должна быть 100%. Открепите один из офферов или поправьте закреплённые веса"
        )
