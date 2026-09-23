"""API-equivalent cost for one Codex session, using the costs report's usage rules."""
from __future__ import annotations

from dataclasses import replace
from functools import lru_cache
from pathlib import Path

from app import costs, pricing
from app.costs_sources import UsageRow, respostas_por_turno_codex


def estimate_session_cost(rollout_path: str) -> dict:
    path = Path(rollout_path).resolve(strict=True)
    stat = path.stat()
    rows = _usage(str(path), stat.st_mtime_ns, stat.st_size)
    total = 0.0
    missing_models: set[str] = set()
    for row in rows:
        parts = costs._custo_da_linha(row)
        if parts is None:
            missing_models.add(pricing.canonizar(row.model))
        else:
            total += sum(parts.values())
    return {
        "cost_usd": total if rows and not missing_models else None,
        "missing_models": sorted(missing_models),
        "has_usage": bool(rows),
    }


@lru_cache(maxsize=32)
def _usage(path: str, _mtime_ns: int, _size: int) -> tuple[UsageRow, ...]:
    grouped: dict[tuple[str, bool], UsageRow] = {}
    for rows in respostas_por_turno_codex(Path(path), "codex").values():
        for row in rows:
            if not any((row.input, row.output, row.cache_write, row.cache_read)):
                continue
            key = row.model, row.codex_long_context
            before = grouped.get(key)
            grouped[key] = row if before is None else replace(
                before, input=before.input + row.input, output=before.output + row.output,
                cache_write=before.cache_write + row.cache_write,
                cache_read=before.cache_read + row.cache_read,
            )
    return tuple(grouped.values())
