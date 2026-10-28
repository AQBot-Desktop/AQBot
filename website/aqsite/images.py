"""Responsive screenshot variants, Open Graph cards and touch icons."""

from __future__ import annotations

import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .config import CACHE_DIR, FONT_SOURCES, STATIC_DIR, Locale
from .fonts import ensure_source

SCREENSHOT_WIDTHS = (960, 1600)
IMAGE_CACHE = CACHE_DIR / "images"
# Pillow without libraqm cannot shape these scripts; their cards use English.
UNSHAPED_SCRIPTS = {"arab", "deva"}


@dataclass
class Screenshot:
    file: str
    caption: str
    src: str
    webp_srcset: str
    width: int
    height: int
    index: int = 0

    def as_dict(self) -> dict:
        return {"src": self.webp_large, "caption": self.caption}

    @property
    def webp_large(self) -> str:
        return self.webp_srcset.split(", ")[-1].split(" ")[0]


def _cached(key: str, suffix: str, producer) -> Path:
    IMAGE_CACHE.mkdir(parents=True, exist_ok=True)
    path = IMAGE_CACHE / f"{key}{suffix}"
    if not path.exists():
        producer(path)
    return path


def _digest(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:10]


def build_screenshots(files: list[str], out_dir: Path) -> dict[str, dict]:
    """Writes PNG originals and WebP variants; returns metadata per file."""
    src_dir = STATIC_DIR / "img" / "screenshots"
    target = out_dir / "screenshots"
    target.mkdir(parents=True, exist_ok=True)
    meta: dict[str, dict] = {}
    for name in files:
        src = src_dir / name
        digest = _digest(src)
        stem = src.stem
        with Image.open(src) as im:
            width, height = im.size
        srcset = []
        for w in SCREENSHOT_WIDTHS:
            def produce(path: Path, w=w) -> None:
                with Image.open(src) as im:
                    im = im.convert("RGB")
                    h = round(im.height * w / im.width)
                    im.resize((w, h), Image.LANCZOS).save(path, "WEBP", quality=82, method=6)
            cached = _cached(f"{stem}-{digest}-{w}", ".webp", produce)
            out_name = f"{stem}-{w}.{digest}.webp"
            shutil.copyfile(cached, target / out_name)
            srcset.append(f"/screenshots/{out_name} {w}w")
        png_name = f"{stem}.{digest}.png"
        shutil.copyfile(src, target / png_name)
        meta[name] = {
            "src": f"/screenshots/{png_name}",
            "webp_srcset": ", ".join(srcset),
            "width": width,
            "height": height,
        }
    return meta


def _font(script: str, size: int, weight: int) -> ImageFont.FreeTypeFont | None:
    path = ensure_source(FONT_SOURCES[script])
    if path is None:
        return None
    font = ImageFont.truetype(str(path), size)
    try:
        axes = font.get_variation_axes()
        values = []
        for axis in axes:
            name = axis.get("name", b"")
            name = name.decode() if isinstance(name, bytes) else str(name)
            if name.lower().startswith("weight"):
                values.append(weight)
            elif name.lower().startswith("optical"):
                values.append(min(max(size, axis["minimum"]), axis["maximum"]))
            else:
                values.append(axis["default"])
        font.set_variation_by_axes(values)
    except Exception:
        pass
    return font


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int, cjk: bool) -> list[str]:
    tokens = list(text) if cjk else text.split(" ")
    joiner = "" if cjk else " "
    lines: list[str] = []
    current = ""
    for tok in tokens:
        trial = f"{current}{joiner}{tok}" if current else tok
        if draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = tok
    if current:
        lines.append(current)
    return lines


def build_og_image(loc: Locale, tagline: str, platforms: str, out_path: Path) -> None:
    W, H = 1200, 630
    paper, ink, muted, brand, line = (247, 246, 241), (26, 29, 26), (92, 99, 93), (23, 169, 61), (226, 223, 213)
    img = Image.new("RGB", (W, H), paper)
    draw = ImageDraw.Draw(img)

    script = "latin" if loc.script in UNSHAPED_SCRIPTS else loc.script
    title_font = _font("latin", 92, 700)
    tag_font = _font(script, 46 if script != "latin" else 48, 600)
    small_font = _font("latin", 26, 400)
    if not (title_font and tag_font and small_font):
        title_font = tag_font = small_font = ImageFont.load_default()

    # Screenshot panel bleeding off the right edge.
    shot_path = STATIC_DIR / "img" / "screenshots" / "s1-0412.png"
    with Image.open(shot_path) as shot:
        shot = shot.convert("RGB")
        sw = 700
        sh = round(shot.height * sw / shot.width)
        shot = shot.resize((sw, sh), Image.LANCZOS)
    sx, sy = 640, 96
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((sx + 6, sy + 14, sx + sw + 6, sy + sh + 14), 18, fill=70)
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    img.paste((180, 176, 166), (0, 0), shadow)
    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), 16, fill=255)
    img.paste(shot, (sx, sy), mask)
    draw.rounded_rectangle((sx, sy, sx + sw - 1, sy + sh - 1), 16, outline=line, width=2)

    # Logo, wordmark, tagline.
    with Image.open(STATIC_DIR / "img" / "logo.png") as logo:
        logo = logo.convert("RGBA").resize((88, 88), Image.LANCZOS)
    img.paste(logo, (72, 84), logo)
    draw.text((180, 74), "AQBot", font=title_font, fill=ink)
    cjk = loc.script in {"sc", "tc", "jp", "kr"}
    text = tagline if loc.script not in UNSHAPED_SCRIPTS else None
    y = 236
    for row in _wrap(draw, text or "Open-source AI desktop client", tag_font, 520, cjk)[:3]:
        draw.text((72, y), row, font=tag_font, fill=ink)
        y += 66 if cjk else 60
    draw.rectangle((72, 492, 136, 496), fill=brand)
    draw.text((72, 516), platforms, font=small_font, fill=muted)
    draw.text((72, 552), "app.aqbot.top", font=small_font, fill=brand)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG", optimize=True)


def build_touch_icon(out_dir: Path) -> None:
    with Image.open(STATIC_DIR / "img" / "logo.png") as logo:
        icon = Image.new("RGBA", (180, 180), (247, 246, 241, 255))
        small = logo.convert("RGBA").resize((150, 150), Image.LANCZOS)
        icon.paste(small, (15, 15), small)
        icon.convert("RGB").save(out_dir / "apple-touch-icon.png", "PNG", optimize=True)
