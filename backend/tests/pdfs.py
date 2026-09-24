import io
import itertools
import math

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


def png(width: int, height: int, color: tuple[int, int, int]) -> bytes:
    """A picture with enough detail to count as a figure: a grid of lines on a colour."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (width, height), color)
    draw = ImageDraw.Draw(img)
    for x in range(0, width, 12):
        draw.line((x, 0, x, height), fill=(255, 255, 255), width=2)
    for y in range(0, height, 12):
        draw.line((0, y, width, y), fill=(255, 255, 255), width=2)
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def gradient_png(width: int, height: int) -> bytes:
    from PIL import Image

    img = Image.linear_gradient("L").resize((width, height)).convert("RGB")
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def image_pdf(pages: int = 3) -> bytes:
    """Text on every page; on page 1 a figure, a small icon and a decorative gradient; a logo on every page."""
    doc = pymupdf.open()
    figure, icon, logo = png(400, 300, (30, 90, 160)), png(20, 20, (200, 0, 0)), png(120, 60, (0, 120, 0))
    for i in range(pages):
        page = doc.new_page()
        page.insert_image(pymupdf.Rect(450, 20, 570, 80), stream=logo)
        page.insert_text((72, 110), f"Chapter {i + 1}", fontsize=24)
        page.insert_text((72, 150), f"Text before the figure, page {i + 1}.", fontsize=11)
        if i == 0:
            page.insert_image(pymupdf.Rect(72, 170, 472, 470), stream=figure)
            page.insert_image(pymupdf.Rect(72, 480, 92, 500), stream=icon)
            page.insert_image(pymupdf.Rect(0, 0, 595, 15), stream=gradient_png(600, 120))
        page.insert_text((72, 540), f"Text after the figure, page {i + 1}.", fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


def scanned_pdf() -> bytes:
    """A page that is nothing but a picture of text."""
    doc = pymupdf.open()
    doc.new_page().insert_image(pymupdf.Rect(0, 0, 595, 842), stream=png(600, 800, (240, 240, 240)))
    data = doc.tobytes()
    doc.close()
    return data


def mixed_scan_pdf() -> bytes:
    """A page of text, then two scanned pages (pictures of the page, a little stray text on the first)."""
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 80), "Typed first page of the report.", fontsize=11)
    for shade in (240, 250):
        page = doc.new_page()
        page.insert_image(pymupdf.Rect(0, 0, 595, 842), stream=png(600, 800, (shade, shade, shade)))
        if shade == 240:
            page.insert_text((20, 830), "p. 2", fontsize=6)  # a scanner's stamp: not a text layer
    data = doc.tobytes()
    doc.close()
    return data


def paper_pdf(pages: int = 3) -> bytes:
    """A two-column article: a running header and a page number on every page, a numbered section heading,
    body text in both columns, a footnote under the left column and a table stored as two masked strips."""
    from PIL import Image

    def strip(height: int) -> tuple[bytes, bytes]:
        # A flat base drawn through a mask that carries the picture, as some PDF writers store tables.
        base, mask = io.BytesIO(), io.BytesIO()
        Image.new("RGB", (300, height), (0, 0, 0)).save(base, "PNG")
        Image.open(io.BytesIO(png(300, height, (0, 0, 0)))).convert("L").save(mask, "PNG")
        return base.getvalue(), mask.getvalue()

    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page()  # 595 x 842
        page.insert_text((57, 40), f"Journal of Tests {i + 7}, 2024", fontsize=9)
        page.insert_text((290, 815), f"{i + 1}", fontsize=9)
        if i == 0:
            page.insert_text((57, 100), "A study of reading order", fontsize=20)
            page.insert_text((57, 150), "1 Introduction", fontsize=12, fontname="hebo")
            # A stamp up the left margin, as arXiv prints: far left, so it also skews the page's extent.
            page.insert_text((25, 500), "arXiv:2401.00001v1 [cs.AI] 1 Jan 2024", fontsize=20, rotate=90)
        page.insert_textbox(
            pymupdf.Rect(57, 170, 287, 400), f"Left column opens page {i + 1}. " * 6, fontsize=10
        )
        page.insert_textbox(
            pymupdf.Rect(309, 170, 539, 400), f"Right column follows on page {i + 1}. " * 6, fontsize=10
        )
        if i == 0:
            page.insert_text((57, 745), "* These authors contributed equally.", fontsize=8)
            page.insert_text((57, 770), "* Corresponding author: someone@example.com", fontsize=8)
            page.insert_text(
                (57, 795), "1Test University. Correspondence to: A. Author <a@example.org>.", fontsize=8
            )
            for top, height in ((420, 60), (480, 40)):  # edge to edge
                base, mask = strip(height * 3)
                page.insert_image(pymupdf.Rect(309, top, 539, top + height), stream=base, mask=mask)
    data = doc.tobytes()
    doc.close()
    return data


def ruled_table_pdf() -> bytes:
    """Two tables in the style of papers: a caption and horizontal rules only, no vertical ones."""
    doc = pymupdf.open()
    page = doc.new_page()
    x0, x1 = 72, 472
    page.insert_text((x0, 90), "Table 1. Properties of the soil.", fontsize=9)
    for y in (100, 125, 145):
        page.draw_line((x0, y), (x1, y), width=0.5)
    for x, head, value in (
        (x0 + 5, "Liquid limit [%]", "96"),
        (x0 + 150, "Plastic limit [%]", "59"),
        (x0 + 300, "Density", "2.886"),
    ):
        page.insert_text((x, 116), head, fontsize=9)
        page.insert_text((x, 138), value, fontsize=9)

    page.insert_text((x0, 200), "Table 2. Test program.", fontsize=9)
    ys = (210, 250, 280)
    for y in ys:
        page.draw_line((x0, y), (x1, y), width=0.5)
    page.insert_text((x0 + 5, 224), "Case 1", fontsize=9)
    page.insert_text((x0 + 80, 224), "1. Consolidation (32 kPa to 1612 kPa)", fontsize=9)
    page.insert_text((x0 + 80, 236), "2. Swelling (1612 kPa to 32 kPa)", fontsize=9)
    page.insert_text((x0 + 5, 266), "Case 2", fontsize=9)
    page.insert_text((x0 + 80, 266), "1. Osmotic consolidation", fontsize=9)
    page.insert_text(
        (x0, 330), "Body text below the tables, long enough to read as a paragraph of the paper.", fontsize=9
    )
    page.insert_text((x0, 780), "© The Authors. Open access article under Creative Commons.", fontsize=7)
    data = doc.tobytes()
    doc.close()
    return data


def chart_pdf() -> bytes:
    """A line chart drawn as vector paths (axes, ticks, a curve) with its labels and a caption, a boxed grid
    with numbers on it, and a real table with column rules."""
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 80), "Results are shown below as a chart of the water content.", fontsize=10)
    x0, y0, x1, y1 = 100, 110, 400, 300
    page.draw_line((x0, y1), (x1, y1))
    page.draw_line((x0, y0), (x0, y1))
    for i in range(6):
        x = x0 + i * 60
        page.draw_line((x, y1), (x, y1 + 4))
        page.insert_text((x - 4, y1 + 14), f"{i * 20}", fontsize=7)
    points = [pymupdf.Point(x0 + i * 10, y1 - 150 * (i / 30) ** 0.5) for i in range(31)]
    for a, b in itertools.pairwise(points):
        page.draw_line(a, b)
    page.insert_text((230, y1 + 26), "Suction (kPa)", fontsize=7)
    page.insert_text((x0 - 14, 240), "Water content", fontsize=7, rotate=90)
    page.insert_text((72, 345), "Fig. 1. Water retention curve.", fontsize=9)
    page.insert_text(
        (72, 380), "Text after the figure, long enough to read as a line of the paper.", fontsize=10
    )

    tx, ty = 72, 420
    for i in range(3):
        page.draw_line((tx, ty + i * 20), (tx + 300, ty + i * 20))
    for j in range(3):
        page.draw_line((tx + j * 150, ty), (tx + j * 150, ty + 40))
    for i, row in enumerate([["Soil", "Density"], ["Clay <5 µm", "2.7"]]):
        for j, cell in enumerate(row):
            page.insert_text((tx + j * 150 + 5, ty + i * 20 + 14), cell, fontsize=10)
    data = doc.tobytes()
    doc.close()
    return data


def booktabs_table_pdf() -> bytes:
    """A table in booktabs style: rules over and under the header and one under the body, no rules between
    the rows (cells of several lines, a little more space between rows than between lines), the caption
    under the table, and a body taller than most rows are."""
    doc = pymupdf.open()
    page = doc.new_page()
    x0, x1 = 60, 540
    page.draw_line((x0, 60), (x1, 60), width=0.8)
    for x, head in ((x0 + 5, "Definition"), (x0 + 220, "Failure"), (x0 + 290, "Explanation")):
        page.insert_text((x, 74), head, fontsize=9)
    page.draw_line((x0, 82), (x1, 82), width=0.5)
    y = 94
    for n in range(12):
        page.insert_text((x0 + 5, y), f"Definition {n + 1} of general", fontsize=9)
        page.insert_text((x0 + 5, y + 10), f"intelligence, source {n + 1}.", fontsize=9)
        page.insert_text((x0 + 220, y), "Not Feasible", fontsize=9)
        page.insert_text((x0 + 290, y), f"Why definition {n + 1} fails,", fontsize=9)
        page.insert_text((x0 + 290, y + 10), "in two lines of text.", fontsize=9)
        y += 23
    page.draw_line((x0, y - 8), (x1, y - 8), width=0.8)
    page.insert_text((x0 + 20, y + 4), "Table 1. The failure of most definitions.", fontsize=9)
    page.insert_text(
        (x0, y + 40), "Body text under the table, long enough to read as a paragraph.", fontsize=10
    )
    data = doc.tobytes()
    doc.close()
    return data


def overhanging_chart_pdf() -> bytes:
    """A two-column page whose chart, under both columns, has paths drawn past the page's right edge."""
    doc = pymupdf.open()
    page = doc.new_page()  # 595 x 842
    page.insert_textbox(pymupdf.Rect(57, 70, 287, 300), "Left column text comes first. " * 14, fontsize=10)
    page.insert_textbox(pymupdf.Rect(309, 70, 539, 300), "Right column text comes next. " * 14, fontsize=10)
    x0, y0, x1, y1 = 80, 340, 700, 560  # the curve runs on past x = 595
    page.draw_line((x0, y1), (x1, y1))
    page.draw_line((x0, y0), (x0, y1))
    points = [pymupdf.Point(x0 + i * 20, y1 - 200 * (i / 31) ** 0.5) for i in range(32)]
    for a, b in itertools.pairwise(points):
        page.draw_line(a, b)
    page.insert_text((57, 590), "Fig. 1. A curve wider than the page.", fontsize=9)
    data = doc.tobytes()
    doc.close()
    return data


