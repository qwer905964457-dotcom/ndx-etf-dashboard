from __future__ import annotations

import json
import math
import re
import statistics
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

DATA_PATH = Path(__file__).with_name("data.json")
TZ = ZoneInfo("Asia/Shanghai")
REQUIRED_CODES = {
    "159941", "159632", "513100", "513300", "513390", "513870",
    "159659", "513110", "159513", "159501", "159660", "159696",
}
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "Chrome/126.0 Safari/537.36 ndx-etf-dashboard/2.2"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
}
SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def load_local() -> dict:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def validate(data: dict) -> None:
    funds = data.get("funds", [])
    codes = {str(item.get("code")) for item in funds}
    missing = REQUIRED_CODES - codes
    if missing:
        raise ValueError(f"缺少 ETF 代码: {sorted(missing)}")


def get(url: str, *, timeout: int = 25) -> requests.Response:
    response = SESSION.get(url, timeout=timeout)
    response.raise_for_status()
    return response


def parse_number(text: str) -> float | None:
    match = re.search(r"-?\d+(?:\.\d+)?", text.replace(",", ""))
    return round(float(match.group(0)), 2) if match else None


def parse_percent(text: str) -> float | None:
    match = re.search(r"(-?\d+(?:\.\d+)?)\s*%", text.replace(",", ""))
    return round(float(match.group(1)), 2) if match else None


def normalize_date(text: str) -> str | None:
    text = text.strip()
    full = re.search(r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})", text)
    if full:
        return f"{int(full.group(1)):04d}-{int(full.group(2)):02d}-{int(full.group(3)):02d}"
    short = re.search(r"(?<!\d)(\d{1,2})[-/.](\d{1,2})(?!\d)", text)
    if short:
        now = datetime.now(TZ)
        return f"{now.year:04d}-{int(short.group(1)):02d}-{int(short.group(2)):02d}"
    return None


def date_key(value: str | None) -> str:
    return value or "0000-00-00"


def fetch_haoetf(code: str) -> dict | None:
    url = f"https://www.haoetf.com/qdii/{code}"
    response = get(url)
    soup = BeautifulSoup(response.text, "html.parser")
    page_text = soup.get_text(" ", strip=True)
    updated_match = re.search(
        r"数据更新时间[：:\s]*(20\d{2}-\d{2}-\d{2})(?:\s+\d{2}:\d{2}:\d{2})?",
        page_text,
    )
    page_date = updated_match.group(1) if updated_match else datetime.now(TZ).strftime("%Y-%m-%d")

    for row in soup.find_all("tr"):
        cells = [cell.get_text(" ", strip=True) for cell in row.find_all(["td", "th"])]
        if not cells or cells[0].strip() != code:
            continue

        candidates: list[tuple[float, str]] = []
        if len(cells) > 3:
            value = parse_percent(cells[3])
            if value is not None:
                candidates.append((value, page_date))
        if len(cells) > 5:
            value = parse_percent(cells[5])
            if value is not None:
                item_date = normalize_date(cells[6]) if len(cells) > 6 else None
                candidates.append((value, item_date or page_date))

        if not candidates:
            for cell in cells[:7]:
                value = parse_percent(cell)
                if value is not None:
                    candidates.append((value, page_date))
                    break

        if candidates:
            premium, premium_date = candidates[0]
            return {
                "premium": premium,
                "premium_date": premium_date,
                "premium_source": "HaoETF",
                "source_url": url,
            }
    return None


def fetch_stockstar(code: str) -> dict | None:
    rows = fetch_stockstar_history(code, limit=1)
    if not rows:
        return None
    latest = rows[-1]
    return {
        "premium": latest["premium"],
        "premium_date": latest["date"],
        "premium_source": "证券之星折溢价历史",
        "source_url": f"https://fund.stockstar.com/funds/f10/fundzyj_{code}.html",
    }


def fetch_stockstar_history(code: str, *, limit: int = 220) -> list[dict]:
    """读取证券之星折溢价历史。返回按日期升序排列的 {date, premium}。"""
    url = f"https://fund.stockstar.com/funds/f10/fundzyj_{code}.html"
    response = get(url)
    response.encoding = response.apparent_encoding or response.encoding
    soup = BeautifulSoup(response.text, "html.parser")

    by_date: dict[str, float] = {}
    for row in soup.find_all("tr"):
        cells = [cell.get_text(" ", strip=True) for cell in row.find_all(["td", "th"])]
        if len(cells) < 3 or not re.fullmatch(r"\d+", cells[0]):
            continue
        premium_date = normalize_date(cells[1])
        # 该页面表头写“折溢价率(%)”，数据单元格本身通常只有“7.87”，不含%号。
        premium = parse_number(cells[2])
        if premium_date and premium is not None:
            by_date[premium_date] = premium

    rows = [
        {"date": date, "premium": premium}
        for date, premium in sorted(by_date.items())
    ]
    return rows[-limit:]


