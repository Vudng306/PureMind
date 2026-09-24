"""The data of a chart drawn as vector paths, read from the drawing itself (no model, no guessing).

A chart in a PDF made by a plotting program keeps each data point as a coordinate on the page: a marker's
centre, a line's vertices. The numbers on its axes (the tick labels) fix how page coordinates map to values,
linearly or on a log scale, so the points can be given back as the numbers they were plotted from. A chart
stored as a picture has no such coordinates; it is only described (figure_notes), never estimated by eye.

`digitize` returns, for one figure:
    {"panels": [{"title": str, "x": {"title": str, "scale": "linear" | "log"}, "y": {...},
                 "series": [{"name": str, "color": "#rrggbb", "points": [[x, y], …]}, …]}, …]}
"""

import math
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field

import pymupdf

NUMBER = re.compile(r"^[−–-]?\d+(?:\.\d+)?$|^[−–-]?\d+,\d+$")
MIN_TICKS = 3
ROW = 2.0  # points: labels this close in height (x axis) or right edge (y axis) are one axis's ticks
TICK_SNAP = 3.0  # points from a label's centre to its tick mark
FIT = 0.006  # of the axis range: the most a tick may miss the fitted scale
MARKER = 7.0  # points: a drawing no larger than this is a marker, one data point
MERGE = 1.2  # points: marker pieces (the two strokes of a "+") closer than this are one marker
LEGEND_GAP = 30.0  # points between a legend's sample and its text
COLOR_SHADE = 24  # of 255 per channel: a legend sample's colour and its series' may differ by this much
MIN_OPACITY = 0.5  # fainter series are a backdrop (the other panel's curves, for comparison)
MAX_SERIES = 12
MAX_POINTS = 300  # per series
PANEL_TITLE = re.compile(r"^\(?[a-z]\)\s*\S")


@dataclass
class _Text:
    text: str
    box: pymupdf.Rect
    upright: bool  # horizontal; a y axis title is set rotated

    @property
    def cx(self) -> float:
        return (self.box.x0 + self.box.x1) / 2

    @property
    def cy(self) -> float:
        return (self.box.y0 + self.box.y1) / 2


@dataclass
class _Axis:
    ticks: list[_Text]
    positions: list[float]
    values: list[float]
    scale: str = "linear"
    a: float = 0.0  # value (or its log10) = a * position + b
    b: float = 0.0

    def value(self, pos: float) -> float:
        v = self.a * pos + self.b
        return 10**v if self.scale == "log" else v

    @property
    def span(self) -> tuple[float, float]:
        return min(self.positions), max(self.positions)


@dataclass
class _Series:
    color: str
    shape: str = ""
    points: list[tuple[float, float]] = field(default_factory=list)  # page coordinates


def _number(text: str) -> float:
    return float(text.replace("−", "-").replace("–", "-").replace(",", "."))


def _plain(text: str) -> str:
    """Math italic and bold letters (𝑤, 𝑆, 𝐞) as the letters they are, so a title reads (and searches) as
    text; other symbols (², ρ) are left as they are."""
    return "".join(unicodedata.normalize("NFKC", c) if 0x1D400 <= ord(c) <= 0x1D7FF else c for c in text)


def _texts(blocks: list[dict], region: pymupdf.Rect) -> list[_Text]:
    out, seen = [], set()
    for block in blocks:
        for line in block.get("lines", []):
            text = _plain(" ".join("".join(s["text"] for s in line["spans"]).split()))
            box = pymupdf.Rect(line["bbox"])
            # A panel laid over a faint copy of another chart has each label twice, in one place.
            key = (text, round(box.x0), round(box.y0))
            if text and box.intersects(region) and key not in seen:
                seen.add(key)
                out.append(_Text(text, box, abs(line["dir"][1]) < 0.1))
    return out


def _fit(axis: _Axis) -> bool:
    """Fit the axis's scale to its ticks, linear or else logarithmic; False if neither holds."""
    for scale in ("linear", "log"):
        if scale == "log" and min(axis.values) <= 0:
            return False
        vs = [math.log10(v) for v in axis.values] if scale == "log" else axis.values
        n, ps = len(vs), axis.positions
        mp, mv = sum(ps) / n, sum(vs) / n
        var = sum((p - mp) ** 2 for p in ps)
        if var == 0 or max(vs) == min(vs):
            return False
        a = sum((p - mp) * (v - mv) for p, v in zip(ps, vs, strict=True)) / var
        b = mv - a * mp
        if max(abs(a * p + b - v) for p, v in zip(ps, vs, strict=True)) <= FIT * (max(vs) - min(vs)):
            axis.scale, axis.a, axis.b = scale, a, b
            return True
    return False


