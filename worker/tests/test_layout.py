import pymupdf as fitz

from worker import rebuild


def test_wrap_paragraph_respects_width_and_keeps_code_newlines():
    text = "A deliberately long translated sentence that has to wrap across the column edge."
    lines = rebuild._wrap_paragraph(text, "helv", None, 12, 180)
    assert len(lines) > 1
    assert all(rebuild._text_width(line, "helv", None, 12) <= 180.5 for line in lines)
    assert " ".join(lines).replace("  ", " ") == text

    code = "def f():\n    return 1\n# done"
    assert rebuild._wrap_paragraph(code, "cour", None, 12, 400) == code.split("\n")


def test_rebuild_reflows_paragraph_instead_of_mapping_source_lines(tmp_path):
    doc = fitz.open()
    page = doc.new_page()
    for i, line in enumerate(["first visual line", "second visual line", "third visual line"]):
        page.insert_text((72, 100 + i * 14), line, fontsize=12, fontname="helv")
    src = tmp_path / "reflow.pdf"
    doc.save(src)
    doc.close()

    translation = (
        "这是一段完整的中文译文，它应当作为一个连续段落按照栏宽重新折行，"
        "而不是对应原文的三条视觉行逐条替换。增加一些字数，让排版引擎必须真正重排。"
    )
    out = tmp_path / "reflow_out.pdf"
    rebuild.rebuild_document(
        {"inputPath": str(src), "outputPath": str(out),
         "pages": [{"index": 0, "paragraphs": [{"id": 0, "text": translation}]}]}
    )
    doc = fitz.open(out)
    text = doc[0].get_text("text")
    lines = [line for line in text.splitlines() if line.strip()]
    doc.close()
    assert translation in text.replace("\n", "")
    assert len(lines) > 3
    assert "first visual line" not in text


def test_rebuild_preserves_vector_art_as_paths(tmp_path):
    doc = fitz.open()
    page = doc.new_page()
    # A vector fill directly under the text: redaction must not erase it.
    background = page.new_shape()
    background.draw_rect(fitz.Rect(64, 86, 300, 116))
    background.finish(color=None, fill=(0.94, 0.94, 0.78), width=0)
    background.commit()
    page.insert_text((72, 100), "text beside a vector figure", fontsize=12, fontname="helv")
    shape = page.new_shape()
    shape.draw_rect(fitz.Rect(300, 70, 420, 150))
    shape.finish(color=(0.1, 0.3, 0.7), fill=(0.85, 0.92, 1.0), width=1.2)
    shape.draw_circle(fitz.Point(360, 110), 24)
    shape.finish(color=(0.8, 0.15, 0.1), fill=None, width=2.0)
    shape.commit()
    src = tmp_path / "vector.pdf"
    doc.save(src)
    doc.close()

    before = fitz.open(src)
    before_drawings = before[0].get_drawings()
    before.close()

    out = tmp_path / "vector_out.pdf"
    rebuild.rebuild_document(
        {"inputPath": str(src), "outputPath": str(out),
         "pages": [{"index": 0, "paragraphs": [{"id": 0, "text": "图形旁边的译文"}]}]}
    )
    doc = fitz.open(out)
    after_drawings = doc[0].get_drawings()
    doc.close()
    # Vector art must stay native PDF paths (not rasterized and not dropped by
    # text redaction). The background fill, rectangle and stroked circle survive.
    assert len(after_drawings) == len(before_drawings) == 3
    assert {round(d["rect"].width, 1) for d in after_drawings} == {
        round(d["rect"].width, 1) for d in before_drawings
    }


def test_rebuild_does_not_flow_text_through_vector_figure(tmp_path):
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 110), "Original paragraph.", fontsize=12, fontname="helv")
    figure = page.new_shape()
    figure.draw_rect(fitz.Rect(72, 180, 500, 280))
    figure.finish(color=(0.2, 0.4, 0.8), fill=(0.86, 0.92, 1.0), width=1.5)
    figure.commit()
    src = tmp_path / "vector_below.pdf"
    doc.save(src)
    doc.close()

    translation = (
        "这是一段会增加行数的译文，用来验证文字向下生长时不会盖住下方的矢量图，"
        "同时保持段落连续排版和可读性。"
    )
    out = tmp_path / "vector_below_out.pdf"
    rebuild.rebuild_document(
        {"inputPath": str(src), "outputPath": str(out),
         "pages": [{"index": 0, "paragraphs": [{"id": 0, "text": translation}]}]}
    )
    doc = fitz.open(out)
    text_spans = [
        span["bbox"]
        for block in doc[0].get_text("dict")["blocks"]
        for line in block.get("lines", [])
        for span in line.get("spans", [])
        if span["text"].strip()
    ]
    drawings = doc[0].get_drawings()
    doc.close()
    assert drawings, "vector figure should still be present"
    figure_rect = fitz.Rect(72, 180, 500, 280)
    assert all(not fitz.Rect(bbox).intersects(figure_rect) for bbox in text_spans)