def fetch_premium(code: str) -> dict:
    errors: list[str] = []
    for name, fetcher in (("HaoETF", fetch_haoetf), ("证券之星", fetch_stockstar)):
        try:
            result = fetcher(code)
            if result:
                return result
            errors.append(f"{name}: 页面未解析到数据")
        except Exception as exc:
            errors.append(f"{name}: {type(exc).__name__}")
    raise RuntimeError("; ".join(errors))


def grade_for(score: int) -> str:
    if score >= 68:
        return "A｜当前优选"
    if score >= 65:
        return "B+｜靠前"
    if score >= 60:
        return "B｜可比较"
    return "C｜等待回落"


def refresh_score(fund: dict) -> None:
    premium = fund.get("premium")
    fee = fund.get("fee")
    if not isinstance(premium, (int, float)) or not isinstance(fee, (int, float)):
        fund["score"] = None
        fund["grade"] = "数据待补"
        return
    score = round(max(0.0, min(100.0, 100 - 4 * premium - 10 * fee)))
    fund["score"] = score
    fund["grade"] = grade_for(score)
    fund["reason"] = (
        f"公开口径溢价{premium:.2f}%（{fund.get('premium_date', '日期未知')}），"
        f"综合费率{fee:.2f}%；评分仅用于市场总览横向比较，首页长期持仓不自动换基。"
    )


def update_fund_premiums(data: dict) -> tuple[int, list[str]]:
    updated = 0
    errors: list[str] = []
    for fund in data["funds"]:
        code = str(fund["code"])
        try:
            incoming = fetch_premium(code)
            old_date = fund.get("premium_date")
            if date_key(incoming.get("premium_date")) >= date_key(old_date):
                fund.update(incoming)
                updated += 1
            refresh_score(fund)
        except Exception as exc:
            errors.append(f"{code}: {exc}")
            refresh_score(fund)
        time.sleep(0.2)
    return updated, errors


def merge_premium_history(data: dict, *, limit: int = 260) -> tuple[int, list[str]]:
    """为“溢价历史百分位”累积样本，不影响当天溢价展示。"""
    history = data.setdefault("history", {})
    store = history.setdefault("premium_by_code", {})
    updated_codes = 0
    errors: list[str] = []

    for fund in data.get("funds", []):
        code = str(fund.get("code"))
        by_date: dict[str, float] = {}

        for item in store.get(code, []):
            date = item.get("date") or item.get("premium_date")
            premium = item.get("premium", item.get("value"))
            if date and isinstance(premium, (int, float)):
                by_date[date] = round(float(premium), 2)

        try:
            for item in fetch_stockstar_history(code, limit=limit):
                by_date[item["date"]] = round(float(item["premium"]), 2)
            updated_codes += 1
        except Exception as exc:
            errors.append(f"{code} history: {type(exc).__name__}: {exc}")

        # 同一天 HaoETF 与证券之星可能口径略有差异；首页决策使用当前 fund.premium，
        # 所以历史库里当天值也优先采用当前展示值，避免百分位和页面溢价打架。
        current_date = fund.get("premium_date")
        current_premium = fund.get("premium")
        if current_date and isinstance(current_premium, (int, float)):
            by_date[current_date] = round(float(current_premium), 2)

        store[code] = [
            {"date": date, "premium": premium}
            for date, premium in sorted(by_date.items())[-limit:]
        ]
        time.sleep(0.15)

    return updated_codes, errors


def yahoo_series(symbol: str) -> tuple[list[str], list[float]]:
    encoded = quote(symbol, safe="")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?range=6mo&interval=1d"
    response = get(url, timeout=20)
    payload = response.json()
    result = payload["chart"]["result"][0]
    timestamps = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]

    dates: list[str] = []
    values: list[float] = []
    for timestamp, close in zip(timestamps, closes):
        if close is None:
            continue
        dates.append(datetime.fromtimestamp(timestamp, TZ).strftime("%Y-%m-%d"))
        values.append(float(close))
    if len(values) < 2:
        raise ValueError(f"{symbol} 行情点数不足")
    return dates, values


def annualized_volatility(values: list[float], window: int) -> float | None:
    if len(values) < window + 1:
        return None
    returns = [
        math.log(values[index] / values[index - 1])
        for index in range(len(values) - window, len(values))
        if values[index] > 0 and values[index - 1] > 0
    ]
    if len(returns) < 2:
        return None
    return round(statistics.stdev(returns) * math.sqrt(252) * 100, 2)