def _runs(labels: list[_Text], key, pos) -> list[list[_Text]]:
    """Labels in one row (or column), split where their values stop rising (falling) steadily: two panels
    side by side (one over the other) share a row of tick labels."""
    rows: list[list[_Text]] = []
    for lab in sorted(labels, key=key):
        if rows and abs(key(rows[-1][-1]) - key(lab)) <= ROW:
            rows[-1].append(lab)
        else:
            rows.append([lab])
    runs = []
    for row in rows:
        row.sort(key=pos)
        run: list[_Text] = []
        for lab in row:
            if len(run) >= 2:
                rising = _number(run[1].text) > _number(run[0].text)
                step, gap = pos(run[1]) - pos(run[0]), pos(lab) - pos(run[-1])
                steady = (_number(lab.text) > _number(run[-1].text)) == rising
                if not steady or _number(lab.text) == _number(run[-1].text) or gap > step * 2.5 + 1:
                    runs.append(run)
                    run = []
            elif run and _number(lab.text) == _number(run[-1].text):
                runs.append(run)
                run = []
            run.append(lab)
        runs.append(run)
    return [r for r in runs if len(r) >= MIN_TICKS]


def _tick_marks(drawings: list[dict]) -> tuple[list[float], list[float]]:
    """x of the short vertical strokes (x ticks) and y of the short horizontal ones (y ticks)."""
    xs, ys = [], []
    for d in drawings:
        for item in d["items"]:
            if item[0] != "l":
                continue
            p, q = item[1], item[2]
            if abs(p.x - q.x) < 0.3 and 0 < abs(p.y - q.y) <= 6:
                xs.append(p.x)
            elif abs(p.y - q.y) < 0.3 and 0 < abs(p.x - q.x) <= 6:
                ys.append(p.y)
    return xs, ys


def _snap(pos: float, marks: list[float]) -> float:
    near = [m for m in marks if abs(m - pos) <= TICK_SNAP]
    return min(near, key=lambda m: abs(m - pos)) if near else pos


def _axes(texts: list[_Text], drawings: list[dict]) -> tuple[list[_Axis], list[_Axis]]:
    numbers = [t for t in texts if t.upright and NUMBER.match(t.text)]
    mark_x, mark_y = _tick_marks(drawings)
    xs, ys = [], []
    for run in _runs(numbers, key=lambda t: t.cy, pos=lambda t: t.cx):
        axis = _Axis(run, [_snap(t.cx, mark_x) for t in run], [_number(t.text) for t in run])
        if _fit(axis):
            xs.append(axis)
    for run in _runs(numbers, key=lambda t: t.box.x1, pos=lambda t: t.cy):
        axis = _Axis(run, [_snap(t.cy, mark_y) for t in run], [_number(t.text) for t in run])
        if _fit(axis):
            ys.append(axis)
    return xs, ys


def _color(rgb) -> str | None:
    if not rgb:
        return None
    return "#" + "".join(f"{round(max(0.0, min(1.0, c)) * 255):02x}" for c in rgb[:3])


def _touches(r: pymupdf.Rect, region: pymupdf.Rect) -> bool:
    """Whether a drawing's box meets the region; unlike Rect.intersects, true of a box of no width or height
    (a straight stroke)."""
    return r.x0 <= region.x1 and r.x1 >= region.x0 and r.y0 <= region.y1 and r.y1 >= region.y0


def _shade(a: str, b: str) -> int:
    return max(abs(x - y) for x, y in zip(bytes.fromhex(a[1:]), bytes.fromhex(b[1:]), strict=True))


def _names(series: list["_Series"], legend: dict[str, str]) -> list[str]:
    """Each series' name in the legend, matched by colour: a legend sample is often set a shade off its
    series' colour, so the closest pairs are taken first, each series and each entry once."""
    pairs = sorted(
        (_shade(s.color, c), i, c)
        for i, s in enumerate(series)
        for c in legend
        if _shade(s.color, c) <= COLOR_SHADE
    )
    names, used = [""] * len(series), set()
    for _, i, c in pairs:
        if not names[i] and c not in used:
            names[i] = legend[c]
            used.add(c)
    return names


def _axis_aligned(d: dict) -> bool:
    for item in d["items"]:
        if item[0] == "re":
            continue
        if item[0] != "l":
            return False
        p, q = item[1], item[2]
        if abs(p.x - q.x) > 0.3 and abs(p.y - q.y) > 0.3:
            return False
    return True


def _vertices(d: dict) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for item in d["items"]:
        if item[0] in ("l", "c"):
            for p in (item[1], item[-1]):
                if not pts or abs(pts[-1][0] - p.x) > 0.01 or abs(pts[-1][1] - p.y) > 0.01:
                    pts.append((p.x, p.y))
    return pts


