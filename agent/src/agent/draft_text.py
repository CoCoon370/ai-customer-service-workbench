"""Convert model output into plain, customer-ready Chinese text."""

from __future__ import annotations

import re

_MARKDOWN_LINK = re.compile(r"\[([^\]]+)]\([^)]+\)")
_LINE_PREFIX = re.compile(r"^\s*(?:#{1,6}\s*|>\s*|[-+•·]\s+|\d+[.)、]\s+)")


def normalize_customer_draft(value: str) -> str:
    """Remove model-facing Markdown while preserving factual punctuation."""
    text = _MARKDOWN_LINK.sub(r"\1", value.replace("\r\n", "\n"))
    text = text.replace("**", "").replace("__", "").replace("*", "").replace("`", "")
    lines = []
    for raw_line in text.split("\n"):
        line = _LINE_PREFIX.sub("", raw_line).strip()
        line = line.rstrip("~～").rstrip()
        lines.append(line)

    normalized = "\n".join(lines)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()
