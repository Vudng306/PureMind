"""The letters of Word's equations, read back where the PDF gives them wrong.

Word sets equations in Cambria Math. A subscript or superscript is drawn with the letter's script-size
form (the font's `ssty` variant), a tall bracket or a big operator with one of its size variants; none of
these has a character of its own, and Word writes the glyph's number in the font in its place. So M₀
comes out of the PDF as "M" + U+0B34 and ρd,0 as "ρ" + U+0B62 "," U+0B34: code points of Oriya, Tamil,
Telugu… that a reader shows as boxes. The number of each such glyph tells which letter it is a form of.

The table below was made from Cambria Math 6.99 (cambria.ttc in Windows) with fontTools: each glyph that
is an `ssty` form, or a size variant in the MATH table, taken back to the character of its base glyph;
numbers under U+0900 (where real letters of the font live) and combining bars were left out. It is used
only in a font that also sets math letters (𝑀, 𝜌), so text in those scripts is never changed.
"""

import statistics
import unicodedata

# (first code point, the characters it and the following code points stand for)
_RUNS = [
    (0x0B34, "0123456789+−="),
    (0x0B43, "⊤⊥ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψω∂ϵϑϰϕϱϖ†"),
    (0x0BB4, "<>∞≠≤≥𝐴𝐵𝐶𝐷𝐸𝐹𝐺𝐻𝐼𝐽𝐾𝐿𝑀𝑁𝑂𝑃𝑄𝑅𝑆𝑇𝑈𝑉𝑊𝑋𝑌𝑍𝑎𝑏𝑐𝑑𝑒𝑓𝑔ℎ𝑖𝑗𝑘𝑙𝑚𝑛𝑜𝑝𝑞𝑟𝑠𝑡𝑢𝑣𝑤𝑥𝑦𝑧𝛢𝛣𝛤𝛥𝛦𝛧𝛨𝛩𝛪𝛫𝛬𝛭𝛮𝛯𝛰𝛱𝛳𝛲𝛴𝛵𝛶𝛷𝛸𝛹𝛺𝛻𝛼𝛽𝛾𝛿𝜀𝜁𝜂𝜃𝜄𝜅𝜆𝜇𝜈𝜉𝜊𝜋𝜌𝜎𝜍𝜏𝜐𝜑𝜒𝜓𝜔𝜕𝜖𝜗𝜘𝜙𝜚𝜛ıȷ𝚤𝚥0123456789+−="),
    (0x0C3B, "⊤⊥ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψω∂ϵϑϰϕϱϖ†"),
    (0x0CAC, "<>∞≠≤≥𝐴𝐵𝐶𝐷𝐸𝐹𝐺𝐻𝐼𝐽𝐾𝐿𝑀𝑁𝑂𝑃𝑄𝑅𝑆𝑇𝑈𝑉𝑊𝑋𝑌𝑍𝑎𝑏𝑐𝑑𝑒𝑓𝑔ℎ𝑖𝑗𝑘𝑙𝑚𝑛𝑜𝑝𝑞𝑟𝑠𝑡𝑢𝑣𝑤𝑥𝑦𝑧𝛢𝛣𝛤𝛥𝛦𝛧𝛨𝛩𝛪𝛫𝛬𝛭𝛮𝛯𝛰𝛱𝛲𝛳𝛴𝛵𝛶𝛷𝛸𝛹𝛺𝛻𝛼𝛽𝛾𝛿𝜀𝜁𝜂𝜃𝜄𝜅𝜆𝜇𝜈𝜉𝜊𝜋𝜌𝜎𝜍𝜏𝜐𝜑𝜒𝜓𝜔𝜕𝜖𝜗𝜘𝜙𝜚𝜛ıȷ𝚤𝚥"),
    (0x0D57, "⁄⁄⁄⁄{{{{}}}}[[[[]]]](((())))⟦⟦⟦⟦⟧⟧⟧⟧⟨⟨⟨⟨⟩⟩⟩⟩⌈⌈⌈⌈⌉⌉⌉⌉⌊⌊⌊⌊⌋⌋⌋⌋"),
    (0x0D94, "⁅⁅⁅⁅"),
    (0x0D99, "⁆⁆⁆⁆"),
    (0x0DA5, "√"),
    (0x0DA7, "√√√√"),
    (0x0DB0, "∫∫∫∫∬∬∬∭∭∭∮∮∮∯∯∯∰∰∰∱∱∱∲∲∲∳∳∳∑∑∑∑∏∏∏∏"),
    (0x0DFD, "⏜⏜⏜⏜"),
    (0x0E02, "⏝⏝⏝⏝⎴⎴⎴⎴⎵⎵⎵⎵"),
    (0x0E0F, "⏞⏞⏞⏞"),
    (0x0E14, "⏟⏟⏟⏟"),
    (0x0E19, "⏠⏠⏠⏠⟪⟪⟪⟫⟫⟫"),
    (0x0E24, "⧼⧼⧼"),
    (0x0E28, "⧽⧽⧽|||‖‖‖"),
    (0x0EC1, "⨀⨀⨁⨁⨂⨂⨃⨃⨄⨄"),
    (0x0ECC, "⨅⨆"),
    (0x0ECF, "⨇"),
    (0x0ED1, "⨈⨉"),
    (0x11D8, "⨅⨆⨇⨈⨉"),
    (0x11F1, "′′″″‴‴⁗⁗"),
    (0x1220, "∐∐∐∐⋀⋀⋁⋁⋂⋂⋃⋃"),
    (0x1240, "()[]{}()[]{}()[]{}⌈⌉⌊⌋⁅⁆⟦⟧|‖⌈⌉⌊⌋⁅⁆⟦⟧|‖⌈⌉⌊⌋⁅⁆⟦⟧|‖|‖"),
]  # fmt: skip
GLYPHS = {chr(start + i): ch for start, chars in _RUNS for i, ch in enumerate(chars)}

