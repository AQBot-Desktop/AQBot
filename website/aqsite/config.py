"""Static site configuration: locales, URLs, page registry and font roles."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

WEBSITE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = WEBSITE_DIR.parent
TEMPLATES_DIR = WEBSITE_DIR / "templates"
LOCALES_DIR = WEBSITE_DIR / "locales"
CONTENT_DIR = WEBSITE_DIR / "content"
STATIC_DIR = WEBSITE_DIR / "static"
CACHE_DIR = WEBSITE_DIR / ".cache"
DEFAULT_OUT_DIR = WEBSITE_DIR / "dist"

SITE_URL = "https://app.aqbot.top"
SITE_NAME = "AQBot"
GITHUB_OWNER = "AQBot-Desktop"
GITHUB_NAME = "AQBot"
GITHUB_REPO = f"https://github.com/{GITHUB_OWNER}/{GITHUB_NAME}"
GITHUB_RELEASES = f"{GITHUB_REPO}/releases"
GITHUB_ISSUES = f"{GITHUB_REPO}/issues"
COMMUNITY_URL = "https://linux.do"
LICENSE_NAME = "AGPL-3.0"
LICENSE_URL = f"{GITHUB_REPO}/blob/main/LICENSE"
BRAND_COLOR = "#17A93D"


@dataclass(frozen=True)
class Locale:
    code: str
    prefix: str
    html_lang: str
    hreflang: str
    og_locale: str
    label: str
    readme: str
    script: str  # font role, see FONT_SCRIPTS
    dir: str = "ltr"

    def href(self, path: str) -> str:
        """Site-relative URL for a canonical page path like '/', '/features'."""
        if not path.startswith("/"):
            path = "/" + path
        if not self.prefix:
            return path
        return f"/{self.prefix}/" if path == "/" else f"/{self.prefix}{path}"

    def url(self, path: str) -> str:
        return SITE_URL + self.href(path)


# Menu order follows the README language bar.
LOCALES: list[Locale] = [
    Locale("zh", "zh", "zh-CN", "zh-CN", "zh_CN", "简体中文", "README.md", "sc"),
    Locale("zh-tw", "zh-tw", "zh-TW", "zh-TW", "zh_TW", "繁體中文", "README-ZH-TW.md", "tc"),
    Locale("en", "", "en", "en", "en_US", "English", "README-EN.md", "latin"),
    Locale("ja", "ja", "ja", "ja", "ja_JP", "日本語", "README-JA.md", "jp"),
    Locale("ko", "ko", "ko", "ko", "ko_KR", "한국어", "README-KO.md", "kr"),
    Locale("fr", "fr", "fr", "fr", "fr_FR", "Français", "README-FR.md", "latin"),
    Locale("de", "de", "de", "de", "de_DE", "Deutsch", "README-DE.md", "latin"),
    Locale("es", "es", "es", "es", "es_ES", "Español", "README-ES.md", "latin"),
    Locale("ru", "ru", "ru", "ru", "ru_RU", "Русский", "README-RU.md", "latin"),
    Locale("hi", "hi", "hi", "hi", "hi_IN", "हिन्दी", "README-HI.md", "deva"),
    Locale("ar", "ar", "ar", "ar", "ar_SA", "العربية", "README-AR.md", "arab", "rtl"),
]
LOCALE_BY_CODE = {loc.code: loc for loc in LOCALES}
DEFAULT_LOCALE = LOCALE_BY_CODE["en"]

# Source locales define the key set; every other locale must match them.
SOURCE_LOCALES = ("en", "zh")


@dataclass(frozen=True)
class FontSource:
    family: str  # CSS family name used on the site (unique, never a local name)
    file: str  # cache file name
    url: str
    weight_range: tuple[int, int]


_GF = "https://github.com/google/fonts/raw/main/ofl"

FONT_SOURCES: dict[str, FontSource] = {
    "latin": FontSource("AQ Serif", "SourceSerif4.ttf", f"{_GF}/sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf", (400, 700)),
    "sc": FontSource("AQ Serif SC", "NotoSerifSC.ttf", f"{_GF}/notoserifsc/NotoSerifSC%5Bwght%5D.ttf", (400, 700)),
    "tc": FontSource("AQ Serif TC", "NotoSerifTC.ttf", f"{_GF}/notoseriftc/NotoSerifTC%5Bwght%5D.ttf", (400, 700)),
    "jp": FontSource("AQ Serif JP", "NotoSerifJP.ttf", f"{_GF}/notoserifjp/NotoSerifJP%5Bwght%5D.ttf", (400, 700)),
    "kr": FontSource("AQ Serif KR", "NotoSerifKR.ttf", f"{_GF}/notoserifkr/NotoSerifKR%5Bwght%5D.ttf", (400, 700)),
    "deva": FontSource("AQ Serif Deva", "NotoSerifDevanagari.ttf", f"{_GF}/notoserifdevanagari/NotoSerifDevanagari%5Bwdth,wght%5D.ttf", (400, 700)),
    "arab": FontSource("AQ Naskh", "NotoNaskhArabic.ttf", f"{_GF}/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf", (400, 700)),
    "mono": FontSource("AQ Mono", "JetBrainsMono.ttf", f"{_GF}/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf", (400, 600)),
}

# System serif fallbacks per script, used before the subset font loads or
# when it cannot be produced (offline build without a font cache).
SYSTEM_SERIF: dict[str, list[str]] = {
    "latin": ['"Iowan Old Style"', '"Palatino Linotype"', "Charter", "Georgia", '"Times New Roman"'],
    "sc": ['"Songti SC"', "STSong", '"Noto Serif CJK SC"', '"Source Han Serif SC"', "SimSun", '"宋体"'],
    "tc": ['"Songti TC"', '"Noto Serif CJK TC"', '"Source Han Serif TC"', "PMingLiU", '"新細明體"'],
    "jp": ['"Hiragino Mincho ProN"', '"Yu Mincho"', "YuMincho", '"Noto Serif CJK JP"', '"MS PMincho"'],
    "kr": ['"AppleMyungjo"', '"Noto Serif CJK KR"', '"Source Han Serif K"', "Batang", '"바탕"'],
    "deva": ['"Devanagari MT"', '"Noto Serif Devanagari"', "Mangal"],
    "arab": ['"Noto Naskh Arabic"', '"Geeza Pro"', '"Traditional Arabic"', '"Times New Roman"'],
}
SYSTEM_MONO = ["ui-monospace", '"SF Mono"', "Menlo", "Consolas", '"Liberation Mono"', "monospace"]

# Canonical (locale-independent) page paths and their templates.
PAGES = {
    "home": "/",
    "features": "/features",
    "download": "/download",
    "faq": "/faq",
}
GUIDES = ["getting-started", "providers", "mcp", "gateway"]

SCREENSHOTS = [f"s{i}-0412.png" for i in range(1, 11)]
