"""PDF 重建：redaction 删除原文本，再按段落重排并以原生字体/颜色写回译文。"""
from __future__ import annotations

import os
import re
from typing import Any

import pymupdf as fitz  # 1.28.2 的 fitz shim 会在 stdout 打印弃用警告，污染 stdio 协议

from worker import extract


def _extract_geometry(doc: fitz.Document, page_index: int) -> list[dict[str, Any]]:
    """重建时重新提取页面段落，得到 id → (bbox, anchor, fontsize, color) 几何表。"""
    body = extract._body_size_of_page(doc, page_index)
    paras = extract._paragraphs_of_page(doc, page_index, body_size=body)
    return [p.to_dict() for p in paras]


def _geometry_map(page_paras: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    return {p["id"]: p for p in page_paras}


def _hex_to_rgb(color: str) -> tuple[float, float, float]:
    """'#rrggbb' → (r, g, b) 浮点分量（0..1）。

    extract 的 Span.color 是 '#rrggbb' 字符串；pymupdf 1.28.2 的文字写入
    只接受 0..1 数值分量（旧版支持 hex 字符串的写法已移除）。
    """
    value = color.lstrip("#")
    return tuple(int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4))


def _write_translation(
    page: fitz.Page,
    para: dict[str, Any],
    text: str,
    resolver: FontResolver,
    page_paras: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """把译文写入段落锚点区域（不负责 redaction——由调用方两阶段批量处理）。

    两阶段重建的原因（真实使用发现，见 test_rebuild_overlapping_paragraphs_keep_both_translations）：
    书名页等版式里相邻段落的 bbox 纵向重叠（大字号作者行 + 紧贴其下的小字号单位行）。
    旧实现逐段落「redact → 写」，后一段落的 redact 矩形会覆盖已写入的上一段译文，
    apply_redactions 把相交字符删除（如 'Rafael C. ' 丢失、只剩 'onzalez'）。
    正确顺序：先一次性删除本页全部原文，再统一写回全部译文。
    """
    warnings: list[dict[str, Any]] = []
    first_span = para["lines"][0]["spans"][0]
    anchor_y = first_span["origin"][1]
    fontsize = float(first_span["size"])
    color = _hex_to_rgb(first_span["color"])
    alignment = str(para.get("alignment", "left"))

    warnings.extend(
        _write_with_overflow_handling(
            page, para, text, anchor_y, fontsize, color, resolver,
            first_span["font"], alignment, bool(first_span.get("bold", False)),
            page_paras,
        )
    )
    return warnings


def _text_width(text: str, fontname: str, fontfile: str | None, fontsize: float) -> float:
    if text == "":
        return 0.0
    try:
        font = fitz.Font(fontname=fontname, fontfile=fontfile)
        return font.text_length(text, fontsize=fontsize)
    except Exception:  # noqa: BLE001
        return len(text) * fontsize * 0.5


def _wrap_paragraph(
    text: str,
    fontname: str,
    fontfile: str | None,
    fontsize: float,
    width: float,
) -> list[str]:
    """Greedy wrap of one paragraph at *width*.

    Latin words stay whole; CJK characters and punctuation may break anywhere.
    This is the paragraph-level counterpart of the old "one insert per source
    line" fallback: translated text is re-flowed from scratch at the original
    column width, never mapped back onto the PDF's original lines.
    """
    if text == "":
        return [""]
    font = None
    try:
        font = fitz.Font(fontname=fontname, fontfile=fontfile)
    except Exception:  # noqa: BLE001
        font = None

    def measure(value: str) -> float:
        if font is not None:
            try:
                return font.text_length(value, fontsize=fontsize)
            except Exception:  # noqa: BLE001
                pass
        return len(value) * fontsize * 0.5

    def break_word(word: str) -> list[str]:
        pieces: list[str] = []
        chunk = ""
        for char in word:
            candidate = chunk + char
            if chunk == "" or measure(candidate) <= width:
                chunk = candidate
            else:
                pieces.append(chunk)
                chunk = char
        if chunk != "":
            pieces.append(chunk)
        return pieces or [word]

    lines: list[str] = []
    # Explicit newlines are semantic (code, poetry, deliberate list layout).
    for raw_paragraph in text.split("\n"):
        if raw_paragraph == "":
            lines.append("")
            continue
        current = ""
        pending_space = False
        for token in re.findall(r"\s+|[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]|[^\s\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]+", raw_paragraph):
            if token.isspace():
                if current == "":
                    # Keep leading indentation (code blocks rely on it); for
                    # prose it is harmless and the model rarely emits it.
                    current = token
                else:
                    pending_space = True
                continue
            separator = " " if pending_space and current != "" else ""
            candidate = current + separator + token
            if measure(candidate) <= width or current == "":
                if measure(candidate) <= width:
                    current = candidate
                else:
                    pieces = break_word(token)
                    lines.extend(current_piece for current_piece in ([current] if current else []) + pieces[:-1] if current_piece != "")
                    current = pieces[-1]
                pending_space = False
                continue
            if current != "":
                lines.append(current)
                current = ""
            pieces = break_word(token)
            lines.extend(piece for piece in pieces[:-1] if piece != "")
            current = pieces[-1]
            pending_space = False
        if current != "":
            lines.append(current)
    # Remove trailing empty line introduced by a trailing newline, but keep
    # explicit blank lines inside code blocks.
    while len(lines) > 1 and lines[-1] == "" and lines[-2] == "":
        lines.pop()
    return lines or [""]


def _layout_right(para: dict[str, Any], page_paras: list[dict[str, Any]], page: fitz.Page) -> float:
    """Best-effort right edge of the paragraph's text column.

    Body paragraphs in a justified column expose the column edge as their
    widest line. Left-aligned ragged paragraphs often stop short, so look at
    the other paragraphs sharing the same left edge and take the widest one,
    capped by the page margin. Centered/right-aligned headings use the full
    text column instead of their own centered bbox. Figures to the right act
    as hard obstacles so a reflowed paragraph never runs through a diagram.
    """
    rect = fitz.Rect(*para["bbox"])
    page_width = page.rect.width
    kind = str(para.get("type", "body"))
    alignment = str(para.get("alignment", "left"))
    if kind in ("code", "table-cell"):
        return max(rect.x1, rect.x0 + 4)
    if alignment in ("center", "right") and kind == "heading":
        return max(rect.x1, page_width - 36.0)

    same_column = [
        p for p in page_paras
        if p.get("id") != para.get("id")
        and str(p.get("type", "body")) not in ("code", "table-cell")
        and abs(float(p["bbox"][0]) - rect.x0) <= 30.0
        and float(p["bbox"][2]) > rect.x0 + 40.0
    ]
    right = max([rect.x1] + [float(p["bbox"][2]) for p in same_column])
    if right - rect.x0 < 240.0:
        right = max(right, rect.x0 + min(240.0, page_width - rect.x0 - 18.0))
    right = min(right + 1.0, page_width - 18.0)

    obstacles: list[fitz.Rect] = []
    # A paragraph that starts to our right but overlaps vertically belongs to
    # another column; never reflow into it.
    for other in page_paras:
        if other.get("id") == para.get("id"):
            continue
        other_rect = fitz.Rect(*other["bbox"])
        if other_rect.x0 >= rect.x1 - 1.0 and other_rect.y1 > rect.y0 - 4.0 and other_rect.y0 < rect.y1 + 20.0:
            obstacles.append(other_rect)
    try:
        obstacles.extend(fitz.Rect(info["bbox"]) for info in page.get_image_info())
    except Exception:  # noqa: BLE001
        pass
    try:
        obstacles.extend(fitz.Rect(d["rect"]) for d in page.get_drawings())
    except Exception:  # noqa: BLE001
        pass
    for obstacle in obstacles:
        if obstacle.x0 >= rect.x1 - 1.0 and obstacle.x0 < right:
            vertical_overlap = obstacle.y1 > rect.y0 - 4.0 and obstacle.y0 < rect.y1 + 20.0
            if vertical_overlap:
                right = min(right, obstacle.x0 - 4.0)
    return max(rect.x1, right)


def _available_bottom(
    page: fitz.Page,
    para: dict[str, Any],
    page_paras: list[dict[str, Any]],
    right: float,
) -> float:
    rect = fitz.Rect(*para["bbox"])
    page_bottom = page.rect.y1 - 18.0
    next_top = page_bottom
    for other in page_paras:
        if other.get("id") == para.get("id"):
            continue
        other_rect = fitz.Rect(*other["bbox"])
        if other_rect.y0 <= rect.y0 + 2.0:
            continue
        if other_rect.x1 <= rect.x0 + 2.0 or other_rect.x0 >= right - 2.0:
            continue
        next_top = min(next_top, other_rect.y0 - 4.0)
    # Vector/bitmap figures are obstacles too: translated text must not run
    # through a diagram when it grows downwards.
    try:
        for image in page.get_image_info():
            image_rect = fitz.Rect(image["bbox"])
            if image_rect.y0 > rect.y0 + 2.0 and image_rect.y1 > rect.y0:
                if image_rect.x1 > rect.x0 + 2.0 and image_rect.x0 < right - 2.0:
                    next_top = min(next_top, image_rect.y0 - 4.0)
    except Exception:  # noqa: BLE001
        pass
    try:
        for drawing in page.get_drawings():
            drawing_rect = fitz.Rect(drawing["rect"])
            if drawing_rect.y0 > rect.y0 + 2.0 and drawing_rect.y1 > rect.y0:
                if drawing_rect.x1 > rect.x0 + 2.0 and drawing_rect.x0 < right - 2.0:
                    next_top = min(next_top, drawing_rect.y0 - 4.0)
    except Exception:  # noqa: BLE001
        pass
    # Permit normal paragraphs to breathe, but do not consume a whole blank
    # page just because the source happened to end mid-page.
    return max(rect.y1, min(page_bottom, next_top, rect.y1 + 120.0))


def _draw_wrapped_lines(
    page: fitz.Page,
    lines: list[str],
    para: dict[str, Any],
    right: float,
    anchor_y: float,
    fontsize: float,
    lineheight: float,
    color: tuple[float, float, float],
    fontname: str,
    fontfile: str | None,
    alignment: str,
    bold: bool,
) -> None:
    rect = fitz.Rect(*para["bbox"])
    width = max(4.0, right - rect.x0)
    try:
        font = fitz.Font(fontname=fontname, fontfile=fontfile)
    except Exception:  # noqa: BLE001
        font = None

    def measure(value: str) -> float:
        if font is not None:
            try:
                return font.text_length(value, fontsize=fontsize)
            except Exception:  # noqa: BLE001
                pass
        return len(value) * fontsize * 0.5

    for index, line in enumerate(lines):
        if line == "":
            continue
        width_line = measure(line)
        x = rect.x0
        if alignment == "center":
            x = rect.x0 + max(0.0, (width - width_line) / 2.0)
        elif alignment == "right":
            x = rect.x0 + max(0.0, width - width_line)
        # A justified line distributes the spare width over its word gaps.
        # Last lines and CJK-only lines stay natural (no invented spaces).
        if alignment == "justify" and index < len(lines) - 1 and " " in line:
            words = line.split(" ")
            words_width = sum(measure(word) for word in words)
            gap = (width - words_width) / max(1, len(words) - 1)
            if gap > 0:
                cursor = rect.x0
                for word in words:
                    page.insert_text(
                        (cursor, anchor_y + index * fontsize * lineheight),
                        word, fontsize=fontsize, color=color,
                        fontname=fontname, fontfile=fontfile,
                    )
                    cursor += measure(word) + gap
                continue
        page.insert_text(
            (x, anchor_y + index * fontsize * lineheight),
            line, fontsize=fontsize, color=color,
            fontname=fontname, fontfile=fontfile,
        )


def _write_with_overflow_handling(
    page: fitz.Page, para: dict[str, Any], text: str,
    anchor_y: float, fontsize: float, color: tuple[float, float, float],
    resolver: FontResolver, font: str, alignment: str, bold: bool,
    page_paras: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Reflow the translation as a paragraph, not as the PDF's original lines.

    Strategy:
      * compute the column width and the available vertical slot;
      * wrap the translated text at the original font size;
      * if it does not fit, shrink the font gradually to a readable floor;
      * only then tighten line spacing, and finally keep the smallest readable
        size and emit an overflow warning. We never map one translated line
        back onto one source line.
    """
    warnings: list[dict[str, Any]] = []
    fontname, fontfile = resolver.resolve(font=font, text=text, lang="", bold=bold)
    rect = fitz.Rect(*para["bbox"])
    right = _layout_right(para, page_paras, page)
    bottom = _available_bottom(page, para, page_paras, right)
    available_height = max(fontsize * 1.1, bottom - (anchor_y - fontsize * 0.82))

    # Try the original size first and step down in 0.5pt increments. A floor
    # of 7.5pt keeps long paragraphs legible; below that shrinking stops.
    sizes: list[float] = []
    size = fontsize
    floor = max(7.5, fontsize * 0.70)
    while size > floor + 0.01:
        sizes.append(round(size, 2))
        size -= 0.5
    sizes.append(round(floor, 2))

    for lineheight in (1.22, 1.10):
        for candidate in sizes:
            lines = _wrap_paragraph(text, fontname, fontfile, candidate, max(4.0, right - rect.x0))
            used_height = (len(lines) - 1) * candidate * lineheight + candidate * 1.05
            if used_height > available_height + 0.5:
                continue
            _draw_wrapped_lines(
                page, lines, para, right, anchor_y, candidate, lineheight,
                color, fontname, fontfile, alignment, bold,
            )
            if candidate < fontsize - 0.25:
                warnings.append({
                    "page": page.number, "paraId": para["id"], "kind": "overflow",
                    "detail": f"fontsize scaled {fontsize:.1f}→{candidate:.1f} to keep paragraph readable",
                })
            return warnings

    # Nothing fits even at the readable floor: keep the paragraph at the
    # smallest size (no per-source-line fallback) and report the overflow so
    # the caller can surface it. Draw everything so no translated text is lost
    # silently; overflow may extend beyond the paragraph slot.
    lines = _wrap_paragraph(text, fontname, fontfile, floor, max(4.0, right - rect.x0))
    _draw_wrapped_lines(
        page, lines, para, right, anchor_y, floor, 1.10,
        color, fontname, fontfile, alignment, bold,
    )
    warnings.append({
        "page": page.number, "paraId": para["id"], "kind": "overflow",
        "detail": f"paragraph does not fit at {floor:.1f}pt; reflowed beyond its slot",
    })
    return warnings


_REDACT_PAD = 2.0  # redaction 覆盖矩形的外扩边距（捕获链接与覆盖共用，防漂移）


def _redact_rect(para: dict[str, Any]) -> fitz.Rect:
    """redaction 覆盖矩形 = 段落 bbox 外扩 _REDACT_PAD pt。

    _capture_links 与 _cover_and_write 共用同一构造：若只按未扩宽的 bbox 捕获，
    落在 2pt 边带内的链接会被 redaction 删除却未被捕获（静默丢失）。
    """
    return fitz.Rect(*para["bbox"]) + (-_REDACT_PAD, -_REDACT_PAD, _REDACT_PAD, _REDACT_PAD)


def _capture_links(page: fitz.Page, rects: list[fitz.Rect]) -> list[dict[str, Any]]:
    """捕获与任一待 redact 段落矩形相交的链接（redaction 会删除它们）。"""
    captured: list[dict[str, Any]] = []
    for link in page.get_links():
        link_rect = fitz.Rect(link.get("from"))
        if any(link_rect.intersects(r) for r in rects):
            captured.append(link)
    return captured


def _restore_links(page: fitz.Page, links: list[dict[str, Any]]) -> None:
    """恢复捕获的链接；仅补回 redaction 后已不存在的（避免重复）。"""
    for link in links:
        link_rect = fitz.Rect(link.get("from"))
        if not any(fitz.Rect(existing.get("from")) == link_rect for existing in page.get_links()):
            page.insert_link(link)


def _redact_page(page: fitz.Page, rects: list[fitz.Rect]) -> None:
    """一次性删除本页所有待替换段落的原文（两阶段重建的第 ① 阶段）。

    注：pymupdf 1.28.2 的 apply_redactions 签名是 (images, graphics, text)，
    已无 annots 参数（旧版 PDF_REDACT_ANNOTS_* 常量随之移除）。此版本行为：
    非链接注释保留；**与 redaction 区域相交的链接注释（URI link）会被删除**——
    调用方必须先用 _capture_links 捕获、_restore_links 恢复。
    """
    for rect in rects:
        # fill=None：只删除文字，不用白色矩形覆盖原页背景/底图/底色。
        # 实测 PyMuPDF 1.28.2 接受 None（fill=False 会抛 TypeError）。
        page.add_redact_annot(rect, fill=None)
    page.apply_redactions(
        images=fitz.PDF_REDACT_IMAGE_NONE,
        graphics=fitz.PDF_REDACT_LINE_ART_NONE,
        text=fitz.PDF_REDACT_TEXT_REMOVE,
    )


def rebuild_document(payload: dict[str, Any]) -> dict[str, Any]:
    input_path = payload["inputPath"]
    output_path = payload["outputPath"]
    pages = payload["pages"]
    doc = fitz.open(input_path)
    warnings: list[dict[str, Any]] = []
    resolver = FontResolver()
    try:
        for page_payload in pages:
            index = int(page_payload["index"])
            page = doc[index]
            page_paras = _extract_geometry(doc, index)
            geometry = _geometry_map(page_paras)
            # Task 21：pymupdf 1.28.2 的 redaction 会删除与区域相交的链接注释，
            # 先捕获本页将被 redact 的段落矩形相交的链接，写完后恢复。
            # 捕获矩形与 _redact_rect 的覆盖矩形必须一致（_redact_rect 共享），
            # 否则 2pt 边带内的链接会被删除却未捕获。
            redact_rects: list[fitz.Rect] = []
            write_items: list[tuple[dict[str, Any], str]] = []
            for item in page_payload.get("paragraphs", []):
                para_id = int(item["id"])
                para = geometry.get(para_id)
                text = item.get("text", "")
                if para is None:
                    warnings.append({"page": index, "paraId": para_id, "kind": "empty", "detail": "geometry not found"})
                    continue
                if not text.strip():
                    continue  # 空译文段落保留原文（不 redact、不写）
                redact_rects.append(_redact_rect(para))
                write_items.append((para, text))
            # 两阶段重建（2026-09-01 真实使用修复）：先删除本页全部原文，
            # 再统一写入全部译文——逐段落「redact→写」会让后段 redaction 删掉
            # 已写入的前段译文（段落 bbox 纵向重叠时，如书名页大字号行+小字号行）。
            captured_links = _capture_links(page, redact_rects)
            _redact_page(page, redact_rects)
            for para, text in write_items:
                warnings.extend(_write_translation(page, para, text, resolver, page_paras))
            _restore_links(page, captured_links)
        doc.save(output_path, incremental=False, garbage=3, deflate=True)
        return {"warnings": warnings}
    finally:
        doc.close()


_BASE14 = {
    # 顺序关键：更长前缀（helvetica-bold）必须在前，否则 startswith("helvetica")
    # 先命中、bold 权重静默丢失（hebo 不可达）
    "helvetica-bold": ("hebo", None),
    "helvetica": ("helv", None),
    "times-bold": ("tibo", None),
    "times-roman": ("tiro", None),
    "times": ("tiro", None),
    "courier-bold": ("cobo", None),
    "couriernew": ("cour", None),
    "courier": ("cour", None),
    "symbol": ("symb", None),
    "zapfdingbats": ("zadb", None),
}

_BOLD_BASE14 = {
    "helv": ("hebo", None),
    "tiro": ("tibo", None),
    "cour": ("cobo", None),
}

_CJK_RE = re.compile(r"[\u3000-\u9fff\uf900-\ufaff]")

_MSYH = r"C:\Windows\Fonts\msyh.ttc"
_MSYH_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"


class FontResolver:
    """把原字体名映射到 PyMuPDF 可用的 (fontname, fontfile)。缺字形时回退到 CJK/无衬线。"""

    def __init__(self) -> None:
        self._cache: dict[str, tuple[str, str | None]] = {}

    def resolve(self, font: str, text: str, lang: str, bold: bool = False) -> tuple[str, str | None]:
        key = f"{font}|{lang}|{bool(_CJK_RE.search(text))}|{bold}"
        if key in self._cache:
            return self._cache[key]
        result = self._resolve(font, text, lang, bold)
        self._cache[key] = result
        return result

    def _resolve(self, font: str, text: str, lang: str, bold: bool) -> tuple[str, str | None]:
        lowered = font.lower()
        # 注意：CJK 需求必须先于 base-14 映射判断——base-14 字体（Helvetica/Times…）
        # 没有 CJK 字形，含 CJK 的译文必须回退（test_cjk_fallback_for_latin_font）。
        needs_cjk = bool(_CJK_RE.search(text)) or lang.startswith("zh") or lang.startswith("ja") or lang.startswith("ko")
        if needs_cjk:
            if bold and os.path.exists(_MSYH_BOLD):
                return ("msyhbd", _MSYH_BOLD)
            if os.path.exists(_MSYH):
                return ("msyh", _MSYH)
            return ("china-s", None)  # PyMuPDF 内置 CJK 字体
        for prefix, mapped in _BASE14.items():
            if lowered.startswith(prefix):
                if bold and mapped[0] in _BOLD_BASE14:
                    return _BOLD_BASE14[mapped[0]]
                return mapped
        if re.search(r"(?i)mono|courier|consolas", lowered):
            return ("cobo" if bold else "cour", None)
        return ("hebo" if bold else "helv", None)