def image_table_pdf() -> bytes:
    """A table stored as a picture under its caption, and a figure that is not a table."""
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 80), "Table 3. Parameters used in the simulation.", fontsize=9)
    page.insert_image(pymupdf.Rect(72, 90, 372, 240), stream=png(300, 150, (40, 40, 40)))
    page.insert_text(
        (72, 280), "Text between the table and the figure, long enough to be a paragraph.", fontsize=10
    )
    page.insert_image(pymupdf.Rect(72, 300, 372, 450), stream=png(300, 150, (0, 90, 160)))
    page.insert_text((72, 470), "Fig. 2. A figure, not a table.", fontsize=9)
    data = doc.tobytes()
    doc.close()
    return data


def equation_pdf() -> bytes:
    """Two numbered display equations, a reference with a year in brackets, and running text with a number
    at the end of its column that is not an equation."""
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 100), "The phase relationships of the sample are the following ones:", fontsize=10)
    page.insert_text((150, 140), "w = M/Ms - 1", fontsize=10)
    page.insert_text((500, 140), "(1)", fontsize=9)
    page.insert_text((150, 175), "e = Gs x pw / (Ms/V) - 1", fontsize=10)
    page.insert_text((500, 175), "(2)", fontsize=9)
    page.insert_text((72, 215), "where the total mass of the sample is weighed before drying.", fontsize=10)
    page.insert_text((72, 250), "these results were measured over several long days", fontsize=10)
    page.insert_text((500, 250), "(3)", fontsize=9)
    page.insert_text((72, 285), "Smith, Soil mechanics", fontsize=10)
    page.insert_text((500, 285), "(2013)", fontsize=9)
    data = doc.tobytes()
    doc.close()
    return data