def _shape(d: dict) -> str:
    kinds = "".join(sorted(i[0] for i in d["items"]))
    return f"{kinds}:{'f' if d.get('fill') else ''}"


def _merged(points: list[tuple[float, float]], pieces: int = 1) -> list[tuple[float, float]]:
    """Marker centres, the pieces of one marker made one; those of fewer than `pieces` pieces left out."""
    out: list[list[float]] = []  # [x, y, n]
    for x, y in points:
        for m in out:
            if abs(m[0] / m[2] - x) <= MERGE and abs(m[1] / m[2] - y) <= MERGE:
                m[0] += x
                m[1] += y
                m[2] += 1
                break
        else:
            out.append([x, y, 1])
    return [(x / n, y / n) for x, y, n in out if n >= pieces]


def _distinct(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """The points in order, each once: a line drawn twice (a panel over a copy of another) gives them twice."""
    seen, out = set(), []
    for x, y in points:
        key = (round(x, 1), round(y, 1))
        if key not in seen:
            seen.add(key)
            out.append((x, y))
    return out


def _legend(texts: list[_Text], drawings: list[dict], region: pymupdf.Rect) -> tuple[dict, set[int]]:
    """{colour: name} from the legend entries (a sample line or marker, its text just right of it), and the
    samples' drawings, which are not data."""
    names: dict[str, str] = {}
    samples: set[int] = set()
    words = [t for t in texts if t.upright and not NUMBER.match(t.text) and len(t.text) <= 60]
    for d in drawings:
        r = pymupdf.Rect(d["rect"])
        if not _touches(r, region) or max(r.width, r.height) > 14 or r.height > MARKER:
            continue
        color = _color(d.get("color")) or _color(d.get("fill"))
        cy = (r.y0 + r.y1) / 2
        label = [t for t in words if abs(t.cy - cy) <= 3 and 0 <= t.box.x0 - r.x1 <= LEGEND_GAP * 0.6]
        if color and label:
            names.setdefault(color, min(label, key=lambda t: t.box.x0 - r.x1).text)
            samples.add(id(d))
    return names, samples


def _series(drawings: list[dict], area: pymupdf.Rect, skip: set[int]) -> list[_Series]:
    markers: dict[tuple[str, str], list[tuple[float, float]]] = defaultdict(list)
    lines: dict[str, list[tuple[float, float]]] = defaultdict(list)
    grown = pymupdf.Rect(area.x0 - 2, area.y0 - 2, area.x1 + 2, area.y1 + 2)
    for d in drawings:
        r = pymupdf.Rect(d["rect"])
        centre = pymupdf.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)
        if id(d) in skip or not grown.contains(centre) or not d["items"]:
            continue
        opacity = d.get("stroke_opacity") if d.get("color") else d.get("fill_opacity")
        if opacity is not None and opacity < MIN_OPACITY:
            continue
        stroke, fill = d.get("color"), d.get("fill")
        color = _color(stroke) or _color(fill)
        if not color:
            continue
        if max(r.width, r.height) <= MARKER and len(d["items"]) <= 8:
            markers[(color, _shape(d))].append((centre.x, centre.y))
        elif not _axis_aligned(d) and not (fill and not stroke) and not any(i[0] == "re" for i in d["items"]):
            # A grid is straight across the axes (left out above); a line past the plot is clipped there.
            lines[color].extend(p for p in _vertices(d) if grown.contains(pymupdf.Point(p)))
    out = []
    for (color, shape), pts in markers.items():
        # A single stroke is a tick mark, unless another one crosses it into a "+" or an "×".
        merged = _merged(pts, 2 if shape == "l:" else 1)
        if len(merged) >= 2:
            out.append(_Series(color, shape, sorted(merged)))
    marked = {s.color for s in out}
    for color, pts in lines.items():
        pts = _distinct(pts)
        if color not in marked and len(pts) >= 2:
            out.append(_Series(color, "line", pts))
    return out


def _significant(v: float, digits: int = 4) -> float:
    if v == 0 or not math.isfinite(v):
        return 0.0
    return round(v, max(0, digits - 1 - math.floor(math.log10(abs(v)))))


def _title_near(texts: list[_Text], box: pymupdf.Rect, upright: bool) -> str:
    near = [t for t in texts if t.upright == upright and not NUMBER.match(t.text) and t.box.intersects(box)]
    if not near:
        return ""
    return min(near, key=lambda t: abs(t.cx - (box.x0 + box.x1) / 2) + abs(t.cy - (box.y0 + box.y1) / 2)).text