SUBSCRIPTS = str.maketrans("0123456789+-−=()aehijklmnoprstuvxβγρφχ", "₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ")
SUPERSCRIPTS = str.maketrans("0123456789+-−=()ni", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁿⁱ")
SCRIPT_SIZE = 0.85  # of the line's type: smaller is a subscript or a superscript


def _math_letter(ch: str) -> bool:
    return 0x1D400 <= ord(ch) <= 0x1D7FF


def _plain(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", c) if _math_letter(c) else c for c in text)


def _letters(text: str) -> str:
    return "".join(GLYPHS.get(c, c) for c in text)


def _has_glyphs(spans: list[dict]) -> bool:
    return any(c in GLYPHS for s in spans for c in s["text"])


def _scriptable(text: str, table: dict) -> bool:
    """Whether every character of the run has a sub- or superscript form (0, n, ρ do; d, S, L do not)."""
    plain = _plain(text)
    return all(c.isspace() or c != o for c, o in zip(plain, plain.translate(table), strict=True))


def repair(blocks: list[dict]) -> list[tuple[str, str]]:
    """Put the letters back in the spans of the page's math fonts (in place, in PyMuPDF's "dict" blocks), a
    subscript as ₀ where Unicode has the character, as the plain letters otherwise ("ρd,0", "wSL").

    Returns each (text as the PDF gives it, text as repaired) of the page, for the text read around the
    spans (find_tables)."""
    spans = [s for b in blocks for line in b.get("lines", []) for s in line["spans"]]
    fonts = {
        s["font"] for s in spans if any(_math_letter(c) for c in s["text"]) or "math" in s["font"].lower()
    }
    if not fonts or not any(c in GLYPHS for s in spans if s["font"] in fonts for c in s["text"]):
        return []
    fixes: list[tuple[str, str]] = []
    for block in blocks:
        for line in block.get("lines", []):
            written = [s for s in line["spans"] if s["text"].strip()]
            if not written:
                continue
            size = max(s["size"] for s in written)
            baseline = statistics.median(s["origin"][1] for s in written if s["size"] >= size * SCRIPT_SIZE)
            # A subscript is often several spans ("d", ",", "0"): each run of small math spans is one.
            runs: list[list[dict]] = [[]]
            for span in line["spans"]:
                if span["font"] in fonts and span["size"] < size * SCRIPT_SIZE:
                    runs[-1].append(span)
                    continue
                runs.append([])
                if span["font"] in fonts and _has_glyphs([span]):  # a tall bracket, a big operator
                    before, span["text"] = span["text"], _letters(span["text"])
                    fixes.append((before, span["text"]))
            for run in runs:
                if not _has_glyphs(run):
                    continue
                before = "".join(s["text"] for s in run)
                table = SUPERSCRIPTS if run[0]["origin"][1] < baseline - size * 0.15 else SUBSCRIPTS
                script = _scriptable(_letters(before), table)
                after = _plain(_letters(before)).translate(table) if script else _letters(before)
                # One span, so that the gaps between its pieces are not read as spaces ("ρd ,0").
                first, last = run[0], run[-1]
                first["text"] = after
                first["bbox"] = (*first["bbox"][:2], last["bbox"][2], max(s["bbox"][3] for s in run))
                for s in run[1:]:
                    s["text"] = ""
                fixes.append((before, after))
    return fixes
