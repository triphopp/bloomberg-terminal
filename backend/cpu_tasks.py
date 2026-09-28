"""CPU-bound task functions for cpu_pool.run — module-level, picklable, and
light on imports (a spawned worker imports this module, not the app)."""

from __future__ import annotations


def parse_acm_xls(content: bytes, start: str) -> dict[str, dict[str, float]]:
    """NY Fed ACM .xls bytes → {column: {date: value}} for 10Y yield, TP, RN yield."""
    import io

    import pandas as pd

    df = pd.read_excel(io.BytesIO(content), sheet_name="ACM Daily",
                       usecols=["DATE", "ACMY10", "ACMTP10", "ACMRNY10"])
    df["DATE"] = pd.to_datetime(df["DATE"], format="%d-%b-%Y", errors="coerce")
    df = df.dropna()
    df = df[df["DATE"] >= start]
    ds = df["DATE"].dt.strftime("%Y-%m-%d").tolist()
    return {col: dict(zip(ds, (round(float(v), 4) for v in df[col]))) for col in
            ("ACMY10", "ACMTP10", "ACMRNY10")}
