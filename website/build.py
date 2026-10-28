#!/usr/bin/env python3
"""AQBot website builder.

Usage:
  python website/build.py build [--out DIR] [--offline] [--no-fonts]
  python website/build.py serve [--port 4173] [--offline] [--no-fonts]
  python website/build.py check
"""

from __future__ import annotations

import argparse
import functools
import http.server
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aqsite.config import DEFAULT_OUT_DIR  # noqa: E402


class CleanUrlHandler(http.server.SimpleHTTPRequestHandler):
    """Serves /features from features.html like GitHub Pages does."""

    def send_head(self):
        path = Path(self.translate_path(self.path))
        if not path.exists() and path.with_suffix(".html").exists() and not self.path.endswith("/"):
            self.path = self.path.split("?", 1)[0] + ".html"
        elif not path.exists():
            self.path = "/404.html"
        return super().send_head()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the AQBot static website")
    parser.add_argument("command", nargs="?", default="build", choices=["build", "serve", "check"])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--offline", action="store_true", help="skip GitHub API calls")
    parser.add_argument("--no-fonts", action="store_true", help="skip font subsetting (system fonts only)")
    parser.add_argument("--draft", action="store_true", help="local preview: tolerate missing translations")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()

    if args.command == "check":
        from aqsite.locales import load_messages, validate

        errors, warnings = validate(load_messages())
        for w in warnings:
            print(f"warning: {w}")
        for e in errors:
            print(f"error: {e}")
        sys.exit(1 if errors else 0)

    from aqsite.builder import build

    build(args.out.resolve(), offline=args.offline, skip_fonts=args.no_fonts, draft=args.draft)
    if args.command == "serve":
        handler = functools.partial(CleanUrlHandler, directory=str(args.out.resolve()))
        with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
            print(f"Serving on http://127.0.0.1:{args.port}")
            httpd.serve_forever()


if __name__ == "__main__":
    main()
