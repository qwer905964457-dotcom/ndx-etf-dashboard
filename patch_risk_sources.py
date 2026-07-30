from __future__ import annotations

from pathlib import Path

PATH = Path('update_data.py')
text = PATH.read_text(encoding='utf-8')

if 'from datetime import datetime, timedelta' not in text:
    text = text.replace('from datetime import datetime\n', 'from datetime import datetime, timedelta\n')

stooq_block = '''def stooq_series(symbols: list[str]) -> tuple[list[str], list[float]]:
    errors: list[str] = []
    for symbol in symbols:
        url = f"https://stooq.com/q/d/l/?s={quote(symbol.lower(), safe='^.')}&i=d"
        try:
            response = get(url, timeout=20)
            text = response.text.strip()
            reader = csv.DictReader(io.StringIO(text))
            dates: list[str] = []
            values: list[float] = []
            for row in reader:
                date = row.get("Date") or row.get("date")
                close = parse_number(row.get("Close") or row.get("close"))
                if date and close is not None:
                    dates.append(date)
                    values.append(float(close))
            if len(values) >= 2:
                return dates[-160:], values[-160:]
            errors.append(f"{symbol}: 点数不足")
        except Exception as exc:
            errors.append(f"{symbol}: {type(exc).__name__}: {exc}")
    raise RuntimeError("Stooq失败: " + "; ".join(errors))


'''
extra_sources = '''def parse_market_date(value: str | None) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%b %d, %Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return normalize_date(text)


def nasdaq_index_series(symbol: str) -> tuple[list[str], list[float]]:
    end = datetime.now(TZ).date()
    start = end - timedelta(days=260)
    url = (
        f"https://api.nasdaq.com/api/quote/{symbol}/historical"
        f"?assetclass=index&fromdate={start:%Y-%m-%d}&todate={end:%Y-%m-%d}&limit=9999"
    )
    headers = {
        **HEADERS,
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://www.nasdaq.com",
        "Referer": f"https://www.nasdaq.com/market-activity/index/{symbol.lower()}/historical",
    }
    response = SESSION.get(url, headers=headers, timeout=25)
    response.raise_for_status()
    payload = response.json()
    rows = payload.get("data", {}).get("tradesTable", {}).get("rows") or []
    parsed: list[tuple[str, float]] = []
    for row in rows:
        date = parse_market_date(row.get("date"))
        close = parse_number(row.get("close"))
        if date and close is not None:
            parsed.append((date, float(close)))
    parsed = sorted(set(parsed))
    if len(parsed) < 2:
        raise RuntimeError(f"Nasdaq API {symbol} 点数不足")
    dates, values = zip(*parsed[-160:])
    return list(dates), list(values)


def cboe_vix_series() -> tuple[list[str], list[float]]:
    url = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"
    response = get(url, timeout=25)
    reader = csv.DictReader(io.StringIO(response.text))
    parsed: list[tuple[str, float]] = []
    for row in reader:
        date = parse_market_date(row.get("DATE") or row.get("Date"))
        close = parse_number(row.get("CLOSE") or row.get("Close"))
        if date and close is not None:
            parsed.append((date, float(close)))
    parsed = sorted(set(parsed))
    if len(parsed) < 2:
        raise RuntimeError("CBOE VIX CSV 点数不足")
    dates, values = zip(*parsed[-160:])
    return list(dates), list(values)


'''
if 'def nasdaq_index_series' not in text:
    text = text.replace(stooq_block, stooq_block + extra_sources)

start = text.index('def series_with_fallback')
end = text.index('\n\ndef annualized_volatility', start)
new_series = '''def series_with_fallback(key: str) -> tuple[list[str], list[float], str]:
    yahoo_symbol = YAHOO_SYMBOLS[key]
    errors: list[str] = []
    try:
        dates, values = yahoo_series(yahoo_symbol)
        return dates, values, f"Yahoo Finance {yahoo_symbol}"
    except Exception as exc:
        errors.append(f"Yahoo: {type(exc).__name__}: {exc}")

    if key == "ndx":
        try:
            dates, values = nasdaq_index_series("NDX")
            return dates, values, "Nasdaq官方历史接口 NDX"
        except Exception as exc:
            errors.append(f"Nasdaq: {type(exc).__name__}: {exc}")

    if key == "vix":
        try:
            dates, values = cboe_vix_series()
            return dates, values, "CBOE VIX历史CSV"
        except Exception as exc:
            errors.append(f"CBOE: {type(exc).__name__}: {exc}")

    try:
        dates, values = stooq_series(STOOQ_SYMBOLS[key])
        return dates, values, f"Stooq {STOOQ_SYMBOLS[key][0]}"
    except Exception as exc:
        errors.append(f"Stooq: {type(exc).__name__}: {exc}")

    raise RuntimeError("; ".join(errors))
'''
text = text[:start] + new_series + text[end:]
text = text.replace('ETF溢价：HaoETF/证券之星；行情：Yahoo Finance，失败回退Stooq', 'ETF溢价：HaoETF/证券之星；行情：Yahoo，失败回退Nasdaq/CBOE/Stooq')
text = text.replace('VIX与纳指100优先使用Yahoo Finance公开行情序列，失败时回退Stooq CSV。', 'VIX与纳指100优先使用Yahoo Finance公开行情序列，失败时回退Nasdaq官方历史接口、CBOE VIX CSV和Stooq CSV。')

PATH.write_text(text, encoding='utf-8')
print('risk source patch applied')