def update_risk(data: dict) -> tuple[int, list[str]]:
    risk = data.setdefault("risk", {})
    history = data.setdefault("history", {})
    updates = 0
    errors: list[str] = []

    for key, symbol in (("vix", "^VIX"), ("ndx", "^NDX")):
        try:
            dates, values = yahoo_series(symbol)
            risk[key] = round(values[-1], 2)
            risk[f"{key}_date"] = dates[-1]
            history[key] = [
                {"date": date, "value": round(value, 2)}
                for date, value in zip(dates[-120:], values[-120:])
            ]
            if key == "ndx":
                risk["change1"] = round((values[-1] / values[-2] - 1) * 100, 2)
                if len(values) >= 21:
                    risk["change20"] = round((values[-1] / values[-21] - 1) * 100, 2)
                risk["vol20"] = annualized_volatility(values, 20)
                risk["vol60"] = annualized_volatility(values, 60)
                rolling_high = max(values[-120:])
                risk["drawdown_from_high"] = round((values[-1] / rolling_high - 1) * 100, 2)
            updates += 1
        except Exception as exc:
            errors.append(f"{symbol}: {type(exc).__name__}: {exc}")
    return updates, errors


def ensure_defaults(data: dict) -> None:
    data.setdefault("settings", {})
    data["settings"].setdefault("primary_etf", "513390")
    data["settings"].setdefault(
        "primary_note",
        "首页固定分析一只长期持仓；可在“我的ETF”页面改成你的实际持仓，本机浏览器会记住。",
    )
    data.setdefault("investment", {})
    data["investment"].setdefault("daily_amount_yuan", 200)
    data.setdefault(
        "otc_limits_note",
        "场外每日限额为手动快照，额度变化很快，仅作资金安排参考；后续可接入自动数据源。",
    )
    data.setdefault(
        "otc_limits",
        [
            {
                "limit_yuan": 100,
                "status": "可申购",
                "funds": ["建信 539001/012752"],
                "note": "普通代销 A/C 份额快照",
            },
            {
                "limit_yuan": 10,
                "status": "可申购",
                "funds": [
                    "宝盈 019736/019737",
                    "大成 000834/008971",
                    "华安 040046/014978",
                    "华泰柏瑞 019524/019525",
                    "汇添富 018966/018967",
                    "摩根 019172/019173",
                    "南方 016452/016453",
                    "万家 019441/019442",
                    "招商 019547/019548",
                ],
                "note": "多只基金处于10元/日档",
            },
            {
                "limit_yuan": 5,
                "status": "可申购",
                "funds": ["广发 270042/006479"],
                "note": "普通代销 A/C 份额快照",
            },
            {
                "limit_yuan": 0,
                "status": "暂停申购/当前不可买",
                "funds": [
                    "国泰 160213",
                    "华夏 015299/015300",
                    "嘉实 016532/016533",
                    "天弘 018043/018044",
                    "易方达 161130/012870",
                    "博时 016055/016057",
                ],
                "note": "页面可能显示上限，但暂停申购时实际可买按0处理",
            },
        ],
    )


def main() -> None:
    data = load_local()
    validate(data)
    ensure_defaults(data)

    fund_updates, fund_errors = update_fund_premiums(data)
    history_updates, history_errors = merge_premium_history(data)
    risk_updates, risk_errors = update_risk(data)

    now = datetime.now(TZ)
    data["checked_at"] = now.strftime("%Y-%m-%d %H:%M:%S")
    if fund_updates or risk_updates or history_updates:
        data["updated_at"] = data["checked_at"]

    premium_dates = [
        fund.get("premium_date")
        for fund in data["funds"]
        if fund.get("premium_date")
    ]
    risk_dates = [
        data.get("risk", {}).get("vix_date"),
        data.get("risk", {}).get("ndx_date"),
    ]
    all_dates = [value for value in premium_dates + risk_dates if value]
    data["market_data_as_of"] = max(all_dates) if all_dates else data.get("market_data_as_of")

    errors = fund_errors + history_errors + risk_errors
    data["update_status"] = {
        "funds_updated": fund_updates,
        "premium_history_updated": history_updates,
        "risk_series_updated": risk_updates,
        "errors": errors,
    }
    data["source_note_short"] = "ETF溢价：HaoETF/证券之星；行情：Yahoo Finance（失败保留旧值）"
    data["source_note"] = (
        "ETF溢价优先读取HaoETF公开页面，失败时回退到证券之星折溢价历史；"
        "溢价历史百分位通过证券之星历史样本与本地每日样本合并计算；"
        "VIX与纳指100使用Yahoo Finance公开行情序列。抓取失败会保留旧值，"
        "不会用新时间覆盖成伪最新。综合评分仅用于市场总览横向比较。"
    )

    DATA_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"ETF更新 {fund_updates}/12，溢价历史更新 {history_updates}/12，"
        f"风险序列更新 {risk_updates}/2，错误 {len(errors)} 个。"
    )


if __name__ == "__main__":
    main()
