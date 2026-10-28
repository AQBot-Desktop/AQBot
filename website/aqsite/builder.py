"""Build orchestration: render every locale × page and write the static site."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from markupsafe import Markup, escape

from . import export, fonts, images, seo
from .config import (
    COMMUNITY_URL,
    DEFAULT_LOCALE,
    GITHUB_ISSUES,
    GITHUB_RELEASES,
    GITHUB_REPO,
    GUIDES,
    LICENSE_URL,
    LOCALES,
    REPO_ROOT,
    SCREENSHOTS,
    SITE_URL,
    STATIC_DIR,
    TEMPLATES_DIR,
    WEBSITE_DIR,
    Locale,
)
from .docs import _highlight, render_guides
from .locales import Messages, load_messages, validate
from .pages import PageMeta, clip, description_limit, page_context, page_file, slug, with_brand
from .readme import ReadmeContent, load_readme
from .release import OS_ORDER, Release, load_release, load_stars, now_utc

CSS_FILES = ["tokens.css", "base.css", "components.css", "demo.css", "home.css", "pages.css"]
JS_FILES = ["site.js", "demo.js"]
FEATURE_SHOTS = {"chat": "s7-0412.png", "rendering": "s1-0412.png", "agent": "s9-0412.png", "knowledge": "s3-0412.png", "gateway": "s6-0412.png"}
HOME_FAQ_COUNT = 6
CJK_SCRIPTS = {"sc", "tc", "jp", "kr"}

THEME_BOOT = (
    "(function(){var d=document.documentElement;d.classList.add('js');var p='auto';"
    "try{p=localStorage.getItem('aq-theme')||'auto'}catch(e){}"
    "var dark=p==='dark'||(p==='auto'&&window.matchMedia('(prefers-color-scheme: dark)').matches);"
    "d.dataset.theme=dark?'dark':'light';d.dataset.themePref=p})();"
)

GATEWAY_SNIPPETS = [
    ("claude", "Claude Code", "bash", 'export ANTHROPIC_BASE_URL="http://localhost:8080/v1"\nexport ANTHROPIC_AUTH_TOKEN="YOUR_KEY"\n\nclaude'),
    ("openai", "OpenAI API", "json", '{\n  "base_url": "http://localhost:8080/v1",\n  "api_key": "YOUR_KEY"\n}'),
    ("curl", "curl", "bash", 'curl http://localhost:8080/v1/models \\\n  -H "Authorization: Bearer YOUR_KEY"'),
]


@dataclass
class Rendered:
    loc: Locale
    file: str
    html: str


@dataclass
class BuildState:
    out: Path
    release: Release
    stars: int | None
    messages: dict[str, Messages]
    assets: dict[str, str] = field(default_factory=dict)
    shots_meta: dict[str, dict] = field(default_factory=dict)
    rendered: list[Rendered] = field(default_factory=list)
    sitemap: list[dict] = field(default_factory=list)
    git_dates: dict[str, datetime | None] = field(default_factory=dict)


# ── helpers ────────────────────────────────────────────────────────────────


def git_date(state: BuildState, path: Path) -> datetime | None:
    key = str(path)
    if key not in state.git_dates:
        try:
            out = subprocess.run(
                ["git", "log", "-1", "--format=%cI", "--", str(path)],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=20,
            ).stdout.strip()
            state.git_dates[key] = datetime.fromisoformat(out) if out else None
        except Exception:
            state.git_dates[key] = None
    return state.git_dates[key]


def latest(*dates: datetime | None) -> datetime | None:
    known = [d for d in dates if d]
    return max(known) if known else None


def write(path: Path, content: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")


def stars_label(stars: int | None) -> str:
    if not stars:
        return ""
    return f"{stars / 1000:.1f}k".replace(".0k", "k") if stars >= 1000 else str(stars)


_PHRASE_BREAK = re.compile(r"(?<=[，、。；：！？])")


def phrases(text: str) -> Markup:
    """Keep CJK clauses together in large headings so lines break at punctuation."""
    parts = [p for p in _PHRASE_BREAK.split(text) if p]
    if len(parts) < 2:
        return escape(text)
    return Markup("").join(Markup('<span class="phrase">{}</span>').format(p) for p in parts)


def minify_css(css: str) -> str:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    css = re.sub(r"\n\s*", "\n", css)
    return re.sub(r"\n+", "\n", css).strip() + "\n"


def bundle(kind: str, files: list[str], out: Path) -> str:
    src_dir = STATIC_DIR / kind
    text = "\n".join((src_dir / f).read_text(encoding="utf-8") for f in files)
    if kind == "css":
        text = minify_css(text)
    digest = hashlib.sha1(text.encode()).hexdigest()[:10]
    name = f"site.{digest}.{kind}"
    write(out / "assets" / name, text)
    return f"/assets/{name}"


# ── page data ──────────────────────────────────────────────────────────────


def faq_items(m: Messages, en: Messages) -> list[dict]:
    items = m.get("faq.items")
    en_items = en.get("faq.items")
    return [{"id": slug(en_items[i]["q"]), "q": it["q"], "a": it["a"]} for i, it in enumerate(items)]


def screenshots(state: BuildState, readme: ReadmeContent) -> list[images.Screenshot]:
    shots = []
    for i, name in enumerate(SCREENSHOTS):
        meta = state.shots_meta[name]
        shots.append(images.Screenshot(name, readme.captions.get(name, "AQBot"), meta["src"], meta["webp_srcset"], meta["width"], meta["height"], i))
    return shots


def asset_label(m: Messages, a) -> str:
    arch = m.t(f"download.arch_mac_{a.arch}") if a.os == "macos" else m.t(f"download.arch_{a.arch}")
    return f"{arch} · {m.t('download.kind_' + a.kind)}"


def client_data(loc: Locale, m: Messages, state: BuildState) -> str:
    data = {
        "locale": loc.code,
        "strings": {
            "copy": m.t("common.copy"),
            "copied": m.t("common.copied"),
            "ctaOs": m.t("hero.cta_download", os="{os}"),
            "detected": m.t("download.detected", os="{os}"),
            "os": {o: m.t(f"os.{o}") for o in OS_ORDER},
            "menuOpen": m.t("nav.menu"),
            "menuClose": m.t("nav.close_menu"),
        },
        "assets": {
            a.id: {"url": a.url, "name": a.name, "size": a.size_label, "os": a.os, "label": asset_label(m, a)}
            for a in state.release.assets
        },
        "banner": {
            l.code: {
                "text": state.messages[l.code].t("lang_banner.text"),
                "action": state.messages[l.code].t("lang_banner.action"),
                "dismiss": state.messages[l.code].t("lang_banner.dismiss"),
                "hreflang": l.hreflang,
                "dir": l.dir,
            }
            for l in LOCALES
        },
    }
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


# ── rendering ──────────────────────────────────────────────────────────────


class LocaleBuild:
    def __init__(self, state: BuildState, env: Environment, loc: Locale):
        self.state = state
        self.env = env
        self.loc = loc
        self.m = state.messages[loc.code]
        self.en = state.messages[DEFAULT_LOCALE.code]
        self.readme = load_readme(loc)
        self.labels = {k: self.m.t(f"common.callout_{k}") for k in ("tip", "info", "warning", "danger")}
        self.guides = render_guides(loc, self.labels)
        for i, g in enumerate(self.guides):
            g.prev = self.guides[i - 1] if i > 0 else None
            g.next = self.guides[i + 1] if i + 1 < len(self.guides) else None
            g.updated = git_date(state, WEBSITE_DIR / "content" / "guides" / loc.code / f"{g.slug}.md")
            g.edit_url = f"{GITHUB_REPO}/edit/main/website/content/guides/{loc.code}/{g.slug}.md"
        self.faq = faq_items(self.m, self.en)
        self.shots = screenshots(state, self.readme)
        self.content_date = latest(
            git_date(state, WEBSITE_DIR / "locales" / f"{loc.code}.json"),
            git_date(state, REPO_ROOT / loc.readme),
            git_date(state, TEMPLATES_DIR),
        )

    # Shared template context.
    def base_context(self) -> dict:
        m = self.m
        return {
            "t": m.t,
            "href": self.loc.href,
            "loc": self.loc,
            "locales": LOCALES,
            "site": {"repo": GITHUB_REPO, "releases": GITHUB_RELEASES, "issues": GITHUB_ISSUES, "community": COMMUNITY_URL, "license_url": LICENSE_URL},
            "release": self.state.release,
            "os_order": OS_ORDER,
            "stars": self.state.stars,
            "stars_label": stars_label(self.state.stars),
            "readme": self.readme,
            "guides": self.guides,
            "assets": self.state.assets,
            "theme_boot": THEME_BOOT,
            "year": now_utc().year,
            "client_data": client_data(self.loc, m, self.state),
            "lightbox_items": json.dumps([s.as_dict() for s in self.shots], ensure_ascii=False).replace("</", "<\\/"),
        }

    def crumbs(self, *extra: tuple[str, str]) -> list[dict]:
        items = [(self.m.t("nav.home"), "/")] + list(extra)
        return [{"name": name, "href": self.loc.href(path)} for name, path in items]

    def software_node(self, description: str) -> dict:
        features = [item.title for g in self.readme.features for item in g.items]
        shots = [SITE_URL + s.src for s in self.shots]
        return seo.software(self.loc, self.state.release, description, features, shots, SITE_URL + self.loc.href("/download"))

    def render(self, template: str, meta: PageMeta, **extra) -> None:
        ctx = self.base_context()
        ctx["page"] = page_context(self.loc, meta)
        ctx.update(extra)
        html = self.env.get_template(template).render(**ctx)
        html = re.sub(r"\n\s*\n+", "\n", html)
        file = page_file(meta.path) if meta.key != "404" else "404.html"
        prefix = f"{self.loc.prefix}/" if self.loc.prefix else ""
        self.state.rendered.append(Rendered(self.loc, prefix + file, html))

    def add_sitemap(self, path: str, lastmod: datetime | None) -> None:
        if self.loc.code != DEFAULT_LOCALE.code:
            return  # one entry per page, alternates cover the locales
        for l in LOCALES:
            self.state.sitemap.append(
                {
                    "url": l.url(path),
                    "lastmod": lastmod.date().isoformat() if lastmod else None,
                    "alternates": [(x.hreflang, x.url(path)) for x in LOCALES],
                    "x_default": DEFAULT_LOCALE.url(path),
                }
            )

    def build(self) -> None:
        m, loc, limit = self.m, self.loc, description_limit(self.loc)
        out = self.state.out / loc.prefix if loc.prefix else self.state.out

        # Home
        home_desc = m.t("meta.home_description")
        faq_preview = self.faq[:HOME_FAQ_COUNT]
        home_url = loc.url("/")
        self.render(
            "pages/home.html",
            PageMeta("home", "home", "/", m.t("meta.home_title"), home_desc, jsonld_nodes=[
                seo.webpage(home_url, m.t("meta.home_title"), home_desc, loc),
                self.software_node(home_desc),
                seo.source_code(),
                seo.faq_page(home_url, faq_preview, loc),
            ]),
            screenshots=self.shots,
            faq_preview=faq_preview,
            gateway_snippets=[{"id": i, "label": label, "html": _highlight(code, lang)} for i, label, lang, code in GATEWAY_SNIPPETS],
        )
        self.add_sitemap("/", latest(self.content_date, self.state.release.published))

        # Features
        feat_title = with_brand(m.t("meta.features_title"))
        feat_desc = m.t("meta.features_description")
        self.render(
            "pages/features.html",
            PageMeta("features", "features", "/features", feat_title, feat_desc, breadcrumbs=self.crumbs((m.t("nav.features"), "/features")), jsonld_nodes=[
                seo.webpage(loc.url("/features"), feat_title, feat_desc, loc, "CollectionPage"),
                self.software_node(feat_desc),
            ]),
            feature_shots={gid: self.shots[SCREENSHOTS.index(f)] for gid, f in FEATURE_SHOTS.items()},
        )
        self.add_sitemap("/features", self.content_date)

        # Download
        dl_title = with_brand(m.t("meta.download_title"))
        dl_desc = m.t("meta.download_description")
        rel = self.state.release
        linux = {a.id: a.name for a in rel.assets}
        linux_snippets = [
            (1, _highlight(f"sudo apt install ./{linux.get('linux-x64-deb', 'AQBot_amd64.deb')}", "bash")),
            (2, _highlight(f"sudo dnf install ./{linux.get('linux-x64-rpm', 'AQBot.x86_64.rpm')}", "bash")),
            (3, _highlight(f"chmod +x {linux.get('linux-x64-appimage', 'AQBot.AppImage')}\n./{linux.get('linux-x64-appimage', 'AQBot.AppImage')}", "bash")),
        ]
        self.render(
            "pages/download.html",
            PageMeta("download", "download", "/download", dl_title, dl_desc, breadcrumbs=self.crumbs((m.t("nav.download"), "/download")), jsonld_nodes=[
                seo.webpage(loc.url("/download"), dl_title, dl_desc, loc),
                self.software_node(dl_desc),
            ]),
            linux_snippets=linux_snippets,
            macos_faq=next(item for item in self.faq if item["id"].startswith("macos-")),
        )
        self.add_sitemap("/download", latest(rel.published, self.content_date))

        # FAQ
        faq_title = with_brand(m.t("meta.faq_title"))
        faq_desc = m.t("meta.faq_description")
        faq_url = loc.url("/faq")
        self.render(
            "pages/faq.html",
            PageMeta("faq", "faq", "/faq", faq_title, faq_desc, breadcrumbs=self.crumbs((m.t("nav.faq"), "/faq")), jsonld_nodes=[
                seo.webpage(faq_url, faq_title, faq_desc, loc),
                seo.faq_page(faq_url, self.faq, loc),
            ]),
            faq_items=self.faq,
        )
        self.add_sitemap("/faq", self.content_date)

        # Guides
        for g in self.guides:
            path = f"/guide/{g.slug}"
            title = f"{g.title} | {m.t('meta.docs_title_suffix')}"
            desc = clip(g.description or home_desc, limit)
            url = loc.url(path)
            self.render(
                "pages/docs.html",
                PageMeta(f"guide-{g.slug}", "docs", path, title, desc, og_type="article",
                         breadcrumbs=self.crumbs((m.t("nav.docs"), f"/guide/{GUIDES[0]}"), (g.title, path)) if g.slug != GUIDES[0] else self.crumbs((m.t("nav.docs"), path)),
                         jsonld_nodes=[seo.webpage(url, title, desc, loc), seo.tech_article(url, g.title, desc, loc, g.updated)]),
                guide=g,
            )
            self.add_sitemap(path, g.updated)

        if loc.code == DEFAULT_LOCALE.code:
            self.render(
                "pages/404.html",
                PageMeta("404", "", "/404", with_brand(m.t("notfound.title")), m.t("notfound.body"), robots="noindex,follow", markdown=False),
            )

        # Markdown mirrors and llms.txt
        home_md = export.home_markdown(m, self.readme, faq_preview, rel, home_url)
        features_md = export.features_markdown(m, self.readme, loc.url("/features"))
        faq_md = export.faq_markdown(m, self.faq, faq_url)
        download_md = export.download_markdown(m, rel, loc.url("/download"))
        guides_md = [export.guide_markdown(g, self.labels) for g in self.guides]
        write(out / "index.md", home_md)
        write(out / "features.md", features_md)
        write(out / "faq.md", faq_md)
        write(out / "download.md", download_md)
        for g, text in zip(self.guides, guides_md):
            write(out / "guide" / f"{g.slug}.md", text)
        write(out / "llms.txt", export.llms_txt(loc, m, self.faq, self.guides))
        write(out / "llms-full.txt", export.llms_full_txt(home_md, features_md, faq_md, download_md, guides_md))

        # Open Graph card
        og_path = self.state.out / "og" / f"{loc.code}.png"
        images.build_og_image(loc, m.t("meta.site_tagline"), "macOS · Windows · Linux · AGPL-3.0", og_path)


# ── fonts ──────────────────────────────────────────────────────────────────


def _codepoints(html: str) -> set[int]:
    html = re.sub(r"<style\b.*?</style>", "", html, flags=re.S)
    return {ord(c) for c in html if ord(c) >= 0x20}


def inject_fonts(state: BuildState, skip: bool) -> None:
    by_locale: dict[str, set[int]] = {}
    for r in state.rendered:
        by_locale.setdefault(r.loc.code, set()).update(_codepoints(r.html))
    font_dir = state.out / "assets" / "fonts"
    files: dict[str, fonts.FontFile] = {}
    if not skip:
        latin_cps = fonts.ALWAYS_LATIN | {cp for cps in by_locale.values() for cp in cps if fonts.is_latin_like(cp)}
        if (f := fonts.build_subset("latin", latin_cps, font_dir)):
            files["latin"] = f
            files["latin-cjk"] = fonts.FontFile(f.family, f.href, fonts.unicode_range(latin_cps - fonts.CJK_OWNED_PUNCT))
        if (f := fonts.build_subset("mono", fonts.MONO_CHARS, font_dir)):
            files["mono"] = f
        for loc in LOCALES:
            if loc.script == "latin":
                continue
            if (f := fonts.build_subset(loc.script, by_locale.get(loc.code, set()), font_dir)):
                files[loc.code] = f

    for r in state.rendered:
        cjk = r.loc.script in CJK_SCRIPTS
        faces: list[fonts.FontFile] = []
        if "latin" in files:
            faces.append(files["latin-cjk"] if cjk else files["latin"])
        if r.loc.code in files:
            faces.append(files[r.loc.code])
        if "mono" in files:
            faces.append(files["mono"])
        available = {f.family for f in faces}
        preload = "".join(
            f'<link rel="preload" href="{f.href}" as="font" type="font/woff2" crossorigin>' for f in faces if f.family != fonts.FONT_SOURCES["mono"].family
        )
        style = f"<style>{fonts.font_face_css(faces)}{fonts.font_stack_css(r.loc.script, available)}</style>"
        r.html = r.html.replace("<!--AQ_FONTS-->", preload + style, 1)


# ── entry point ────────────────────────────────────────────────────────────


def build(out: Path, offline: bool = False, skip_fonts: bool = False, draft: bool = False) -> None:
    messages = load_messages(draft)
    errors, warnings = validate(messages)
    for w in warnings:
        print(f"[i18n] warning: {w}")
    if errors and draft:
        print(f"[i18n] draft build: ignoring {len(errors)} validation errors")
    elif errors:
        raise SystemExit("i18n validation failed:\n  " + "\n  ".join(errors))

    release = load_release(offline)
    print(f"[release] v{release.version} ({'GitHub API' if release.live else 'fallback'}), {len(release.assets)} assets")
    state = BuildState(out=out, release=release, stars=load_stars(offline), messages=messages)

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name in ("logo.svg", "logo.png", "favicon.ico"):
        shutil.copyfile(STATIC_DIR / "img" / name, out / name)
    images.build_touch_icon(out)
    state.shots_meta = images.build_screenshots(SCREENSHOTS, out)
    state.assets = {"css": bundle("css", CSS_FILES, out), "js": bundle("js", JS_FILES, out)}

    env = Environment(loader=FileSystemLoader(TEMPLATES_DIR), autoescape=True, undefined=StrictUndefined, trim_blocks=False, lstrip_blocks=False)
    env.filters["phrases"] = phrases
    for loc in LOCALES:
        LocaleBuild(state, env, loc).build()
        print(f"[pages] {loc.code}")

    inject_fonts(state, skip_fonts)
    for r in state.rendered:
        write(out / r.file, r.html)

    write(out / "sitemap.xml", seo.sitemap(state.sitemap))
    write(out / "robots.txt", seo.robots())
    write(out / "manifest.webmanifest", seo.manifest(messages[DEFAULT_LOCALE.code].t("meta.home_description")))
    write(out / ".nojekyll", "")
    print(f"[done] {len(state.rendered)} pages → {out}")