def _axis_labels(page, labels: list[tuple[str, float]], *, x: float | None = None, y: float | None = None):
    """Tick labels with their tick marks: under an x axis at height y (centred), or left of a y axis at x
    (right-aligned, as plotting programs set them)."""
    for text, pos in labels:
        width = pymupdf.get_text_length(text, fontsize=7)
        if y is not None:
            page.draw_line((pos, y), (pos, y + 3))
            page.insert_text((pos - width / 2, y + 10), text, fontsize=7)
        else:
            page.draw_line((x - 3, pos), (x, pos))
            page.insert_text((x - 5 - width, pos + 2.5), text, fontsize=7)


# The values data_chart_pdf plots: (a) markers and a line on linear axes, (b) "+" markers on a log x axis.
CHART_MARKERS = [(10, 5), (30, 15), (50, 22), (70, 35), (90, 45)]
CHART_LINE = [(x, 40 - 0.3 * x) for x in range(0, 101, 10)]
CHART_LOG = [(0.03, 0.1), (0.3, 0.35), (3, 0.6), (30, 0.9)]


def data_chart_pdf() -> bytes:
    """Two chart panels drawn as vector paths side by side under one caption: (a) red dots and a blue line
    named in a legend, over a faint grey copy of another curve; (b) black "+" markers on a log x axis."""
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 80), "The measured heights are plotted below for both cases.", fontsize=10)
    bottom = 300

    # (a) x 0..100 over 100..280, y 0..50 over 300..200
    ax, ay = (lambda v: 100 + v * 1.8), (lambda v: bottom - v * 2)
    page.draw_line((100, bottom), (290, bottom))
    page.draw_line((100, 190), (100, bottom))
    _axis_labels(page, [(str(v), ax(v)) for v in range(0, 101, 20)], y=bottom)
    _axis_labels(page, [(str(v), ay(v)) for v in range(0, 51, 10)], x=100)
    page.draw_polyline(
        [(ax(x), ay(45 - x / 4)) for x in range(0, 101, 10)], color=(0.5, 0.5, 0.5), stroke_opacity=0.3
    )
    page.draw_polyline([(ax(x), ay(y)) for x, y in CHART_LINE], color=(0, 0, 1))
    for x, y in CHART_MARKERS:
        page.draw_circle((ax(x), ay(y)), 2, color=None, fill=(1, 0, 0))
    page.draw_circle((115, 207), 2, color=None, fill=(1, 0, 0))
    page.insert_text((122, 209.5), "Case 1", fontsize=7)
    page.draw_line((108, 217), (118, 217), color=(0, 0, 1))
    page.insert_text((122, 219.5), "Case 2", fontsize=7)
    page.insert_text((165, bottom + 22), "Distance (m)", fontsize=7)
    page.insert_text((82, 275), "Height (m)", fontsize=7, rotate=90)
    page.insert_text((170, bottom + 36), "(a) Linear", fontsize=7)

    # (b) x 0.01..100 (log) over 360..520, y 0..1 over 300..200
    bx, by = (lambda v: 360 + 40 * (math.log10(v) + 2)), (lambda v: bottom - v * 100)
    page.draw_line((360, bottom), (530, bottom))
    page.draw_line((360, 190), (360, bottom))
    _axis_labels(
        page, [(t, bx(float(t))) for t in ("0.01", "0.1", "1", "10", "100")], y=bottom - 0.5
    )  # a shade higher than (a)'s
    _axis_labels(page, [(f"{v / 5:.1f}", by(v / 5)) for v in range(6)], x=360)
    for x, y in CHART_LOG:
        px, py = bx(x), by(y)
        page.draw_line((px - 2, py), (px + 2, py))
        page.draw_line((px, py - 2), (px, py + 2))
    page.insert_text((420, bottom + 22), "Time (s)", fontsize=7)
    page.insert_text((425, bottom + 36), "(b) Log", fontsize=7)

    caption = "Fig. 2. Heights of the two cases: (a) against distance, on linear axes; (b) against time, on a log axis."
    page.insert_text((72, 365), caption, fontsize=9)
    page.insert_text(
        (72, 400), "Text after the figure, long enough to read as a line of the paper.", fontsize=10
    )
    data = doc.tobytes()
    doc.close()
    return data
