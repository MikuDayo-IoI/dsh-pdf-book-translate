"""书籍大纲识别：优先使用 PDF 目录，其次用标题几何 + 章节编号启发式。

协议输出中的页码全部是 0-based（与 extract 一致）；TS 层负责显示为 1-based。
"""
from __future__ import annotations

import re
from typing import Any

import pymupdf as fitz

from worker import extract

_CHAPTER_RE = re.compile(
    r"^\s*(?:"
    r"第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[章篇部卷]"
    r"|chapter\s+[0-9ivxlcdm]+(?:\b|:|\s)"
    r"|part\s+[0-9ivxlcdm]+(?:\b|:|\s)"
    r"|book\s+[0-9ivxlcdm]+(?:\b|:|\s)"
    r"|(?:前言|序言|序|引言|导言|绪论|后记|结语|附录(?:\s*[A-Z0-9一二三四五六七八九十]+)?|目录|致谢)"
    r"|(?:preface|foreword|introduction|prologue|epilogue|afterword|appendix|contents|acknowledg(?:e)?ments?)\b"
    r")",
    re.IGNORECASE,
)

_SECTION_RE = re.compile(
    r"^\s*(?:"
    r"第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[节節]"
    r"|section\s+[0-9]+(?:\.[0-9]+)*"
    r"|[0-9]+(?:\.[0-9]+)+[\s:：.、]"
    r"|[0-9]+\s+[A-Z][A-Za-z]"
    r")",
    re.IGNORECASE,
)


def _valid_toc(doc: fitz.Document) -> list[dict[str, Any]]:
    toc: list[dict[str, Any]] = []
    try:
        raw = doc.get_toc(simple=True)
    except Exception:  # noqa: BLE001 - 损坏目录不应阻断回退路径
        raw = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            continue
        level, title, page = item[0], str(item[1]).strip(), item[2]
        try:
            level = int(level)
            page = int(page)
        except (TypeError, ValueError):
            continue
        if not title or page < 1 or page > doc.page_count:
            continue
        toc.append({"level": max(1, level), "title": title, "page": page - 1})
    toc.sort(key=lambda x: (x["page"], x["level"]))
    return toc


