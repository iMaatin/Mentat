#!/usr/bin/env python3
"""Mentat dataset sidecar.

Reads and writes the binary table formats that TypeScript cannot handle without
dependencies: Parquet, Excel, and SQLite. It is deliberately dumb. It converts
between a file and JSON rows on stdout, and does nothing else. All profiling,
synthesis, and redaction happen in TypeScript.

Protocol: one JSON request on stdin, one JSON response on stdout.

  request  = {"op": "read", "path": str, "format": str}
           | {"op": "write", "path": str, "format": str,
              "rows": [obj], "name": str, "tables": {name: [obj]}}
  response = {"rows": [obj]} | {"tables": {name: [obj]}} | {"ok": true}

Nothing here prints to stdout other than the response, so any diagnostics go to
stderr. No network access is performed.
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime, time
from pathlib import Path
from typing import Any


def _emit(obj: Any) -> None:
    sys.stdout.write(json.dumps(obj, default=_fallback))


def _fallback(value: Any) -> Any:
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, set):
        return sorted(value)
    return str(value)


def _normalize(value: Any) -> Any:
    """Make a pandas/numpy value JSON-safe and lossy-free where it matters."""
    if value is None:
        return None
    if isinstance(value, float) and value != value:  # NaN
        return None
    try:
        import pandas as pd

        if value is pd.NaT or (isinstance(value, float) and value != value):
            return None
        if isinstance(value, pd.Timestamp):
            return value.isoformat()
    except Exception:
        pass
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, (int, float, str, bool)):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    try:
        import numpy as np

        if isinstance(value, np.integer):
            return int(value)
        if isinstance(value, np.floating):
            f = float(value)
            return None if f != f else f
        if isinstance(value, np.bool_):
            return bool(value)
    except Exception:
        pass
    if isinstance(value, dict):
        return {str(k): _normalize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_normalize(v) for v in value]
    return str(value)


def _read(req: dict) -> dict:
    import pandas as pd

    path = Path(req["path"])
    fmt = req["format"]

    if fmt == "parquet":
        frame = pd.read_parquet(path)
        return {"rows": [{k: _normalize(v) for k, v in row.items()} for row in frame.to_dict("records")]}

    if fmt == "xlsx":
        sheets = pd.read_excel(path, sheet_name=None)
        tables = {
            str(name): [{k: _normalize(v) for k, v in row.items()} for row in df.to_dict("records")]
            for name, df in sheets.items()
        }
        return {"tables": tables}

    if fmt == "sqlite":
        import sqlite3

        uri = f"file:{path.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        try:
            names = [
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).fetchall()
            ]
            tables = {}
            for name in names:
                cursor = conn.execute(f'SELECT * FROM "{name}"')
                cols = [d[0] for d in cursor.description or []]
                rows = [{c: _normalize(v) for c, v in zip(cols, row)} for row in cursor.fetchall()]
                tables[name] = rows
            return {"tables": tables}
        finally:
            conn.close()

    raise ValueError(f"unsupported read format: {fmt}")


def _write(req: dict) -> dict:
    import pandas as pd

    path = Path(req["path"])
    fmt = req["format"]
    path.parent.mkdir(parents=True, exist_ok=True)
    name = req.get("name") or path.stem

    if fmt == "parquet":
        rows = req.get("rows") or []
        frame = pd.DataFrame(rows)
        frame.to_parquet(path, index=False)
        return {"ok": True}

    if fmt == "xlsx":
        rows = req.get("rows") or []
        pd.DataFrame(rows).to_excel(path, index=False, sheet_name=str(name)[:31])
        return {"ok": True}

    if fmt == "sqlite":
        import sqlite3

        if path.exists():
            path.unlink()
        conn = sqlite3.connect(str(path))
        try:
            tables = req.get("tables") or {name: req.get("rows") or []}
            for table, rows in tables.items():
                frame = pd.DataFrame(rows)
                # Sanitize the table name to a plain identifier.
                safe = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in str(table))
                if not safe or safe[0].isdigit():
                    safe = f"t_{safe}"
                frame.to_sql(safe, conn, index=False, if_exists="replace")
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    raise ValueError(f"unsupported write format: {fmt}")


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        _emit({"error": "empty request"})
        return 1
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"bad request JSON: {exc}\n")
        return 1

    try:
        if req.get("op") == "read":
            _emit(_read(req))
            return 0
        if req.get("op") == "write":
            _emit(_write(req))
            return 0
        sys.stderr.write(f"unknown op: {req.get('op')!r}\n")
        return 1
    except ImportError as exc:
        sys.stderr.write(
            f"missing dependency: {exc}\n"
            "install with: pip install pandas pyarrow openpyxl\n"
        )
        return 2
    except Exception as exc:  # noqa: BLE001 - surface any failure to the caller
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        return 3


if __name__ == "__main__":
    raise SystemExit(main())