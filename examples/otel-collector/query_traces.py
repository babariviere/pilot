#!/usr/bin/env python3
"""Small stdlib-only reader for newline-delimited OTLP/JSON emitted by the example collector."""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


def attributes(values: list[dict[str, Any]] | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for item in values or []:
        value = item.get("value", {})
        for key in ("stringValue", "boolValue", "intValue", "doubleValue"):
            if key in value:
                result[item.get("key", "")] = value[key]
                break
    return result


def spans(path: Path) -> Iterable[dict[str, Any]]:
    with path.open(encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            batch = json.loads(line)
            for resource_spans in batch.get("resourceSpans", []):
                resource = attributes(resource_spans.get("resource", {}).get("attributes"))
                for scope in resource_spans.get("scopeSpans", []):
                    for span in scope.get("spans", []):
                        start = int(span.get("startTimeUnixNano", 0))
                        end = int(span.get("endTimeUnixNano", 0))
                        yield {
                            "name": span.get("name"),
                            "start": start,
                            "duration_ms": max(0.0, (end - start) / 1_000_000),
                            "resource": resource,
                            "attributes": attributes(span.get("attributes")),
                        }


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def distributions(rows: list[dict[str, Any]]) -> None:
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    names = {"pilot.message.send", "pilot.chat.open", "pilot.tool.call", "pilot.tool.cancel_wait"}
    for row in rows:
        if row["name"] not in names:
            continue
        attrs, resource = row["attributes"], row["resource"]
        release = str(resource.get("service.version", "unavailable"))
        category = str(attrs.get("pilot.tool.category", "n/a"))
        groups[(row["name"], release, category)].append(row)
    print("name\trelease\tcategory\tcount\tfailures\ttimeouts\tp50_ms\tp95_ms\tp99_ms")
    for key, group in sorted(groups.items()):
        durations = [item["duration_ms"] for item in group]
        outcomes = [item["attributes"].get("pilot.outcome") for item in group]
        print(
            *key,
            len(group),
            outcomes.count("failure"),
            outcomes.count("timeout"),
            f"{percentile(durations, 0.50):.1f}",
            f"{percentile(durations, 0.95):.1f}",
            f"{percentile(durations, 0.99):.1f}",
            sep="\t",
        )


def adoption(rows: list[dict[str, Any]]) -> None:
    cohorts: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    successes: dict[tuple[str, str], set[str]] = defaultdict(set)
    for row in rows:
        if row["name"] != "pilot.feature":
            continue
        attrs, resource = row["attributes"], row["resource"]
        identity = resource.get("pilot.analytics.id")
        feature, stage = attrs.get("pilot.feature.name"), attrs.get("pilot.feature.stage")
        if not isinstance(identity, str) or not isinstance(feature, str) or not isinstance(stage, str):
            continue
        detail = attrs.get("pilot.feature.outcome") or attrs.get("pilot.feature.availability") or "-"
        cohorts[(feature, stage, str(detail))].add(identity)
        if stage == "outcome" and detail == "success" and row["start"]:
            day = datetime.fromtimestamp(row["start"] / 1_000_000_000, tz=timezone.utc).date().isoformat()
            successes[(feature, identity)].add(day)
    print("feature\tstage\tdetail\tunique_installations")
    for key, identities in sorted(cohorts.items()):
        print(*key, len(identities), sep="\t")
    print("\nfeature\tadopted\trepeat_on_distinct_day")
    for feature in sorted({key[0] for key in successes}):
        people = [days for (name, _), days in successes.items() if name == feature]
        print(feature, len(people), sum(len(days) >= 2 for days in people), sep="\t")


def live_tools(path: Path) -> None:
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    print("category\tactive_ms\tsince_progress_ms\tsince_liveness_ms\tstate\tnested")
    for item in snapshot.get("evidence", []):
        if item.get("kind") != "tool.in_flight":
            continue
        print(
            item.get("category", "other"),
            max(0, item.get("durationMs", 0)),
            max(0, item.get("progressAgeMs", 0)),
            max(0, item.get("livenessAgeMs", 0)),
            item.get("state", "unknown"),
            bool(item.get("nested", False)),
            sep="\t",
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["distributions", "adoption", "live-tools"])
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    if args.command == "live-tools":
        live_tools(args.path)
        return
    rows = list(spans(args.path))
    (distributions if args.command == "distributions" else adoption)(rows)


if __name__ == "__main__":
    main()