def _toc_outline(toc: list[dict[str, Any]], page_count: int) -> list[dict[str, Any]]:
    """TOC 的 level 1 → 章，level 2 → 节；没有 level 1 时把 level 2 提升为章。"""
    levels = {entry["level"] for entry in toc}
    chapter_level = 1 if 1 in levels else min(levels)
    section_level = next((lv for lv in sorted(levels) if lv > chapter_level), None)

    raw_chapters: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for entry in toc:
        if entry["level"] <= chapter_level or current is None:
            current = {
                "title": entry["title"],
                "pageStart": entry["page"],
                "sections": [],
            }
            raw_chapters.append(current)
        elif section_level is not None and entry["level"] == section_level:
            current["sections"].append({
                "title": entry["title"],
                "pageStart": entry["page"],
            })
    # 同一页可能重复章标题（书眉/分卷），保留页序稳定，去掉完全重复
    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for chapter in raw_chapters:
        key = (chapter["title"], chapter["pageStart"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(chapter)
    raw_chapters = deduped
    if not raw_chapters:
        return []

    if raw_chapters[0]["pageStart"] > 0:
        raw_chapters.insert(0, {
            "title": "前置内容 / Front matter",
            "pageStart": 0,
            "sections": [],
        })

    chapters: list[dict[str, Any]] = []
    for index, chapter in enumerate(raw_chapters):
        start = max(0, min(chapter["pageStart"], page_count - 1))
        next_start = (
            raw_chapters[index + 1]["pageStart"] if index + 1 < len(raw_chapters) else page_count
        )
        end = max(start, min(page_count - 1, next_start - 1))
        sections: list[dict[str, Any]] = []
        raw_sections = sorted(chapter["sections"], key=lambda s: s["pageStart"])
        for s_index, section in enumerate(raw_sections):
            s_start = max(start, min(section["pageStart"], end))
            s_next = raw_sections[s_index + 1]["pageStart"] if s_index + 1 < len(raw_sections) else end + 1
            s_end = max(s_start, min(end, s_next - 1))
            sections.append({
                "id": f"sec-{index + 1}-{s_index + 1}",
                "title": section["title"],
                "pageStart": s_start,
                "pageEnd": s_end,
            })
        chapters.append({
            "id": f"ch-{index + 1}",
            "title": chapter["title"],
            "pageStart": start,
            "pageEnd": end,
            "sections": sections,
        })
    return chapters


def _heading_candidates(doc: fitz.Document) -> list[dict[str, Any]]:
    """无 TOC 时逐页找标题候选，保留页内位置和字号。"""
    candidates: list[dict[str, Any]] = []
    for page_index in range(doc.page_count):
        body = extract._body_size_of_page(doc, page_index)
        paras = extract._paragraphs_of_page(doc, page_index, body_size=body)
        for para in paras:
            if para.type != "heading":
                continue
            text = " ".join(para.lines[0].text.split()).strip()
            if not text or len(text) > 160:
                continue
            size = max(span.size for line in para.lines for span in line.spans)
            if _CHAPTER_RE.match(text):
                level = 1
            elif _SECTION_RE.match(text):
                level = 2
            else:
                level = 0
            candidates.append({
                "title": text,
                "page": page_index,
                "size": round(size, 2),
                "level": level,
                "y": para.bbox[1],
            })
    return candidates


def _heuristic_outline(doc: fitz.Document) -> tuple[list[dict[str, Any]], str]:
    candidates = _heading_candidates(doc)
    explicit_chapters = [c for c in candidates if c["level"] == 1]
    if not explicit_chapters:
        # 没有任何“第 X 章/Chapter N”时，用页面内最大标题字号作为章级阈值。
        if not candidates:
            return [], "no headings detected"
        largest = max(c["size"] for c in candidates)
        for c in candidates:
            if c["level"] == 0:
                c["level"] = 1 if c["size"] >= largest * 0.92 else 2
        explicit_chapters = [c for c in candidates if c["level"] == 1]
        if not explicit_chapters:
            explicit_chapters = [candidates[0]]
            explicit_chapters[0]["level"] = 1

    # 只保留每页第一个章标题，避免书眉/重复标题制造空章。
    chapter_entries: list[dict[str, Any]] = []
    seen_pages: set[int] = set()
    for c in explicit_chapters:
        if c["page"] in seen_pages:
            continue
        seen_pages.add(c["page"])
        chapter_entries.append(c)
    if not chapter_entries:
        return [], "no chapter headings"

    chapters: list[dict[str, Any]] = []
    for index, entry in enumerate(chapter_entries):
        start = entry["page"]
        next_start = chapter_entries[index + 1]["page"] if index + 1 < len(chapter_entries) else doc.page_count
        end = max(start, min(doc.page_count - 1, next_start - 1))
        sections: list[dict[str, Any]] = []
        secs = [
            c for c in candidates
            if c["level"] >= 2 and start <= c["page"] <= end and c["title"] != entry["title"]
        ]
        # 同一页可以同时包含多个节标题；保留它们，页范围由后续逻辑计算。
        for s_index, sec in enumerate(secs):
            sections.append({
                "id": f"sec-{index + 1}-{len(sections) + 1}",
                "title": sec["title"],
                "pageStart": sec["page"],
            })
        for s_index, section in enumerate(sections):
            s_next = sections[s_index + 1]["pageStart"] if s_index + 1 < len(sections) else end + 1
            section["pageEnd"] = max(section["pageStart"], min(end, s_next - 1))
            section.pop("page", None)
        chapters.append({
            "id": f"ch-{index + 1}",
            "title": entry["title"],
            "pageStart": start,
            "pageEnd": end,
            "sections": sections,
        })

    if chapters and chapters[0]["pageStart"] > 0:
        chapters.insert(0, {
            "id": "ch-0",
            "title": "前置内容 / Front matter",
            "pageStart": 0,
            "pageEnd": chapters[0]["pageStart"] - 1,
            "sections": [],
        })
        for index, chapter in enumerate(chapters):
            chapter["id"] = f"ch-{index + 1}"
            for s_index, section in enumerate(chapter["sections"]):
                section["id"] = f"sec-{index + 1}-{s_index + 1}"
    return chapters, "heuristic"


def _sample_text(doc: fitz.Document, start: int, end: int, max_chars: int = 7000) -> str:
    """跨章采样：开头 + 中段 + 结尾，避免只读目录页。"""
    if end < start:
        return ""
    pages = list(range(start, end + 1))
    if len(pages) > 3:
        picks = list(dict.fromkeys([pages[0], pages[len(pages) // 2], pages[-1]]))
    else:
        picks = pages
    chunks: list[str] = []
    for page_index in picks:
        try:
            text = doc[page_index].get_text("text")
        except Exception:  # noqa: BLE001
            continue
        text = re.sub(r"\n{3,}", "\n\n", text)
        chunks.append(f"[page {page_index + 1}]\n{text.strip()}")
        if sum(len(c) for c in chunks) >= max_chars:
            break
    joined = "\n\n".join(chunks)
    return joined[:max_chars]


def outline_document(payload: dict[str, Any]) -> dict[str, Any]:
    path = payload["path"]
    doc = fitz.open(path)
    try:
        toc = _valid_toc(doc)
        chapters: list[dict[str, Any]] = []
        source = "toc"
        if toc:
            chapters = _toc_outline(toc, doc.page_count)
        if not chapters:
            chapters, source = _heuristic_outline(doc)
        warnings: list[str] = []
        if not chapters:
            chapters = [{
                "id": "ch-1",
                "title": "全书 / Whole book",
                "pageStart": 0,
                "pageEnd": doc.page_count - 1,
                "sections": [],
            }]
            warnings.append("未能识别章节标题，已回退为单章全书范围。")
            source = "fallback"
        for chapter in chapters:
            chapter["sampleText"] = _sample_text(doc, chapter["pageStart"], chapter["pageEnd"])
            chapter["pageCount"] = chapter["pageEnd"] - chapter["pageStart"] + 1
        return {
            "pageCount": doc.page_count,
            "source": source,
            "toc": toc,
            "chapters": chapters,
            "warnings": warnings,
        }
    finally:
        doc.close()
