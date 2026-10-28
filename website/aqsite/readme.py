"""Extract localized product copy from the repository READMEs.

The READMEs are the translated source of truth for the feature list and the
screenshot captions, so the website never drifts from them.
Parsing is positional (by `##` order) because headings are localized.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import markdown as md

from .config import REPO_ROOT, Locale

# Stable anchors for the ten feature groups, in README order.
FEATURE_GROUP_IDS = [
    "chat",
    "agent",
    "roles",
    "skills",
    "rendering",
    "knowledge",
    "tools",
    "gateway",
    "data",
    "desktop",
]

_H2_SCREENSHOTS, _H2_FEATURES = 0, 1
_BULLET = re.compile(r"^- \*\*(?P<title>.+?)\*\*\s*[—–-]\s*(?P<body>.+)$")
_IMAGE = re.compile(r"!\[[^\]]*\]\((?:\./)?\.github/images/(?P<file>[^)]+)\)")


@dataclass
class FeatureItem:
    title: str
    html: str
    text: str


@dataclass
class FeatureGroup:
    id: str
    title: str
    items: list[FeatureItem] = field(default_factory=list)


@dataclass
class ReadmeContent:
    intro: str
    features: list[FeatureGroup]
    captions: dict[str, str]


def inline_html(text: str) -> str:
    html = md.markdown(text.strip())
    return re.sub(r"^<p>(.*)</p>$", r"\1", html, flags=re.S)


def plain_text(text: str) -> str:
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return re.sub(r"[*`]", "", text).strip()


def _split_h2(lines: list[str]) -> tuple[list[str], list[tuple[str, list[str]]]]:
    head: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    for line in lines:
        if line.startswith("## "):
            sections.append((line[3:].strip(), []))
        elif sections:
            sections[-1][1].append(line)
        else:
            head.append(line)
    return head, sections


def _parse_intro(head: list[str]) -> str:
    for line in head:
        stripped = line.strip()
        if stripped and not stripped.startswith(("[", "**", "|", "!")):
            return stripped
    raise ValueError("README intro paragraph not found")


def _parse_captions(body: list[str]) -> dict[str, str]:
    captions: dict[str, str] = {}
    pending: list[str] | None = None
    for line in body:
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if all(set(c) <= set(":-") for c in cells):
            continue
        files = [m.group("file") for c in cells for m in [_IMAGE.search(c)] if m]
        if files and pending:
            captions.update(zip(files, pending))
            pending = None
        elif not files:
            pending = cells
    return captions


def _parse_features(body: list[str]) -> list[FeatureGroup]:
    groups: list[FeatureGroup] = []
    for line in body:
        if line.startswith("### "):
            if len(groups) >= len(FEATURE_GROUP_IDS):
                raise ValueError("README has more feature groups than FEATURE_GROUP_IDS")
            groups.append(FeatureGroup(FEATURE_GROUP_IDS[len(groups)], line[4:].strip()))
            continue
        match = _BULLET.match(line.strip())
        if match and groups:
            body_md = match.group("body")
            groups[-1].items.append(
                FeatureItem(plain_text(match.group("title")), inline_html(body_md), plain_text(body_md))
            )
    if len(groups) != len(FEATURE_GROUP_IDS):
        raise ValueError(f"expected {len(FEATURE_GROUP_IDS)} feature groups, found {len(groups)}")
    return groups


def load_readme(locale: Locale) -> ReadmeContent:
    path = REPO_ROOT / locale.readme
    lines = path.read_text(encoding="utf-8").splitlines()
    head, sections = _split_h2(lines)
    if len(sections) <= _H2_FEATURES:
        raise ValueError(f"{path.name}: unexpected section layout")
    return ReadmeContent(
        intro=plain_text(_parse_intro(head)),
        features=_parse_features(sections[_H2_FEATURES][1]),
        captions=_parse_captions(sections[_H2_SCREENSHOTS][1]),
    )
