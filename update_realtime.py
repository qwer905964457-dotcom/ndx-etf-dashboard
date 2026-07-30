from __future__ import annotations

import json
import math
import re
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
REALTIME_PATH = ROOT / "realtime.json"
CALENDAR_PATH = ROOT / "market-calendar.json"
TZ = ZoneInfo("Asia/Shanghai")

ETF_LIST = [
    ("159941", "广发"), ("159632", "华安"), ("513100", "国泰"), ("513300", "华夏"),
    ("513390", "博时"), ("513870", "富国"), ("159659", "招商"), ("513110", "华泰柏瑞"),
    ("159513", "大成"), ("159501", "嘉实"), ("159660", "汇添富"), ("159696", "易方达"),
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 ndx-etf-dashboard-realtime/1.0",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
}
SESSION = requests.Session()
SESSION.headers.update(HEADERS)

FRESH_MINUTES = 8
DELAY_MINUTES = 30
MISSING_TOKENS = {"", "-", "--", "暂无数据", "null", "none", "nan", "n/a"}


def now_cn() -> datetime:
    return datetime.now(TZ)


def parse_num(value) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).replace(",", "").strip()
    if text.lower() in MISSING_TOKENS:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    if not match:
        return None
    number = float(match.group(0))
    return round(number, 4) if math.isfinite(number) else None


def parse_pct(value) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).replace(",", "").strip()
    if text.lower() in MISSING_TOKENS:
        return None
    match = re.search(r"(-?\d+(?:\.\d+)?)\s*%", text)
    if not match:
        return None
    number = float(match.group(1))
    return round(number, 2) if math.isfinite(number) else None


def valid_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalize_datetime(text: str | None) -> str | None:
    if not text:
        return None
    value = str(text).strip()
    full = re.search(
        r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:\s+(\d{1,2}:\d{1,2}(?::\d{1,2})?))?",
        value,
    )
    if full:
        date = f"{int(full.group(1)):04d}-{int(full.group(2)):02d}-{int(full.group(3)):02d}"
        if not full.group(4):
            return date
        parts = full.group(4).split(":")
        if len(parts) == 2:
            parts.append("00")
        return f"{date} {int(parts[0]):02d}:{int(parts[1]):02d}:{int(parts[2]):02d}"
    short = re.search(r"(?<!\d)(\d{1,2})[-/.](\d{1,2})(?!\d)", value)
    if short:
        n = now_cn()
        return f"{n.year:04d}-{int(short.group(1)):02d}-{int(short.group(2)):02d}"
    return None


