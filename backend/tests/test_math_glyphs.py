from app.services.math_glyphs import GLYPHS, repair

MATH, TEXT = "CIDFont+F6", "CIDFont+F1"


def span(text, font=TEXT, size=10.0, y=100.0, x0=0.0, x1=10.0):
    return {
        "text": text,
        "font": font,
        "size": size,
        "origin": (x0, y),
        "bbox": (x0, y - size, x1, y),
        "flags": 4,
    }


def block(*spans):
    return {"type": 0, "lines": [{"spans": list(spans)}]}


def texts(blocks):
    return ["".join(s["text"] for s in line["spans"]) for b in blocks for line in b["lines"]]


def test_word_subscripts_get_their_letters_back():
    # As Word writes them: the script-size glyph's number in Cambria Math instead of the letter.
    assert GLYPHS["଴"] == "0" and GLYPHS["ୢ"] == "d" and GLYPHS["ௌ"] == "𝑆"
    blocks = [
        block(span("initial mass ("), span("𝑀", MATH), span("଴", MATH, 7, 102), span(") and")),
        # ρd,0 is three spans, the comma a little lower: one subscript, with no letter Unicode has as one.
        block(
            span("𝜌", MATH, 9, 244.1, 0, 5),
            span("ୢ", MATH, 6.5, 244.1, 5, 8),
            span(",", MATH, 6.5, 245.9, 9, 10),
            span("଴", MATH, 6.5, 245.9, 10, 13),
            span(" (kg/m", TEXT, 9, 244.1, 13, 30),
        ),
        block(span("𝑒", MATH), span("୫୧୬", MATH, 6.5, 102)),  # e_min
        block(span("𝑤", MATH), span("ௌ௅", MATH, 6.5, 102)),  # w_SL
        block(span("𝑥", MATH), span("ଶ", MATH, 7, 96)),  # raised: x²
        block(span("𝑀", MATH), span("ൗ", MATH)),  # a tall fraction slash, full size
    ]
    fixes = repair(blocks)
    assert texts(blocks) == ["initial mass (𝑀₀) and", "𝜌d,0 (kg/m", "𝑒ₘᵢₙ", "𝑤𝑆𝐿", "𝑥²", "𝑀⁄"]
    # The run is one span now, as wide as its pieces, so no space is read into it.
    rho = blocks[1]["lines"][0]["spans"]
    assert rho[1]["bbox"][2] == 13 and rho[2]["text"] == rho[3]["text"] == ""
    # For the text read again around the spans (a table's cells).
    assert ("ୢ,଴", "d,0") in fixes and ("଴", "₀") in fixes


def test_real_text_in_those_scripts_is_left_alone():
    tamil = "வணக்கம்"  # வணக்கம், with a Tamil vowel sign also in the table
    blocks = [block(span(tamil, "Latha"), span("ௌ", "Latha", 7, 102))]
    assert repair(blocks) == [] and texts(blocks) == [tamil + "ௌ"]
    # A math font with nothing to repair is left as it is.
    blocks = [block(span("𝑀", MATH), span("2", MATH, 7, 102)), {"type": 1}]
    assert repair(blocks) == [] and texts([blocks[0]]) == ["𝑀2"]
