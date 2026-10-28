"""Render the Markdown guides (formerly VitePress pages) to HTML fragments."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from datetime import datetime

import markdown as md
from markdown.extensions.toc import slugify_unicode
from pygments import highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import TextLexer, get_lexer_by_name
from pygments.util import ClassNotFound

from .config import CONTENT_DIR, GUIDES, Locale

_FENCE = re.compile(
    r"^(?P<indent>[ \t]*)```(?P<lang>[\w+-]*)[^\n]*\n(?P<code>.*?)\n(?P=indent)```[ \t]*$",
    re.M | re.S,
)
_CONTAINER = re.compile(
    r"^:::[ \t]*(?P<kind>tip|info|warning|danger)(?:[ \t]+(?P<title>[^\n]*))?\n(?P<body>.*?)\n:::[ \t]*$",
    re.M | re.S,
)
_NESTED_ITEM = re.compile(r"^(?P<indent> {1,7})(?P<marker>[-*+]|\d+\.)[ \t]", re.M)
_FORMATTER = HtmlFormatter(nowrap=True)
_TOKEN = "AQCODEBLOCK{}END"


@dataclass
class TocEntry:
    id: str
    text: str
    level: int


@dataclass
class Guide:
    slug: str
    title: str
    html: str
    markdown: str
    description: str
    toc: list[TocEntry] = field(default_factory=list)
    prev: "Guide | None" = None
    next: "Guide | None" = None
    updated: datetime | None = None
    edit_url: str = ""


def _highlight(code: str, lang: str) -> str:
    try:
        lexer = get_lexer_by_name(lang) if lang else TextLexer()
    except ClassNotFound:
        lexer = TextLexer()
    body = highlight(code, lexer, _FORMATTER).rstrip("\n")
    label = html.escape(lang or "text")
    return (
        f'<div class="code" data-lang="{label}">'
        f'<div class="code-bar"><span class="code-lang">{label}</span></div>'
        f"<pre><code>{body}</code></pre></div>"
    )


def _stash_code(source: str, store: list[str]) -> str:
    def repl(m: re.Match) -> str:
        indent = m.group("indent")
        code = "\n".join(line[len(indent):] if line.startswith(indent) else line for line in m.group("code").split("\n"))
        store.append(_highlight(code, m.group("lang")))
        return f"{indent}{_TOKEN.format(len(store) - 1)}"

    return _FENCE.sub(repl, source)


def _restore_code(rendered: str, store: list[str]) -> str:
    for i, block in enumerate(store):
        token = _TOKEN.format(i)
        rendered = rendered.replace(f"<p>{token}</p>", block).replace(token, block)
    return rendered


def _normalize_lists(source: str) -> str:
    """Python-Markdown needs 4-space nesting; the guides use markdown-it's 2/3."""

    def repl(m: re.Match) -> str:
        width = len(m.group("indent"))
        return " " * (4 if width < 4 else 8) + m.group("marker") + " "

    return _NESTED_ITEM.sub(repl, source)


def _containers(source: str, labels: dict[str, str]) -> str:
    def repl(m: re.Match) -> str:
        kind = m.group("kind")
        title = (m.group("title") or "").strip() or labels[kind]
        return (
            f'<aside class="callout" data-kind="{kind}" markdown="1">\n'
            f'<p class="callout-title">{html.escape(title)}</p>\n\n{m.group("body")}\n\n</aside>'
        )

    return _CONTAINER.sub(repl, source)


def _first_paragraph(source: str) -> str:
    for block in re.split(r"\n\s*\n", source):
        block = block.strip()
        if block and not block.startswith(("#", "|", "-", "*", ":::", "```", ">", "1.")) and "AQCODEBLOCK" not in block:
            text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", block)
            text = re.sub(r"[*`]", "", text)
            return " ".join(text.split())
    return ""


def _flatten_toc(tokens: list[dict]) -> list[TocEntry]:
    out: list[TocEntry] = []
    for tok in tokens:
        if tok["level"] in (2, 3):
            out.append(TocEntry(tok["id"], html.unescape(tok["name"]), tok["level"]))
        out.extend(_flatten_toc(tok.get("children", [])))
    return out


def render_guide(locale: Locale, slug: str, callout_labels: dict[str, str]) -> Guide:
    source = (CONTENT_DIR / "guides" / locale.code / f"{slug}.md").read_text(encoding="utf-8")
    title_match = re.match(r"^#\s+(.+)$", source, re.M)
    if not title_match:
        raise ValueError(f"guide {locale.code}/{slug} has no H1")
    title = title_match.group(1).strip()
    body_src = source[title_match.end():]

    store: list[str] = []
    prepared = _containers(_normalize_lists(_stash_code(body_src, store)), callout_labels)
    converter = md.Markdown(
        extensions=["tables", "md_in_html", "sane_lists", "toc", "attr_list"],
        extension_configs={"toc": {"slugify": slugify_unicode, "toc_depth": "2-3", "permalink": False}},
    )
    rendered = _restore_code(converter.convert(prepared), store)
    rendered = rendered.replace("<table>", '<div class="table-wrap"><table>').replace("</table>", "</table></div>")
    # Horizontal rules are VitePress section spacers; headings already separate sections.
    rendered = rendered.replace("<hr />", "")
    return Guide(
        slug=slug,
        title=title,
        html=rendered,
        markdown=source,
        description=_first_paragraph(body_src),
        toc=_flatten_toc(converter.toc_tokens),
    )


def render_guides(locale: Locale, callout_labels: dict[str, str]) -> list[Guide]:
    return [render_guide(locale, slug, callout_labels) for slug in GUIDES]
