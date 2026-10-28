"""Locale message loading, lookup and completeness validation."""

from __future__ import annotations

import json
import re
from typing import Any

from .config import LOCALES, LOCALES_DIR, SOURCE_LOCALES

_PLACEHOLDER = re.compile(r"\{\{\s*(\w+)\s*\}\}")

# Leaf keys whose value is intentionally identical in every locale.
LANGUAGE_NEUTRAL = {
    "nav.github",
    "os.macos",
    "os.windows",
    "os.linux",
    "footer.linuxdo",
    "download.arch_arm64",
    "download.arch_x64",
    "download.kind_appimage",
    "demo.kb_doc_1",
    "demo.kb_doc_2",
    "demo.kb_doc_3",
}
# Prefix match for keys that commonly stay in English in technical locales
# (for example "Agent" or "MCP"); they are reported but never fatal.
SOFT_NEUTRAL_PREFIXES = ("demo.tab_", "download.kind_", "download.arch_", "demo.agent_step_")


class Messages:
    def __init__(self, code: str, data: dict[str, Any]):
        self.code = code
        self.data = data

    def get(self, key: str) -> Any:
        node: Any = self.data
        for part in key.split("."):
            if isinstance(node, list):
                node = node[int(part)]
            else:
                node = node[part]
        return node

    def t(self, key: str, **params: Any) -> str:
        value = self.get(key)
        if not isinstance(value, str):
            raise TypeError(f"{self.code}:{key} is not a string")
        return _PLACEHOLDER.sub(lambda m: str(params[m.group(1)]), value)


def flatten(node: Any, prefix: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    if isinstance(node, dict):
        for k, v in node.items():
            out.update(flatten(v, f"{prefix}{k}."))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out.update(flatten(v, f"{prefix}{i}."))
    else:
        out[prefix[:-1]] = node
    return out


def load_messages(draft: bool = False) -> dict[str, Messages]:
    """`draft` lets a missing locale fall back to English for local previews."""
    result = {}
    for loc in LOCALES:
        path = LOCALES_DIR / f"{loc.code}.json"
        if draft and not path.exists():
            path = LOCALES_DIR / "en.json"
        result[loc.code] = Messages(loc.code, json.loads(path.read_text(encoding="utf-8")))
    return result


def validate(messages: dict[str, Messages]) -> tuple[list[str], list[str]]:
    """Return (errors, warnings). Errors fail the build."""
    errors: list[str] = []
    warnings: list[str] = []
    flat = {code: flatten(m.data) for code, m in messages.items()}
    reference = flat[SOURCE_LOCALES[0]]
    for src in SOURCE_LOCALES[1:]:
        if set(flat[src]) != set(reference):
            errors.append(f"source locales differ: {sorted(set(flat[src]) ^ set(reference))[:10]}")
    english = flat["en"]
    for code, values in flat.items():
        missing = set(reference) - set(values)
        extra = set(values) - set(reference)
        if missing:
            errors.append(f"{code}: missing keys {sorted(missing)[:12]}")
        if extra:
            errors.append(f"{code}: unknown keys {sorted(extra)[:12]}")
        for key, value in values.items():
            if key not in reference:
                continue
            if not isinstance(value, str) or not value.strip():
                errors.append(f"{code}: empty value for {key}")
                continue
            if set(_PLACEHOLDER.findall(value)) != set(_PLACEHOLDER.findall(reference[key])):
                errors.append(f"{code}: placeholder mismatch in {key}")
            if code != "en" and value == english.get(key) and key not in LANGUAGE_NEUTRAL:
                message = f"{code}: {key} is identical to English"
                if key.startswith(SOFT_NEUTRAL_PREFIXES):
                    warnings.append(message)
                else:
                    errors.append(message)
    return errors, warnings
