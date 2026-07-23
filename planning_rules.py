"""Reglas deterministas de disponibilidad que se ejecutan del lado servidor."""
from datetime import date


CYCLE_LENGTH_DAYS = 15


def cycle_day_off(anchor_date, anchor_type, target_date, cycle_length_days=CYCLE_LENGTH_DAYS):
    """Devuelve F1/F2 o None según el ciclo operativo configurado."""
    if not anchor_date or anchor_type not in {"F1", "F2"} or cycle_length_days != CYCLE_LENGTH_DAYS:
        return None
    anchor = date.fromisoformat(str(anchor_date))
    target = date.fromisoformat(str(target_date))
    phase = (target - anchor).days % CYCLE_LENGTH_DAYS
    if anchor_type == "F1":
        return "F1" if phase == 0 else "F2" if phase in {7, 8} else None
    return "F2" if phase in {0, 1} else "F1" if phase == 8 else None
