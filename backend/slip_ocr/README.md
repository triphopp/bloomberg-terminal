# slip-ocr

Broker order-slip screenshot → trade-entry fields. It runs OCR on this machine,
parses the broker's layout, checks the numbers against each other, and returns
the form fields to fill in. It never saves anything. The host app decides what
to do with the result.

Today it lives in `bloomberg-terminal/backend/slip_ocr/`. It imports nothing
from the host, so the folder can become its own repo without changes:

```bash
git subtree split --prefix=backend/slip_ocr -b slip-ocr-only   # history kept
```

## Use

```python
from slip_ocr import read_slip, parse_tokens, Token

out = read_slip(image_bytes)                     # OCR → parse → validate → form
out = read_slip(image_bytes, fee_schedule=fn)    # + the fee-schedule check
out = parse_tokens(tokens)                       # no OCR: tokens from anywhere
```

`out`:

| key | |
|---|---|
| `status` | `ok` (all fields read, all checks pass) · `review` (filled, something to check) · `fail` |
| `form` | `side, symbol, volume, date_entry/exit, price_entry/exit, fee_entry/exit, fee_breakdown, note, broker_order_ref, executed_at, account_hint` (strings; `account_hint` is always `None` because the host maps `broker` to its own accounts) |
| `slip` | every field as `{value, confidence, raw}`, plus `derived` (exact price, fee total, NY trade date, UTC time) |
| `checks` | `[{id, level: ok\|warn\|error, message}]` |
| `warnings`, `image_sha256`, `ocr` | |

### Checks

| id | rule |
|---|---|
| `value` | qty × shown price ≈ value, within the display rounding. The exact price is value ÷ qty (Dime rounds the price it shows) |
| `total` | BUY: value + commission + VAT (+ SEC + TAF) = order amount |
| `schedule` | fees vs `fee_schedule`, only when the caller passes one |
| `ref_date` | the date inside the order number = the fill date |
| `sequence` | filled at or after submitted |

A single misread digit breaks `value` or `total`. These checks, not the OCR
confidence, are what make the auto-fill safe.

### `fee_schedule`

The engine knows no fee rates:

```python
def fee_schedule(broker: str, currency: str, side: str, qty: float, price: float) -> dict | None:
    return {"commission": 2.85, "vat": 0.20, "total": 3.05, "label": "Dime schedule"}  # or None
```

## OCR backends

The first one installed is used. Both run in a spawned worker process that
stays up, so the model loads once. Call `slip_ocr.ocr.warm()` to load it early.

| backend | install | per slip (CPU) | notes |
|---|---|---|---|
| RapidOCR, PP-OCRv5 mobile Thai rec, ONNX Runtime | `pip install slip-ocr[rapid]` | ~1.5 s | exact Thai marks and Latin case |
| easyocr, torch | `pip install slip-ocr[easy]` | 12–25 s | fallback |

Why a worker process: inside a large host process on Windows, torch fails with
WinError 1114 and onnxruntime segfaults, once the host's other native libraries
are loaded. The host must never import either one. `ocr.py` checks for them
with `find_spec` only. A script that uses the worker needs a real `__main__`
file (`python - <<EOF` cannot spawn).

Speed, measured on one Dime slip: parsing takes ~30 ms and the worker round-trip
~20 ms. Everything else is the neural network. Rewriting the parser in C or Rust
would not help. The OCR backend is what decides the speed.

## Layout

```
__init__.py    read_slip / parse_tokens / status
ocr.py         image → Token list (backend pick, worker process)
layout.py      Token geometry; Thai-tolerant fuzzy label lookup; number parsing
thai_date.py   "25 ก.ย. 69 - 20:45 น." → 2026-09-25T20:45 (Buddhist Era)
parsers/       one module per broker layout: claims(tokens) + parse(tokens)
validate.py    the checks above
mapping.py     slip → form fields
tests/         engine-only; fixtures = recorded OCR tokens (no model needed)
```

### Adding a broker layout

1. Record tokens from a real slip (`ocr.read(bytes)` → JSON). **Redact account
   numbers** before committing the fixture.
2. Add `parsers/<broker>.py` with `claims()` (2 or more distinctive labels) and
   `parse()` that returns the same `fields` keys as `dime.py`.
3. Register it in `parsers/__init__.py:PARSERS`, then write a test that uses the
   fixture.

## Tests

```bash
pip install -e ".[test]"   # from this directory
pytest                     # engine only, no OCR model needed
```

The fixtures hold real order numbers and amounts (the account number is
replaced). Review them before making the repo public.
