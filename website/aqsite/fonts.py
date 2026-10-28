"""Self-hosted serif fonts, subset to the exact characters each locale renders.

CJK serif families are tens of megabytes; subsetting them per locale keeps
the payload to a few hundred kilobytes and removes the dependency on
third-party font CDNs (which are unreachable in some regions). When a font
source cannot be downloaded the build continues and the CSS stacks fall back
to the platform's own serif faces.
"""

from __future__ import annotations

import hashlib
import io
import shutil
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .config import CACHE_DIR, FONT_SOURCES, SYSTEM_MONO, SYSTEM_SERIF, FontSource

FONT_CACHE = CACHE_DIR / "fonts"
SUBSET_CACHE = CACHE_DIR / "subsets"

# Curly quotes, dashes and ellipsis are drawn by the CJK face on CJK pages so
# punctuation width stays consistent with the surrounding text.
CJK_OWNED_PUNCT = {0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026}
ALWAYS_LATIN = set(range(0x20, 0x7F)) | {0xA0, 0xA9, 0xB7, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2192, 0x2190, 0x2605}
MONO_CHARS = set(range(0x20, 0x7F)) | set(range(0x2500, 0x2580)) | {0x2192, 0x2190, 0x2713, 0x2717}


@dataclass
class FontFile:
    family: str
    href: str
    unicode_range: str | None = None


def ensure_source(src: FontSource) -> Path | None:
    path = FONT_CACHE / src.file
    if path.exists() and path.stat().st_size > 0:
        return path
    FONT_CACHE.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    try:
        print(f"[fonts] downloading {src.file}")
        req = urllib.request.Request(src.url, headers={"User-Agent": "aqbot-website-build"})
        with urllib.request.urlopen(req, timeout=180) as resp, tmp.open("wb") as fh:
            shutil.copyfileobj(resp, fh)
        tmp.replace(path)
        return path
    except Exception as exc:
        print(f"[fonts] unable to fetch {src.file}: {exc}; falling back to system fonts")
        tmp.unlink(missing_ok=True)
        return None


def _subset_bytes(source: Path, codepoints: set[int], weight_range: tuple[int, int]) -> bytes:
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer

    font = TTFont(source)
    cmap = font.getBestCmap()
    wanted = sorted(cp for cp in codepoints if cp in cmap)
    opts = subset.Options()
    # fontTools' default feature list (kern, liga, locl, mark, ccmp, …) covers
    # running text; keeping every feature roughly doubles the file size.
    opts.notdef_outline = True
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    subsetter = subset.Subsetter(opts)
    subsetter.populate(unicodes=wanted)
    subsetter.subset(font)
    if "fvar" in font:
        limits = {}
        for axis in font["fvar"].axes:
            if axis.axisTag == "wght":
                limits["wght"] = weight_range
            elif axis.axisTag == "wdth":
                limits["wdth"] = 100
            elif axis.axisTag == "opsz":
                # One optical size keeps the file small; 20 reads well for both
                # body copy and headings.
                limits["opsz"] = 20
        font = instancer.instantiateVariableFont(font, limits)
    font.flavor = "woff2"
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def build_subset(key: str, codepoints: set[int], out_dir: Path) -> FontFile | None:
    """Subset FONT_SOURCES[key] to `codepoints`; returns None if unavailable."""
    src = FONT_SOURCES[key]
    path = ensure_source(src)
    if path is None:
        return None
    digest = hashlib.sha1(
        f"v2:{src.file}:{path.stat().st_size}:{src.weight_range}:".encode() + bytes(str(sorted(codepoints)), "ascii")
    ).hexdigest()[:10]
    name = f"{src.family.lower().replace(' ', '-')}-{digest}.woff2"
    cached = SUBSET_CACHE / name
    if not cached.exists():
        SUBSET_CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(_subset_bytes(path, codepoints, src.weight_range))
        print(f"[fonts] {name}: {cached.stat().st_size // 1024} KB, {len(codepoints)} code points")
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(cached, out_dir / name)
    return FontFile(src.family, f"/assets/fonts/{name}")


def unicode_range(codepoints: set[int]) -> str:
    ranges: list[str] = []
    cps = sorted(codepoints)
    start = prev = cps[0]
    for cp in cps[1:] + [None]:
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        ranges.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
        if cp is not None:
            start = prev = cp
    return ", ".join(ranges)


def is_latin_like(cp: int) -> bool:
    return cp < 0x0590 or 0x1E00 <= cp <= 0x1EFF or 0x2000 <= cp <= 0x22FF or cp in (0x2605, 0x2713)


def font_face_css(files: list[FontFile]) -> str:
    rules = []
    for f in files:
        weights = "400 700"
        rng = f";unicode-range:{f.unicode_range}" if f.unicode_range else ""
        rules.append(
            f"@font-face{{font-family:\"{f.family}\";src:url({f.href}) format(\"woff2\");"
            f"font-weight:{weights};font-style:normal;font-display:swap{rng}}}"
        )
    return "".join(rules)


def font_stack_css(script: str, available: set[str]) -> str:
    """CSS custom properties with the serif + mono stacks for a locale."""
    latin = FONT_SOURCES["latin"].family
    serif: list[str] = []
    if latin in available:
        serif.append(f'"{latin}"')
    if script != "latin":
        family = FONT_SOURCES[script].family
        if family in available:
            serif.append(f'"{family}"')
        serif += SYSTEM_SERIF[script]
    serif += SYSTEM_SERIF["latin"] + ["serif"]
    mono = ([f'"{FONT_SOURCES["mono"].family}"'] if FONT_SOURCES["mono"].family in available else []) + SYSTEM_MONO
    return f":root{{--font-serif:{','.join(serif)};--font-mono:{','.join(mono)}}}"
