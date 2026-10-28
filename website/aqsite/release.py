"""Latest release metadata for the download page.

At build time the GitHub API is queried for the latest published release so
file names and sizes are exact. Without network access the asset list is
reconstructed from the version in the root package.json using the naming
scheme produced by .github/workflows/release.yml.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .config import CACHE_DIR, GITHUB_NAME, GITHUB_OWNER, GITHUB_RELEASES, REPO_ROOT

API = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_NAME}"


@dataclass(frozen=True)
class AssetRule:
    id: str
    os: str
    arch: str  # arm64 | x64
    kind: str  # translation key suffix under download.kind.*
    pattern: re.Pattern
    primary: bool = False


# Order matters: it is the display order inside each OS tab.
RULES = [
    AssetRule("mac-arm64", "macos", "arm64", "dmg", re.compile(r"_aarch64\.dmg$"), True),
    AssetRule("mac-x64", "macos", "x64", "dmg", re.compile(r"_x64\.dmg$"), True),
    AssetRule("win-x64-setup", "windows", "x64", "setup", re.compile(r"_x64-setup\.exe$"), True),
    AssetRule("win-arm64-setup", "windows", "arm64", "setup", re.compile(r"_arm64-setup\.exe$"), True),
    AssetRule("win-x64-msi", "windows", "x64", "msi", re.compile(r"_x64_[a-zA-Z-]+\.msi$")),
    AssetRule("win-arm64-msi", "windows", "arm64", "msi", re.compile(r"_arm64_[a-zA-Z-]+\.msi$")),
    AssetRule("win-x64-portable", "windows", "x64", "portable", re.compile(r"windows-x64-portable\.zip$")),
    AssetRule("win-arm64-portable", "windows", "arm64", "portable", re.compile(r"windows-arm64-portable\.zip$")),
    AssetRule("linux-x64-appimage", "linux", "x64", "appimage", re.compile(r"_amd64\.AppImage$"), True),
    AssetRule("linux-x64-deb", "linux", "x64", "deb", re.compile(r"_amd64\.deb$"), True),
    AssetRule("linux-x64-rpm", "linux", "x64", "rpm", re.compile(r"\.x86_64\.rpm$")),
    AssetRule("linux-arm64-appimage", "linux", "arm64", "appimage", re.compile(r"_aarch64\.AppImage$")),
    AssetRule("linux-arm64-deb", "linux", "arm64", "deb", re.compile(r"_arm64\.deb$")),
    AssetRule("linux-arm64-rpm", "linux", "arm64", "rpm", re.compile(r"\.aarch64\.rpm$")),
]

OS_ORDER = ["macos", "windows", "linux"]


@dataclass
class Asset:
    id: str
    os: str
    arch: str
    kind: str
    name: str
    url: str
    size: int | None
    primary: bool

    @property
    def size_label(self) -> str:
        return format_size(self.size)


@dataclass
class Release:
    version: str
    tag: str
    url: str
    published: datetime | None
    assets: list[Asset] = field(default_factory=list)
    live: bool = False  # True when fetched from the API

    def by_os(self, os_id: str) -> list[Asset]:
        return [a for a in self.assets if a.os == os_id]

    def asset(self, asset_id: str) -> Asset | None:
        return next((a for a in self.assets if a.id == asset_id), None)


def package_version() -> str:
    return json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))["version"]


def _classify(name: str) -> AssetRule | None:
    if name.endswith((".sig", ".json", ".tar.gz")):
        return None
    return next((r for r in RULES if r.pattern.search(name)), None)


def _build_assets(entries: list[tuple[str, str, int | None]]) -> list[Asset]:
    found: dict[str, Asset] = {}
    for name, url, size in entries:
        rule = _classify(name)
        if rule and rule.id not in found:
            found[rule.id] = Asset(rule.id, rule.os, rule.arch, rule.kind, name, url, size, rule.primary)
    return [found[r.id] for r in RULES if r.id in found]


def _fallback_names(version: str) -> list[str]:
    v = version
    return [
        f"AQBot_{v}_aarch64.dmg",
        f"AQBot_{v}_x64.dmg",
        f"AQBot_{v}_x64-setup.exe",
        f"AQBot_{v}_arm64-setup.exe",
        f"AQBot_{v}_x64_en-US.msi",
        f"AQBot_{v}_arm64_en-US.msi",
        f"AQBot_v{v}_windows-x64-portable.zip",
        f"AQBot_v{v}_windows-arm64-portable.zip",
        f"AQBot_{v}_amd64.AppImage",
        f"AQBot_{v}_amd64.deb",
        f"AQBot-{v}-1.x86_64.rpm",
        f"AQBot_{v}_arm64.deb",
        f"AQBot-{v}-1.aarch64.rpm",
    ]


def _fetch_json(url: str) -> dict:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "aqbot-website-build"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as resp:
        return json.load(resp)


def _from_api(data: dict) -> Release:
    tag = data["tag_name"]
    published = data.get("published_at")
    return Release(
        version=tag.lstrip("v"),
        tag=tag,
        url=data["html_url"],
        published=datetime.fromisoformat(published.replace("Z", "+00:00")) if published else None,
        assets=_build_assets([(a["name"], a["browser_download_url"], a.get("size")) for a in data.get("assets", [])]),
        live=True,
    )


def _fallback() -> Release:
    version = package_version()
    tag = f"v{version}"
    base = f"{GITHUB_RELEASES}/download/{tag}"
    return Release(
        version=version,
        tag=tag,
        url=f"{GITHUB_RELEASES}/tag/{tag}",
        published=None,
        assets=_build_assets([(n, f"{base}/{n}", None) for n in _fallback_names(version)]),
    )


def load_release(offline: bool = False) -> Release:
    cache = CACHE_DIR / "release.json"
    if not offline:
        try:
            data = _fetch_json(f"{API}/releases/latest")
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(data), encoding="utf-8")
            return _from_api(data)
        except Exception as exc:  # network or rate limit: degrade gracefully
            print(f"[release] GitHub API unavailable ({exc}); using fallback")
    if cache.exists():
        return _from_api(json.loads(cache.read_text(encoding="utf-8")))
    return _fallback()


def load_stars(offline: bool = False) -> int | None:
    if offline:
        return None
    try:
        return int(_fetch_json(API)["stargazers_count"])
    except Exception:
        return None


def format_size(size: int | None) -> str:
    if not size:
        return ""
    return f"{size / 1024 / 1024:.1f} MB"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
