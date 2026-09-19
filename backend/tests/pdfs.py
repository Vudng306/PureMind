import pymupdf


def text_pdf(pages: int = 2, title: str = "") -> bytes:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page()
        page.insert_text((72, 80), f"Chapter {i + 1}", fontsize=24)
        page.insert_text((72, 130), f"Machine learning is a field of study, page {i + 1}.", fontsize=11)
    if title:
        doc.set_metadata({"title": title})
    data = doc.tobytes()
    doc.close()
    return data


def image_only_pdf() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    page.draw_rect(pymupdf.Rect(50, 50, 200, 200), fill=(0.2, 0.2, 0.2))
    data = doc.tobytes()
    doc.close()
    return data


def encrypted_pdf() -> bytes:
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "secret")
    data = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="o", user_pw="u")
    doc.close()
    return data


def table_pdf() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    x0, y0 = 72, 100
    for i in range(4):
        page.draw_line((x0, y0 + i * 20), (x0 + 300, y0 + i * 20))
    for j in range(4):
        page.draw_line((x0 + j * 100, y0), (x0 + j * 100, y0 + 60))
    rows = [["Term", "Meaning", "Note"], ["ML", "Machine learning", "AI"], ["DL", "Deep learning", "NN"]]
    for i, row in enumerate(rows):
        for j, cell in enumerate(row):
            page.insert_text((x0 + j * 100 + 5, y0 + i * 20 + 14), cell, fontsize=10)
    page.insert_text((72, 300), "Body text below the table.", fontsize=10)
    data = doc.tobytes()
    doc.close()
    return data
