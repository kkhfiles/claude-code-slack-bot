"""파이썬 Agent SDK 의 판과 짝 Claude Code 판 — `scripts/sdk-update.mjs` 가 부른다.

    python -X utf8 scripts/lib/sdk_py_versions.py --installed        # ["0.2.161", "2.1.284"]
    python -X utf8 scripts/lib/sdk_py_versions.py --newer 0.2.161    # [{"version", "pair"}, …] 새 것부터

짝 판(`claude_agent_sdk._cli_version.__cli_version__`)은 PyPI 메타데이터에 없다. 그래서 새 판마다 소스
배포본을 받아 그 파일만 읽는다(한 판에 수백 KB). 윈도에는 소스 배포본만 받아지므로(설치본이 PyPI 파일 크기
한도를 넘어 빠진다) 설치될 것도 그것이다.
"""
from __future__ import annotations

import io
import json
import re
import sys
import tarfile
import urllib.request

PKG = "claude-agent-sdk"
MAX_NEWER = 6  # 몇 주 밀려도 이 안에서 고른다 — 더 받는 것은 느리기만 하다


def _key(v: str) -> list[int] | None:
    return [int(x) for x in v.split(".")] if re.fullmatch(r"\d+\.\d+\.\d+", v) else None


def installed() -> list[str]:
    import claude_agent_sdk as sdk  # noqa: PLC0415
    from claude_agent_sdk import _cli_version  # noqa: PLC0415
    return [sdk.__version__, _cli_version.__cli_version__]


def newer(than: str) -> list[dict]:
    with urllib.request.urlopen(f"https://pypi.org/pypi/{PKG}/json", timeout=20) as r:
        meta = json.load(r)
    base = _key(than) or [0, 0, 0]
    vs = sorted((v for v in meta["releases"] if _key(v) and _key(v) > base), key=_key, reverse=True)
    out = []
    for v in vs[:MAX_NEWER]:
        sdist = [f for f in meta["releases"][v] if f.get("packagetype") == "sdist"]
        if not sdist:
            continue
        with urllib.request.urlopen(sdist[0]["url"], timeout=60) as r:
            data = r.read()
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            name = next((n for n in tf.getnames() if n.endswith("claude_agent_sdk/_cli_version.py")), None)
            if not name:
                continue
            m = re.search(r'"(\d+\.\d+\.\d+)"', tf.extractfile(name).read().decode("utf-8"))
        if m:
            out.append({"version": v, "pair": m.group(1)})
    return out


if __name__ == "__main__":
    if sys.argv[1:2] == ["--installed"]:
        print(json.dumps(installed()))
    elif sys.argv[1:2] == ["--newer"] and len(sys.argv) > 2:
        print(json.dumps(newer(sys.argv[2])))
    else:
        sys.exit("사용: --installed | --newer <판>")
