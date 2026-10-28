"""Per-page context assembly: titles, descriptions, alternates and JSON-LD."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from . import seo
from .config import DEFAULT_LOCALE, LOCALES, SITE_URL, Locale

ROBOTS_INDEX = "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1"


def page_file(path: str) -> str:
    """Output file for a canonical path ('/' -> index.html, '/faq' -> faq.html)."""
    return "index.html" if path == "/" else path.strip("/") + ".html"


def markdown_href(loc: Locale, path: str) -> str:
    target = "/index.md" if path == "/" else f"{path}.md"
    return loc.href(target)


def with_brand(title: str) -> str:
    return title if "AQBot" in title else f"{title} | AQBot"


def clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.6:
        cut = cut[:space]
    return cut.rstrip(",.;:，。；：、 ") + "…"


def description_limit(loc: Locale) -> int:
    return 90 if loc.script in {"sc", "tc", "jp", "kr"} else 160


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


@dataclass
class PageMeta:
    key: str
    section: str
    path: str
    title: str
    description: str
    og_type: str = "website"
    robots: str = ROBOTS_INDEX
    breadcrumbs: list[dict] = field(default_factory=list)
    jsonld_nodes: list[dict] = field(default_factory=list)
    markdown: bool = True


def alternates(path: str) -> list[dict]:
    return [
        {
            "code": l.code,
            "label": l.label,
            "hreflang": l.hreflang,
            "html_lang": l.html_lang,
            "href": l.href(path),
            "url": l.url(path),
        }
        for l in LOCALES
    ]


def page_context(loc: Locale, meta: PageMeta) -> dict[str, Any]:
    canonical = loc.url(meta.path)
    nodes = [seo.organization(), seo.website(loc, meta.description)]
    if meta.breadcrumbs:
        nodes.append(seo.breadcrumbs(canonical, [(c["name"], SITE_URL + c["href"]) for c in meta.breadcrumbs]))
    nodes += meta.jsonld_nodes
    alts = alternates(meta.path)
    return {
        "key": meta.key,
        "section": meta.section,
        "path": meta.path,
        "title": meta.title,
        "og_title": meta.title,
        "og_type": meta.og_type,
        "description": meta.description,
        "canonical": canonical,
        "alternates": alts,
        "alternates_by_locale": alts,
        "x_default": DEFAULT_LOCALE.url(meta.path),
        "robots": meta.robots,
        "og_image": f"{SITE_URL}/og/{loc.code}.png",
        "markdown_url": SITE_URL + markdown_href(loc, meta.path) if meta.markdown else None,
        "breadcrumbs": meta.breadcrumbs,
        "jsonld": seo.graph(*nodes),
    }