def _reading_order(xs: list[_Axis]) -> list[_Axis]:
    """The x axes row by row, left to right: side by side panels' tick rows differ by a fraction of a point."""
    rows: list[list[_Axis]] = []
    for axis in sorted(xs, key=lambda a: a.ticks[0].cy):
        if rows and axis.ticks[0].cy - rows[-1][0].ticks[0].cy <= 10:
            rows[-1].append(axis)
        else:
            rows.append([axis])
    return [axis for row in rows for axis in sorted(row, key=lambda a: a.span[0])]


def digitize(blocks: list[dict], drawings: list[dict], region: pymupdf.Rect) -> dict | None:
    """The data of the chart(s) in `region` of a page, or None when it has no axis with numbers to read
    values against (a diagram, a schematic plot) or nothing plotted on one."""
    inside = [d for d in drawings if _touches(pymupdf.Rect(d["rect"]), region)]
    texts = _texts(blocks, region)
    xs, ys = _axes(texts, inside)
    if not xs or not ys:
        return None
    names, samples = _legend(texts, inside, region)
    panels = []
    free = list(ys)
    for x in _reading_order(xs):
        row = x.ticks[0].box.y0
        # Its y axis: numbers left of the x axis's first tick, the lowest of them just over the row.
        fits = [
            y
            for y in free
            if max(t.box.x1 for t in y.ticks) <= x.span[0] + 4
            and x.span[0] - max(t.box.x1 for t in y.ticks) <= 45
            and -4 <= row - y.span[1] <= 45
        ]
        if not fits:
            continue
        y = min(fits, key=lambda a: (row - a.span[1]) + (x.span[0] - max(t.box.x1 for t in a.ticks)))
        free.remove(y)
        step_x = (x.span[1] - x.span[0]) / (len(x.ticks) - 1)
        step_y = (y.span[1] - y.span[0]) / (len(y.ticks) - 1)
        area = pymupdf.Rect(
            max(t.box.x1 for t in y.ticks) + 1,
            y.span[0] - step_y * 0.6,
            x.span[1] + step_x * 0.6,
            row - 1,
        )
        series = _series(inside, area, samples)[:MAX_SERIES]
        if not series:
            continue
        x_title = _title_near(texts, pymupdf.Rect(area.x0, row + 4, area.x1, row + 24), True)
        y_title = _title_near(
            texts, pymupdf.Rect(area.x0 - 60, area.y0, min(t.box.x0 for t in y.ticks) - 1, area.y1), False
        )
        below = [t for t in texts if t.upright and PANEL_TITLE.match(t.text)]
        below = [t for t in below if area.x0 - 20 <= t.cx <= area.x1 + 20 and 0 <= t.box.y0 - row <= 50]
        panels.append(
            {
                "title": min(below, key=lambda t: t.box.y0).text if below else "",
                "x": {"title": x_title, "scale": x.scale},
                "y": {"title": y_title, "scale": y.scale},
                "series": [
                    {
                        "name": name,
                        "color": s.color,
                        "points": [
                            [_significant(x.value(px)), _significant(y.value(py))]
                            for px, py in s.points[:MAX_POINTS]
                        ],
                    }
                    for s, name in zip(series, _names(series, names), strict=True)
                ],
            }
        )
    return {"panels": panels} if panels else None


TEXT_POINTS = 30  # per series in the AI's text; the reader shows them all


def _sampled(points: list, n: int) -> list:
    """At most n of the points, evenly spread, the first and the last kept."""
    if len(points) <= n:
        return points
    return [points[round(i * (len(points) - 1) / (n - 1))] for i in range(n)]


def chart_text(chart: dict) -> str:
    """The chart's data as the AI reads it: one paragraph per series, each saying which panel and axes it
    belongs to, so a passage cut from the text still says what its numbers are."""
    paragraphs = []
    for n, panel in enumerate(chart.get("panels", []), 1):
        x, y = panel["x"], panel["y"]
        axes = (
            f"x = {x['title'] or 'x'}{' (log scale)' if x['scale'] == 'log' else ''}; "
            f"y = {y['title'] or 'y'}{' (log scale)' if y['scale'] == 'log' else ''}"
        )
        title = panel["title"] or f"panel {n}"
        for k, series in enumerate(panel["series"], 1):
            points = series["points"]
            shown = _sampled(points, TEXT_POINTS)
            some = f", {len(shown)} of {len(points)} points" if len(shown) < len(points) else ""
            values = " ".join(f"({px:g}, {py:g})" for px, py in shown)
            paragraphs.append(
                f"[Chart data read from the PDF drawing — {title}; {axes}; "
                f"series {series['name'] or k}{some}] {values}"
            )
    return "\n\n".join(paragraphs)
