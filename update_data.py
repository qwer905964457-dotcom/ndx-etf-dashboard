import json
import os
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DATA_PATH = Path(__file__).with_name("data.json")
REQUIRED_CODES = {
    "159941", "159632", "513100", "513300", "513390", "513870",
    "159659", "513110", "159513", "159501", "159660", "159696"
}


def load_local() -> dict:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def load_remote(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "ndx-etf-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def validate(data: dict) -> None:
    funds = data.get("funds", [])
    codes = {str(item.get("code")) for item in funds}
    missing = REQUIRED_CODES - codes
    if missing:
        raise ValueError(f"缺少 ETF 代码: {sorted(missing)}")


def main() -> None:
    data = load_local()
    remote_url = os.getenv("ETF_DATA_URL", "").strip()

    if remote_url:
        incoming = load_remote(remote_url)
        validate(incoming)
        data = incoming

    validate(data)
    data["updated_at"] = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")
    DATA_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
