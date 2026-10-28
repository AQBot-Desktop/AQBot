"""Structured data, sitemap, robots.txt and llms.txt generation."""

from __future__ import annotations

import json
from datetime import datetime
from xml.sax.saxutils import escape

from .config import (
    GITHUB_REPO,
    LICENSE_URL,
    LOCALES,
    SITE_NAME,
    SITE_URL,
    Locale,
)
from .release import Release

ORG_ID = f"{SITE_URL}/#organization"
WEBSITE_ID = f"{SITE_URL}/#website"
SOFTWARE_ID = f"{SITE_URL}/#software"
SOURCE_ID = f"{SITE_URL}/#source"

AI_CRAWLERS = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-SearchBot",
    "Claude-User",
    "PerplexityBot",
    "Perplexity-User",
    "Google-Extended",
    "Applebot-Extended",
    "Bingbot",
    "Baiduspider",
    "YandexBot",
]


def organization() -> dict:
    return {
        "@type": "Organization",
        "@id": ORG_ID,
        "name": SITE_NAME,
        "url": f"{SITE_URL}/",
        "logo": {"@type": "ImageObject", "url": f"{SITE_URL}/logo.png", "width": 512, "height": 512},
        "sameAs": [GITHUB_REPO],
    }


def website(loc: Locale, description: str) -> dict:
    return {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        "name": SITE_NAME,
        "url": f"{SITE_URL}/",
        "description": description,
        "publisher": {"@id": ORG_ID},
        "inLanguage": [l.hreflang for l in LOCALES],
    }


def software(loc: Locale, release: Release, description: str, features: list[str], screenshots: list[str], download_url: str) -> dict:
    data = {
        "@type": "SoftwareApplication",
        "@id": SOFTWARE_ID,
        "name": SITE_NAME,
        "description": description,
        "url": f"{SITE_URL}/",
        "applicationCategory": "DeveloperApplication",
        "applicationSubCategory": "AI desktop client",
        "operatingSystem": "macOS, Windows, Linux",
        "softwareVersion": release.version,
        "downloadUrl": download_url,
        "releaseNotes": release.url,
        "license": LICENSE_URL,
        "isAccessibleForFree": True,
        "inLanguage": [l.hreflang for l in LOCALES],
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "publisher": {"@id": ORG_ID},
        "image": f"{SITE_URL}/logo.png",
        "screenshot": screenshots,
        "featureList": features,
    }
    if release.published:
        data["dateModified"] = release.published.date().isoformat()
    return data


def source_code() -> dict:
    return {
        "@type": "SoftwareSourceCode",
        "@id": SOURCE_ID,
        "name": f"{SITE_NAME} source code",
        "codeRepository": GITHUB_REPO,
        "programmingLanguage": ["Rust", "TypeScript"],
        "runtimePlatform": "Tauri",
        "license": LICENSE_URL,
        "targetProduct": {"@id": SOFTWARE_ID},
        "author": {"@id": ORG_ID},
    }


def webpage(url: str, name: str, description: str, loc: Locale, page_type: str = "WebPage", about_software: bool = True) -> dict:
    data = {
        "@type": page_type,
        "@id": f"{url}#webpage",
        "url": url,
        "name": name,
        "description": description,
        "inLanguage": loc.hreflang,
        "isPartOf": {"@id": WEBSITE_ID},
    }
    if about_software:
        data["about"] = {"@id": SOFTWARE_ID}
    return data


def breadcrumbs(url: str, crumbs: list[tuple[str, str]]) -> dict:
    return {
        "@type": "BreadcrumbList",
        "@id": f"{url}#breadcrumb",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": name, "item": item}
            for i, (name, item) in enumerate(crumbs)
        ],
    }


def faq_page(url: str, items: list[dict], loc: Locale) -> dict:
    return {
        "@type": "FAQPage",
        "@id": f"{url}#faq",
        "inLanguage": loc.hreflang,
        "mainEntity": [
            {"@type": "Question", "name": item["q"], "acceptedAnswer": {"@type": "Answer", "text": item["a"]}}
            for item in items
        ],
    }


def tech_article(url: str, title: str, description: str, loc: Locale, modified: datetime | None) -> dict:
    data = {
        "@type": "TechArticle",
        "@id": f"{url}#article",
        "headline": title,
        "description": description,
        "inLanguage": loc.hreflang,
        "mainEntityOfPage": {"@id": f"{url}#webpage"},
        "author": {"@id": ORG_ID},
        "publisher": {"@id": ORG_ID},
        "about": {"@id": SOFTWARE_ID},
        "image": f"{SITE_URL}/og/{loc.code}.png",
    }
    if modified:
        data["dateModified"] = modified.isoformat()
    return data


def graph(*nodes: dict) -> str:
    payload = {"@context": "https://schema.org", "@graph": [n for n in nodes if n]}
    # `</` must not appear inside a <script> element.
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def sitemap(entries: list[dict]) -> str:
    """entries: {path, lastmod(date|None), alternates: [(hreflang, url)], x_default}"""
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ]
    for e in entries:
        out.append("  <url>")
        out.append(f"    <loc>{escape(e['url'])}</loc>")
        if e.get("lastmod"):
            out.append(f"    <lastmod>{e['lastmod']}</lastmod>")
        for hreflang, href in e["alternates"]:
            out.append(f'    <xhtml:link rel="alternate" hreflang="{hreflang}" href="{escape(href)}"/>')
        out.append(f'    <xhtml:link rel="alternate" hreflang="x-default" href="{escape(e["x_default"])}"/>')
        out.append("  </url>")
    out.append("</urlset>")
    return "\n".join(out) + "\n"


def robots() -> str:
    lines = ["# AQBot website — all crawlers, including AI search and assistants, are welcome.", ""]
    for bot in AI_CRAWLERS:
        lines += [f"User-agent: {bot}", "Allow: /", ""]
    lines += ["User-agent: *", "Allow: /", "", f"Sitemap: {SITE_URL}/sitemap.xml", ""]
    return "\n".join(lines)


def llms_txt(facts: list[str], summary: str, sections: list[tuple[str, list[tuple[str, str, str]]]]) -> str:
    """llmstxt.org format: H1, blockquote summary, details, then link sections."""
    lines = [f"# {SITE_NAME}", "", f"> {summary}", ""]
    lines += [f"- {fact}" for fact in facts]
    for title, links in sections:
        lines += ["", f"## {title}", ""]
        lines += [f"- [{name}]({url}): {desc}" if desc else f"- [{name}]({url})" for name, url, desc in links]
    return "\n".join(lines) + "\n"


def manifest(description: str) -> str:
    return json.dumps(
        {
            "name": SITE_NAME,
            "short_name": SITE_NAME,
            "description": description,
            "start_url": "/",
            "display": "standalone",
            "background_color": "#f7f6f1",
            "theme_color": "#17a93d",
            "icons": [
                {"src": "/logo.png", "sizes": "512x512", "type": "image/png"},
                {"src": "/logo.svg", "sizes": "any", "type": "image/svg+xml"},
            ],
        },
        ensure_ascii=False,
        indent=2,
    )

