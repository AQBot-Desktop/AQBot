"""Markdown mirrors of each page and llms.txt files for AI assistants."""

from __future__ import annotations

import re

from . import seo
from .config import GITHUB_RELEASES, GITHUB_REPO, LOCALES, SITE_URL, Locale
from .docs import Guide
from .locales import Messages
from .readme import ReadmeContent
from .release import Release

_CONTAINER = re.compile(r"^:::[ \t]*(tip|info|warning|danger)(?:[ \t]+([^\n]*))?\n(.*?)\n:::[ \t]*$", re.M | re.S)


def guide_markdown(guide: Guide, labels: dict[str, str]) -> str:
    """VitePress containers become blockquotes so the file is plain CommonMark."""

    def repl(m: re.Match) -> str:
        title = (m.group(2) or "").strip() or labels[m.group(1)]
        body = "\n".join(f"> {line}" if line else ">" for line in m.group(3).split("\n"))
        return f"> **{title}**\n>\n{body}"

    return _CONTAINER.sub(repl, guide.markdown).strip() + "\n"


def features_markdown(m: Messages, readme: ReadmeContent, url: str) -> str:
    out = [f"# {m.t('features.title')}", "", m.t("features.lede"), "", f"Source: {url}", ""]
    for group in readme.features:
        out += [f"## {group.title}", ""]
        out += [f"- **{item.title}**: {item.text}" for item in group.items]
        out.append("")
    return "\n".join(out)


def faq_markdown(m: Messages, items: list[dict], url: str) -> str:
    out = [f"# {m.t('faq.title')}", "", m.t("faq.lede"), "", f"Source: {url}", ""]
    for item in items:
        out += [f"## {item['q']}", "", item["a"], ""]
    return "\n".join(out)


def download_markdown(m: Messages, release: Release, url: str) -> str:
    out = [f"# {m.t('download.title')}", "", m.t("download.lede"), "", f"Source: {url}", ""]
    out += [f"{m.t('download.latest')}: v{release.version} ({release.url})", ""]
    for os_id in ("macos", "windows", "linux"):
        out += [f"## {m.t('os.' + os_id)}", ""]
        for a in release.by_os(os_id):
            size = f", {a.size_label}" if a.size_label else ""
            out.append(f"- {m.t('download.kind_' + a.kind)} ({a.arch}{size}): [{a.name}]({a.url})")
        out.append("")
    out += [f"{m.t('download.all_releases')}: {GITHUB_RELEASES}", ""]
    return "\n".join(out)


def home_markdown(m: Messages, readme: ReadmeContent, faq_items: list[dict], release: Release, url: str) -> str:
    out = [f"# AQBot — {m.t('meta.site_tagline')}", "", f"> {readme.intro}", "", m.t("hero.lede"), "", f"Source: {url}", ""]
    out += [f"## {m.t('home.capabilities_title')}", ""]
    for key in ("chat", "agent", "tools", "knowledge", "gateway", "data"):
        out.append(f"- **{m.t(f'home.cap_{key}_title')}**: {m.t(f'home.cap_{key}_body')}")
    out += ["", f"## {m.t('home.faq_title')}", ""]
    for item in faq_items:
        out += [f"### {item['q']}", "", item["a"], ""]
    out += [f"## {m.t('nav.download')}", "", f"v{release.version}: {release.url}", ""]
    return "\n".join(out)


def llms_txt(loc: Locale, m: Messages, faq_items: list[dict], guides: list[Guide]) -> str:
    def md_url(path: str) -> str:
        return SITE_URL + (loc.href("/index.md") if path == "/" else loc.href(f"{path}.md"))

    facts = [f"{item['q']} {item['a']}" for item in faq_items]
    sections = [
        (
            m.t("footer.product"),
            [
                (m.t("nav.home"), md_url("/"), m.t("meta.home_description")),
                (m.t("nav.features"), md_url("/features"), m.t("meta.features_description")),
                (m.t("nav.download"), md_url("/download"), m.t("meta.download_description")),
                (m.t("nav.faq"), md_url("/faq"), m.t("meta.faq_description")),
            ],
        ),
        (m.t("docs.label"), [(g.title, md_url(f"/guide/{g.slug}"), g.description) for g in guides]),
        (m.t("footer.languages"), [(l.label, l.url("/llms.txt") if l.prefix else f"{SITE_URL}/llms.txt", "") for l in LOCALES]),
        (
            "Optional",
            [
                ("GitHub", GITHUB_REPO, ""),
                (m.t("footer.releases"), GITHUB_RELEASES, ""),
                ("llms-full.txt", f"{SITE_URL}{loc.href('/llms-full.txt')}", ""),
            ],
        ),
    ]
    return seo.llms_txt(facts, m.t("meta.home_description"), sections)


def llms_full_txt(home_md: str, features_md: str, faq_md: str, download_md: str, guides_md: list[str]) -> str:
    parts = [home_md, features_md, download_md, faq_md, *guides_md]
    return "\n\n---\n\n".join(p.strip() for p in parts) + "\n"
