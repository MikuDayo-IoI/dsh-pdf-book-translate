"""生成原版/译文并排对照 PDF。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pymupdf as fitz


def _display_size(page: fitz.Page) -> tuple[float, float]:
    width, height = page.rect.width, page.rect.height
    if int(page.rotation or 0) % 180 == 90:
        width, height = height, width
    return width, height


def _label_font(page: fitz.Page, text: str) -> str:
    """Base-14 fonts cannot draw CJK; prefer a system CJK font when available."""
    if not any(ord(char) > 127 for char in text):
        return "hebo"
    for path, name in (
        ("C:/Windows/Fonts/msyh.ttc", "msyh"),
        ("/System/Library/Fonts/PingFang.ttc", "pingfang"),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "notocjk"),
    ):
        if Path(path).is_file():
            try:
                page.insert_font(fontname=name, fontfile=path)
                return name
            except Exception:
                continue
    return "china-s"


def build_comparison(payload: dict[str, Any]) -> dict[str, Any]:
    original_path = payload["inputPath"]
    translated_path = payload["translatedPath"]
    output_path = payload["outputPath"]
    original_label = str(payload.get("originalLabel", "Original"))
    translated_label = str(payload.get("translatedLabel", "Translation"))

    original = fitz.open(original_path)
    translated = fitz.open(translated_path)
    out = fitz.open()
    margin = 18.0
    gap = 22.0
    label_h = 24.0
    try:
        count = max(original.page_count, translated.page_count)
        for index in range(count):
            left_page = original[index] if index < original.page_count else None
            right_page = translated[index] if index < translated.page_count else None
            if left_page is None and right_page is None:
                continue
            left_w, left_h = _display_size(left_page) if left_page is not None else (0.0, 0.0)
            right_w, right_h = _display_size(right_page) if right_page is not None else (0.0, 0.0)
            page_w = max(left_w + right_w + gap + 2 * margin, 300.0)
            page_h = max(left_h, right_h, 120.0) + label_h + 2 * margin
            page = out.new_page(width=page_w, height=page_h)
            page.draw_rect(page.rect, color=None, fill=(1, 1, 1))

            top = margin + label_h
            label_y = margin + 9
            original_text = f"{original_label}  ·  p.{index + 1}"
            translated_text = f"{translated_label}  ·  p.{index + 1}"
            page.insert_text((margin, label_y), original_text,
                             fontname=_label_font(page, original_text), fontsize=9, color=(0.35, 0.35, 0.35))
            right_x = margin + left_w + gap
            page.insert_text((right_x, label_y), translated_text,
                             fontname=_label_font(page, translated_text), fontsize=9, color=(0.1, 0.35, 0.65))
            page.draw_line((margin, top - 6), (page_w - margin, top - 6),
                           color=(0.82, 0.82, 0.82), width=0.5)

            if left_page is not None:
                left_rect = fitz.Rect(margin, top, margin + left_w, top + left_h)
                page.show_pdf_page(left_rect, original, index, keep_proportion=True)
            else:
                page.insert_text((margin, top + 20), "(missing original page)", fontname="helv",
                                 fontsize=9, color=(0.5, 0.5, 0.5))

            if right_page is not None:
                right_rect = fitz.Rect(right_x, top, right_x + right_w, top + right_h)
                page.show_pdf_page(right_rect, translated, index, keep_proportion=True)
            else:
                page.insert_text((right_x, top + 20), "(missing translated page)", fontname="helv",
                                 fontsize=9, color=(0.5, 0.5, 0.5))

            page.draw_rect(fitz.Rect(margin, top, margin + left_w, top + left_h),
                           color=(0.86, 0.86, 0.86), width=0.4)
            page.draw_rect(fitz.Rect(right_x, top, right_x + right_w, top + right_h),
                           color=(0.86, 0.86, 0.86), width=0.4)
        out.set_metadata({**original.metadata, "title": f"{original.metadata.get('title') or 'PDF'} · bilingual"})
        out.save(output_path, incremental=False, garbage=3, deflate=True)
        return {
            "outputPath": output_path,
            "pages": out.page_count,
            "originalPages": original.page_count,
            "translatedPages": translated.page_count,
        }
    finally:
        out.close()
        translated.close()
        original.close()