def parse_cn_datetime(value: str | None) -> datetime | None:
    normalized = normalize_datetime(value)
    if not normalized or " " not in normalized:
        return None
    return datetime.strptime(normalized, "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)


def load_calendar() -> dict:
    if not CALENDAR_PATH.exists():
        return {"closed_dates": [], "open_dates": [], "source": "未加载交易日历"}
    return json.loads(CALENDAR_PATH.read_text(encoding="utf-8"))


def market_status(calendar: dict) -> dict:
    n = now_cn()
    date = n.strftime("%Y-%m-%d")
    weekday = n.weekday()  # Monday=0
    closed = {item.get("date"): item.get("reason", "休市") for item in calendar.get("closed_dates", [])}
    open_dates = set(calendar.get("open_dates", []))
    if date in open_dates:
        is_trading_day, reason = True, "交易日历指定开市"
    elif date in closed:
        is_trading_day, reason = False, closed[date]
    elif weekday >= 5:
        is_trading_day, reason = False, "周末休市"
    else:
        is_trading_day, reason = True, "交易日"

    minute = n.hour * 60 + n.minute
    is_session = is_trading_day and ((9 * 60 + 30 <= minute <= 11 * 60 + 30) or (13 * 60 <= minute <= 15 * 60))
    return {
        "date": date,
        "time": n.strftime("%H:%M:%S"),
        "is_trading_day": is_trading_day,
        "is_trading_session": is_session,
        "reason": reason,
        "calendar_source": calendar.get("source", "market-calendar.json"),
    }


def secid(code: str) -> str:
    return f"{'1' if code.startswith('5') else '0'}.{code}"


def get(url: str, timeout: int = 20) -> requests.Response:
    resp = SESSION.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp


def fetch_eastmoney_quotes() -> dict[str, dict]:
    fields = "f12,f14,f2,f3,f4,f18,f124"
    url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=" + fields + "&secids=" + ",".join(secid(code) for code, _ in ETF_LIST)
    payload = get(url, timeout=15).json()
    rows = payload.get("data", {}).get("diff", []) or []
    result = {}
    for row in rows:
        code = str(row.get("f12") or "")
        ts = parse_num(row.get("f124"))
        quote_time = None
        if ts:
            quote_time = datetime.fromtimestamp(float(ts), TZ).strftime("%Y-%m-%d %H:%M:%S")
        result[code] = {
            "price": parse_num(row.get("f2")),
            "change_pct": parse_num(row.get("f3")),
            "prev_close": parse_num(row.get("f18")),
            "quote_name": row.get("f14"),
            "quote_time": quote_time,
            "quote_source": "东方财富行情接口",
        }
    return result


def fetch_haoetf(code: str) -> dict:
    url = f"https://www.haoetf.com/qdii/{code}"
    resp = get(url, timeout=20)
    soup = BeautifulSoup(resp.text, "html.parser")
    text = soup.get_text(" ", strip=True)
    time_match = re.search(r"数据更新时间[：:\s]*(20\d{2}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)", text)
    page_time = normalize_datetime(time_match.group(1)) if time_match else now_cn().strftime("%Y-%m-%d")

    for tr in soup.find_all("tr"):
        cells = [cell.get_text(" ", strip=True) for cell in tr.find_all(["td", "th"])]
        if not cells or cells[0].strip() != code:
            continue
        candidates: list[tuple[float, str | None]] = []
        if len(cells) > 3:
            v = parse_pct(cells[3])
            if v is not None and abs(v) < 60:
                candidates.append((v, page_time))
        if len(cells) > 5:
            v = parse_pct(cells[5])
            dt = normalize_datetime(cells[6]) if len(cells) > 6 else None
            if v is not None and abs(v) < 60:
                candidates.append((v, dt or page_time))
        if candidates:
            premium, data_time = candidates[0]
            return {
                "premium": premium,
                "premium_source": "HaoETF公开页面",
                "premium_url": url,
                "data_time": data_time,
            }
    raise RuntimeError("HaoETF未解析到溢价")


def classify_time(data_time: str | None, status: dict, quality: str) -> tuple[str, bool, str]:
    n = now_cn()
    dt = parse_cn_datetime(data_time)
    normalized = normalize_datetime(data_time)
    if not normalized:
        return "missing", False, "无时间戳，不提醒"
    if " " not in normalized:
        if normalized == status["date"]:
            return "today", False, "今日无分钟级时间，只展示"
        return "stale", False, "非今日数据，不提醒"
    if dt is None:
        return "missing", False, "时间戳无法解析，不提醒"
    if dt.strftime("%Y-%m-%d") != status["date"]:
        return "stale", False, "非今日数据，不提醒"
    age_min = max(0.0, (n - dt).total_seconds() / 60)
    if age_min <= FRESH_MINUTES:
        can_alert = bool(status.get("is_trading_session"))
        label = "分钟级公开数据，可提醒" if quality != "calculated_iopv" else "实时价÷IOPV，可提醒"
        if not can_alert:
            label = "分钟级数据，但非交易时段，只展示"
        return "realtime", can_alert, label
    if age_min <= DELAY_MINUTES:
        return "delayed", False, "延迟数据，只展示"
    return "stale", False, "时间过旧，不提醒"


def zone_label(premium: float | None) -> str:
    if not valid_number(premium):
        return "暂无数据"
    if premium <= 3:
        return "底仓区"
    if premium <= 5:
        return "观察区"
    if premium <= 7:
        return "可小口"
    if premium <= 9:
        return "偏高"
    return "高溢价"


def apply_signal_status(item: dict, status: dict) -> None:
    item["price"] = parse_num(item.get("price"))
    item["iopv"] = parse_num(item.get("iopv"))
    item["premium"] = parse_num(item.get("premium"))
    freshness, can_alert, fresh_label = classify_time(item.get("data_time"), status, item["quality"])
    if not valid_number(item["premium"]):
        can_alert = False
        fresh_label = "溢价暂无数据，不提醒"
    item["freshness"] = freshness
    item["can_alert"] = can_alert
    item["fresh_label"] = fresh_label
    item["status"] = zone_label(item["premium"])


def main() -> None:
    calendar = load_calendar()
    status = market_status(calendar)
    generated_at = now_cn().strftime("%Y-%m-%d %H:%M:%S")

    try:
        quote_map = fetch_eastmoney_quotes()
        quote_error = None
    except Exception as exc:
        quote_map = {}
        quote_error = f"东方财富行情接口: {type(exc).__name__}: {exc}"

    funds = []
    errors = []
    for code, company in ETF_LIST:
        item = {
            "code": code,
            "company": company,
            "name": f"{company}纳指100ETF",
            "price": None,
            "change_pct": None,
            "iopv": None,
            "premium": None,
            "data_time": None,
            "source": "暂无数据",
            "source_url": None,
            "source_label": "暂无数据",
            "quality": "missing",
            "freshness": "missing",
            "can_alert": False,
            "fresh_label": "暂无数据，不提醒",
            "status": "暂无数据",
            "error": None,
        }
        quote = quote_map.get(code) or {}
        item.update({
            "price": parse_num(quote.get("price")),
            "change_pct": parse_num(quote.get("change_pct")),
            "quote_time": quote.get("quote_time"),
            "quote_source": quote.get("quote_source"),
        })
        try:
            premium = fetch_haoetf(code)
            item.update({
                "premium": premium["premium"],
                "data_time": premium.get("data_time"),
                "source": premium["premium_source"],
                "source_url": premium["premium_url"],
                "source_label": "公开分钟级溢价" if " " in str(premium.get("data_time")) else "公开页面溢价",
                "quality": "public_page",
            })
        except Exception as exc:
            msg = f"{code}: HaoETF: {type(exc).__name__}: {exc}"
            errors.append(msg)
            item["error"] = msg

        apply_signal_status(item, status)
        funds.append(item)
        time.sleep(0.15)

    valid = [f for f in funds if valid_number(f.get("premium"))]
    lowest = min(valid, key=lambda f: f["premium"], default=None)
    high = [f for f in valid if f["premium"] >= 9]
    low = [f for f in valid if f["premium"] <= 5]

    payload = {
        "schema_version": "1.0",
        "generated_at": generated_at,
        "updated_at": generated_at,
        "market_status": status,
        "source_note": "盘中监控读取 realtime.json；ETF溢价优先使用公开分钟级溢价源。字段无法可靠取得时保持暂无数据，不用旧值冒充实时。下单前仍以券商APP实时IOPV/溢价复核。",
        "refresh_policy": "GitHub Actions在A股交易时段附近约每5分钟尝试更新；GitHub调度可能延迟。网页每60秒读取本JSON。",
        "summary": {
            "valid_count": len(valid),
            "alertable_count": sum(1 for f in funds if f.get("can_alert")),
            "lowest_code": lowest.get("code") if lowest else None,
            "lowest_premium": lowest.get("premium") if lowest else None,
            "low_premium_count": len(low),
            "high_premium_count": len(high),
            "recommendation": "场外300元/交易日照常；场内额外仓只在低溢价可靠触发后再评估。",
        },
        "funds": funds,
        "errors": ([quote_error] if quote_error else []) + errors,
    }
    REALTIME_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"realtime rows {len(valid)}/12, alertable {payload['summary']['alertable_count']}/12, errors {len(payload['errors'])}")


if __name__ == "__main__":
    main()
