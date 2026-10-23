"""Find rebar shapes and their real lengths in any CAD-exported vector PDF.

Works on PDFs from different CAD setups, every page:

Bars
  * If the PDF keeps CAD layers and one is named like a reinforcement layer
    (REIN, REINF, REBAR, BAR, STEEL, RFT), bars are taken from that layer.
  * Otherwise bars are the black/gray lines (detect_shapes_pdf.py).

Drawing scale (mm per PDF point), first that works:
  1. --mm-per-pt / --scale given by you
  2. the drawing's own dimensions: a dimension is a straight line with small
     filled markers on it (arrowheads -> their tips, ticks/dots -> their centre),
     in any color. Its number is read from the PDF text if the text is real,
     otherwise by OCR of the strokes next to the line. number / measured length
     gives mm per point; only values several dimensions agree on are used.
  3. a "SCALE 1:N" label in the PDF text (assumes the sheet is plotted true size)

Usage:
    python rebar_finder.py file.pdf [--pages 1 2] [--scale 50 | --mm-per-pt 87.96]
                                    [--scale-y N | --mm-per-pt-y X | --vertical-ratio R]
                                    (sheet not to scale vertically)
                                    [--bar-layer NAME] [--dim-layer NAME] [--roi x0 y0 x1 y1]
                                    [--dpi 300] [--out DIR] [--probe]

    --probe  only print what the PDF contains (layers, colors, dimensions found,
             numbers read, scale) to see why a PDF does not work

Outputs (in <pdf name>_results/ unless --out is given):
    shapes.json            every shape with its tag (#1, #2, ... per page), shape and lengths
    shapes.csv             the same as a table
    page<N>_shapes.png     the page with every shape labelled "#tag length"
    page<N>_shapes_only.png  the labelled shapes on a white background

Needs the `tesseract` program for PDFs whose text is drawn as lines.
"""
import argparse
import csv
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import pymupdf

from detect_shapes_pdf import (COLORS, bar_length, detect_shapes, join_polylines, path_polylines,
                               shapes_from_lines)
from shape_lengths import measure, scale_groups

BAR_LAYER_PATTERN = r"REIN|REBAR|\bBARS?\b|STEEL|RFT"
DIM_LAYER_PATTERN = r"DIM"

# Bar pieces on a bar layer are joined when their ends are this share of the line width apart
JOIN_SHARE_OF_WIDTH = 0.3

# Scale groups within this share of the main scale are the same scale (rounding of numbers)
SAME_SCALE = 0.03

# Details drawn at another scale use a standard scale; a group whose ratio to the
# main scale is not a ratio of two of these is a repeated misread and is dropped
STANDARD_SCALES = (1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200, 250, 500, 1000)

# Dimension markers: small filled shapes (arrowheads, ticks, dots) up to this size (pt)
MAX_MARKER_SIZE = 4.0
# A marker belongs to a line if it is this close to it (pt) ...
MARKER_ON_LINE = 0.3
# ... and no further beyond the line's ends than this (pt, plus 15% of the line)
MARKER_BEYOND_END = 1.5
# Collinear pieces of one dimension line (e.g. broken around its text) are joined
# when the gap between them is less than this share of the longer piece
LINE_JOIN_GAP = 0.6

# Text strokes are paths no bigger than this (pt)
MAX_GLYPH_SIZE = 15.0
# The number is searched up to this far from its line (pt, plus 10% of the line)
MAX_TEXT_DISTANCE = 3.0

# A number is never drawn with more strokes than this
MAX_TEXT_STROKES = 60

OCR_WORKERS = 4
# Text heights (px) the number is rendered at for OCR; the first two must agree,
# otherwise all are read and the majority wins
OCR_HEIGHTS = (40, 30, 50, 60, 80)
# Text wider than this many times its height is not a dimension number
MAX_TEXT_ASPECT = 8


# ---------------------------------------------------------------- geometry

def unit(a, b):
    d = math.dist(a, b)
    return ((b[0] - a[0]) / d, (b[1] - a[1]) / d)


def project(p, origin, u):
    """(along, across) coordinates of p relative to a line through origin with direction u."""
    dx, dy = p[0] - origin[0], p[1] - origin[1]
    return dx * u[0] + dy * u[1], -dx * u[1] + dy * u[0]


class Grid:
    """Spatial hash of rectangles for quick 'what is near here' queries."""

    def __init__(self, cell=10.0):
        self.cell = cell
        self.cells = defaultdict(list)

    def _keys(self, x0, y0, x1, y1):
        c = self.cell
        for i in range(int(x0 // c), int(x1 // c) + 1):
            for j in range(int(y0 // c), int(y1 // c) + 1):
                yield i, j

    def add(self, item, x0, y0, x1, y1):
        for k in self._keys(x0, y0, x1, y1):
            self.cells[k].append(item)

    def query(self, x0, y0, x1, y1):
        seen = set()
        for k in self._keys(x0, y0, x1, y1):
            for item in self.cells.get(k, ()):
                if id(item) not in seen:
                    seen.add(id(item))
                    yield item


# ---------------------------------------------------------------- bars

def find_bar_layers(drawings, forced=None):
    layers = Counter(p.get("layer") or "" for p in drawings)
    if forced:
        return [name for name in layers if name.lower() == forced.lower()]
    return [name for name in layers if name and re.search(BAR_LAYER_PATTERN, name, re.I)]


def find_bars(page, drawings, bar_layers, roi):
    """Return (shapes, bar_paths, mode)."""
    if bar_layers:
        paths = [p for p in drawings if p.get("layer") in bar_layers and "s" in p["type"]]
        lines = []
        for p in paths:
            r = p["rect"]
            if roi is not None and (r.x1 < roi.x0 or r.x0 > roi.x1 or r.y1 < roi.y0 or r.y0 > roi.y1):
                continue
            lines.extend(path_polylines(p))
        # CAD exports often draw each piece of a bar (straight, bend arc, leg) as its own
        # path with ends slightly apart; join ends closer than a share of the line width
        widths = sorted(p.get("width") or 0 for p in paths)
        tol = min(0.5, max(0.05, JOIN_SHARE_OF_WIDTH * widths[len(widths) // 2])) if widths else None
        shapes = shapes_from_lines([(line, "layer") for line in join_polylines(lines, tol)])
        return shapes, paths, f"layer {', '.join(bar_layers)}"
    shapes = detect_shapes(page, roi)
    return shapes, [], "black/gray lines"


# ---------------------------------------------------------------- dimensions

def marker_points(drawings):
    """Measuring points of small filled markers: arrow tip or tick/dot centre."""
    points = []
    for path in drawings:
        r = path["rect"]
        if "f" not in path["type"] or max(r.width, r.height) > MAX_MARKER_SIZE:
            continue
        verts = []
        for poly in path_polylines(path):
            for q in poly:
                if all(math.dist(q, v) > 1e-3 for v in verts):
                    verts.append(q)
        if len(verts) == 3:
            # Arrowhead: the tip is the corner opposite the shortest edge
            edges = [math.dist(verts[1], verts[2]), math.dist(verts[0], verts[2]),
                     math.dist(verts[0], verts[1])]
            points.append(verts[edges.index(min(edges))])
        else:
            points.append(((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
    return points


def candidate_lines(paths):
    """Straight segments of the given paths, with collinear pieces joined."""
    groups = defaultdict(list)
    for path in paths:
        if "s" not in path["type"]:
            continue
        for item in path["items"]:
            if item[0] != "l":
                continue
            a, b = (item[1].x, item[1].y), (item[2].x, item[2].y)
            if math.dist(a, b) < 0.5:
                continue
            u = unit(a, b)
            if u[0] < -1e-9 or (abs(u[0]) <= 1e-9 and u[1] < 0):
                a, b, u = b, a, (-u[0], -u[1])
            offset = -a[0] * u[1] + a[1] * u[0]
            key = (round(math.degrees(math.atan2(u[1], u[0])), 1), round(offset / 0.05))
            groups[key].append((a, b, u))

    lines = []
    for pieces in groups.values():
        u = pieces[0][2]
        origin = pieces[0][0]
        spans = sorted((project(a, origin, u)[0], project(b, origin, u)[0]) for a, b, _ in pieces)
        cur = list(spans[0])
        for s0, s1 in spans[1:]:
            gap = s0 - cur[1]
            if gap <= LINE_JOIN_GAP * max(cur[1] - cur[0], s1 - s0):
                cur[1] = max(cur[1], s1)
            else:
                lines.append((origin, u, cur[0], cur[1]))
                cur = [s0, s1]
        lines.append((origin, u, cur[0], cur[1]))
    return lines


def dimension_intervals(lines, markers):
    """Pairs of consecutive markers lying on one line."""
    grid = Grid()
    for m in markers:
        grid.add(m, m[0], m[1], m[0], m[1])

    intervals, seen = [], set()
    for origin, u, t0, t1 in lines:
        length = t1 - t0
        reach = MARKER_BEYOND_END + 0.15 * length
        a = (origin[0] + u[0] * (t0 - reach), origin[1] + u[1] * (t0 - reach))
        b = (origin[0] + u[0] * (t1 + reach), origin[1] + u[1] * (t1 + reach))
        found = []
        for m in grid.query(min(a[0], b[0]) - 1, min(a[1], b[1]) - 1,
                            max(a[0], b[0]) + 1, max(a[1], b[1]) + 1):
            along, across = project(m, origin, u)
            if abs(across) <= MARKER_ON_LINE and t0 - reach <= along <= t1 + reach:
                found.append((along, m))
        found.sort()
        stops = []
        for along, m in found:
            if not stops or along - stops[-1][0] > 0.2:
                stops.append((along, m))
        for (s0, p1), (s1, p2) in zip(stops, stops[1:]):
            if s1 - s0 < 0.5:
                continue
            key = (round(p1[0], 1), round(p1[1], 1), round(p2[0], 1), round(p2[1], 1))
            if key not in seen:
                seen.add(key)
                intervals.append({"p1": p1, "p2": p2, "length_pt": s1 - s0, "u": u})
    return intervals


def text_frame(p1, p2):
    """Reading direction u (left to right / bottom to top) and 'down' v of a dimension's text."""
    u = unit(p1, p2)
    if u[0] < -1e-6 or (abs(u[0]) <= 1e-6 and u[1] > 0):
        u = (-u[0], -u[1])
    return u, (-u[1], u[0])


def glyph_blob(dim, glyphs, grid):
    """The text strokes of the number next to a dimension line (or None)."""
    p1, p2 = dim["p1"], dim["p2"]
    u, _ = text_frame(p1, p2)
    mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    half = dim["length_pt"] / 2
    reach = MAX_TEXT_DISTANCE + 0.1 * dim["length_pt"]
    # Search a band along the line, not a square around it
    band = reach + MAX_GLYPH_SIZE
    xs = [p1[0], p2[0]]
    ys = [p1[1], p2[1]]

    def extent(g):
        coords = [project(q, mid, u) for q in g["corners"]]
        al = [c[0] for c in coords]
        ac = [c[1] for c in coords]
        return min(al), max(al), min(ac), max(ac)

    near = []
    for g in grid.query(min(xs) - band, min(ys) - band, max(xs) + band, max(ys) + band):
        a0, a1, c0, c1 = extent(g)
        if c0 < 0.05 and c1 > -0.05:
            continue  # crosses the line: extension line, marker, not text
        near.append((g, a0, a1, c0, c1))

    seeds = [n for n in near if n[1] < half and n[2] > -half
             and min(abs(n[3]), abs(n[4])) <= reach]
    if not seeds:
        return None
    seed = min(seeds, key=lambda n: min(abs(n[3]), abs(n[4])) + 0.3 * abs((n[1] + n[2]) / 2))
    blob = [seed]
    a0, a1, c0, c1 = seed[1:]
    grew = True
    while grew:
        grew = False
        h = max(c1 - c0, 0.5)
        for n in near:
            if n in blob:
                continue
            if n[3] > c1 + 0.25 * h or n[4] < c0 - 0.25 * h:
                continue
            if n[1] > a1 + 0.8 * h or n[2] < a0 - 0.8 * h:
                continue
            blob.append(n)
            a0, a1, c0, c1 = min(a0, n[1]), max(a1, n[2]), min(c0, n[3]), max(c1, n[4])
            grew = True
        if len(blob) > MAX_TEXT_STROKES:
            return None  # far too much to be one number: hatching, a table, a paragraph
    return [n[0] for n in blob], (a0, a1, c0, c1), mid, u


def render_blob(blob, text_height):
    """Draw the number's strokes black on white, reading left to right."""
    glyphs, (a0, a1, c0, c1), mid, u = blob
    zoom = text_height / max(c1 - c0, 0.3)
    margin = 0.4 * (c1 - c0) + 0.2
    w = int((a1 - a0 + 2 * margin) * zoom) + 1
    h = int((c1 - c0 + 2 * margin) * zoom) + 1
    img = np.full((h, w), 255, np.uint8)
    if w * h > 4e6:
        return img[:1, :1]
    for g in glyphs:
        for poly in g["polylines"]:
            pts = []
            for q in poly:
                al, ac = project(q, mid, u)
                pts.append((int((al - a0 + margin) * zoom), int((ac - c0 + margin) * zoom)))
            cv2.polylines(img, [np.array(pts, np.int32)], False, 0, max(2, text_height // 12),
                          cv2.LINE_AA)
    return img


def ocr_images(images):
    """OCR many single-line images; tesseract reads a whole list in one run per worker."""
    if not images:
        return []

    def run(chunk):
        with tempfile.TemporaryDirectory() as tmp:
            names = []
            for i, img in enumerate(chunk):
                names.append(os.path.join(tmp, f"{i}.png"))
                cv2.imwrite(names[-1], img)
            listing = os.path.join(tmp, "list.txt")
            with open(listing, "w") as f:
                f.write("\n".join(names) + "\n")
            out = subprocess.run(
                ["tesseract", listing, "stdout", "--psm", "7",
                 "-c", "tessedit_char_whitelist=0123456789-/@LTCRYXABEH()."],
                capture_output=True, text=True,
                env={**os.environ, "OMP_THREAD_LIMIT": "1"}).stdout
        texts = [t.strip() for t in out.split("\f")][:len(chunk)]
        return texts + [""] * (len(chunk) - len(texts))

    size = math.ceil(len(images) / OCR_WORKERS)
    chunks = [images[i:i + size] for i in range(0, len(images), size)]
    with ThreadPoolExecutor(max_workers=OCR_WORKERS) as pool:
        return [t for texts in pool.map(run, chunks) for t in texts]


def ocr_blobs(blobs):
    """OCR at several sizes and vote: single OCR runs misread digits (5 -> 3) now and then.

    Round 1 reads every number at two sizes; if both agree it is accepted. The
    rest that look like numbers are read at the other sizes and the majority wins.
    """
    number = re.compile(r"\d{2,6}")
    results = [""] * len(blobs)
    todo = [i for i, (_, (a0, a1, c0, c1), _, _) in enumerate(blobs)
            if a1 - a0 <= MAX_TEXT_ASPECT * max(c1 - c0, 0.1)]  # wider is not a number
    reads = {i: [] for i in todo}
    for h in OCR_HEIGHTS[:2]:
        for i, text in zip(todo, ocr_images([render_blob(blobs[i], h) for i in todo])):
            reads[i].append(text)
    vote = []
    for i in todo:
        r = reads[i]
        if r[0] == r[1] and number.fullmatch(r[0]):
            results[i] = r[0]
        elif any(re.search(r"\d{2}", t) for t in r):
            vote.append(i)
        else:
            results[i] = r[0]  # a letter or a label, not a number
    for h in OCR_HEIGHTS[2:]:
        for i, text in zip(vote, ocr_images([render_blob(blobs[i], h) for i in vote])):
            reads[i].append(text)
    for i in vote:
        numbers = Counter(t for t in reads[i] if number.fullmatch(t))
        if numbers and numbers.most_common(1)[0][1] >= 2:
            results[i] = numbers.most_common(1)[0][0]
        else:
            results[i] = "?" + reads[i][0]  # no agreement: not trusted
    return results


def text_words(page):
    """Numbers in the PDF's real text: list of (value, centre)."""
    words = []
    for x0, y0, x1, y1, word, *_ in page.get_text("words"):
        w = word.replace(",", "")
        if re.fullmatch(r"\d{2,6}", w):
            words.append((int(w), ((x0 + x1) / 2, (y0 + y1) / 2), max(x1 - x0, y1 - y0)))
    return words


def read_dimensions(page, drawings, bar_paths, dim_layers):
    bar_ids = {id(p) for p in bar_paths}
    other = [p for p in drawings if id(p) not in bar_ids]
    line_paths = [p for p in other if p.get("layer") in dim_layers] if dim_layers else other
    markers = marker_points(other)
    dims = dimension_intervals(candidate_lines(line_paths), markers)

    words = text_words(page)
    glyphs, grid = [], Grid(cell=MAX_GLYPH_SIZE)
    for p in other:
        r = p["rect"]
        if "s" in p["type"] and max(r.width, r.height) <= MAX_GLYPH_SIZE:
            polys = path_polylines(p)
            g = {"polylines": polys,
                 "corners": [(r.x0, r.y0), (r.x1, r.y0), (r.x0, r.y1), (r.x1, r.y1)]}
            if polys:
                glyphs.append(g)
                grid.add(g, r.x0, r.y0, r.x1, r.y1)

    jobs = []
    for d in dims:
        d["text"], d["source"] = "", None
        mid = ((d["p1"][0] + d["p2"][0]) / 2, (d["p1"][1] + d["p2"][1]) / 2)
        u, _ = text_frame(d["p1"], d["p2"])
        reach = MAX_TEXT_DISTANCE + 0.1 * d["length_pt"]
        best = None
        for value, c, size in words:
            along, across = project(c, mid, u)
            if abs(along) <= d["length_pt"] / 2 and abs(across) <= reach + size:
                score = abs(across) + 0.3 * abs(along)
                if best is None or score < best[0]:
                    best = (score, value)
        if best:
            d["text"], d["source"] = str(best[1]), "pdf text"
            continue
        blob = glyph_blob(d, glyphs, grid)
        if blob:
            jobs.append((d, blob))

    for (d, _), text in zip(jobs, ocr_blobs([blob for _, blob in jobs])):
        d["text"], d["source"] = text, "ocr"

    for d in dims:
        d["value"] = int(d["text"]) if re.fullmatch(r"\d{2,6}", d["text"]) else None
        d["scale"] = d["value"] / d["length_pt"] if d["value"] else None
    return dims


def is_standard_ratio(ratio, tol=0.01):
    return any(abs(ratio / (a / b) - 1) <= tol for a in STANDARD_SCALES for b in STANDARD_SCALES)


def scale_from_label(page):
    """mm per pt from a 'SCALE 1:N' label in real text, assuming a true-size plot."""
    found = re.findall(r"SCALE\s*[-:=]?\s*1\s*[:/]\s*(\d+)", page.get_text(), re.I)
    if not found:
        return None, None
    n = int(Counter(found).most_common(1)[0][0])
    return 25.4 / 72 * n, n


def measure_xy(shapes, sx, sy):
    """Lengths with separate horizontal (sx) and vertical (sy) mm per point, for
    drawings that are not to scale in one direction."""
    def dist(a, b):
        return math.hypot((b[0] - a[0]) * sx, (b[1] - a[1]) * sy)

    for s in shapes:
        pts = s["points"] + (s["points"][:1] if s["closed"] else [])
        s["segments_mm"] = [round(dist(a, b)) for a, b in zip(pts, pts[1:])]
        s["length_mm"] = sum(s["segments_mm"])
        s["straight_mm"] = [round(dist(a, b)) for a, b in s["straight_ends"]]
        s["straight_length_mm"] = sum(s["straight_mm"])
        s["true_length_mm"] = round(bar_length(s["path"], sx, sy), 1)
        s["mm_per_pt"] = round(sx, 3)
        s["scale_from"] = "horizontal and vertical scales"


# ---------------------------------------------------------------- output

def draw(page, shapes, dpi, roi, out_dir, page_no):
    pix = page.get_pixmap(dpi=dpi, clip=roi)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR if pix.n == 3 else cv2.COLOR_RGBA2BGR)
    only = np.full_like(img, 255)
    zoom = dpi / 72
    ox, oy = (roi.x0, roi.y0) if roi else (page.rect.x0, page.rect.y0)
    thickness = max(1, round(zoom / 2))
    font_scale, font_thickness = 0.1 * zoom, max(1, thickness // 2)
    placed = []
    for s in shapes:
        color = COLORS[s["type"]]
        pts = np.array([((x - ox) * zoom, (y - oy) * zoom) for x, y in s["points"]], np.int32)
        x, y = (int(v) for v in pts.min(axis=0))
        label = f"{s['tag']} {s['true_length_mm']:.0f}"
        (w, h), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thickness)
        y -= 3
        while any(x < bx1 and bx0 < x + w and y - h < by1 and by0 < y for bx0, by0, bx1, by1 in placed):
            y += h + 4
        placed.append((x, y - h, x + w, y))
        for canvas in (img, only):
            cv2.polylines(canvas, [pts], s["closed"], color, thickness, cv2.LINE_AA)
            cv2.putText(canvas, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, font_scale, color,
                        font_thickness, cv2.LINE_AA)
    cv2.imwrite(os.path.join(out_dir, f"page{page_no}_shapes.png"), img)
    cv2.imwrite(os.path.join(out_dir, f"page{page_no}_shapes_only.png"), only)


def probe(page, drawings, bar_layers, dim_layers, bar_mode, shapes, dims, groups):
    layers = Counter(p.get("layer") or "(none)" for p in drawings)
    colors = Counter((tuple(round(v, 2) for v in p["color"]), round(p.get("width") or 0, 2))
                     for p in drawings if p.get("color"))
    print(f"  size {page.rect.width:.0f} x {page.rect.height:.0f} pt, {len(drawings)} paths,"
          f" {len(text_words(page))} numbers in PDF text")
    print(f"  layers: {dict(layers.most_common(15))}")
    print(f"  stroke colors (rgb, width): {colors.most_common(8)}")
    print(f"  bars from: {bar_mode} -> {len(shapes)} shapes")
    print(f"  dimension lines from: {'layer ' + ', '.join(dim_layers) if dim_layers else 'any layer'}"
          f" -> {len(dims)} marked intervals, {sum(1 for d in dims if d['value'])} with a number")
    read = Counter((d["text"], d["source"]) for d in dims if d["text"])
    print(f"  text read (text, source): {read.most_common(25)}")
    for g in groups:
        print(f"  scale group: {g['scale']:.3f} mm per pt ({g['count']} dimensions)")


# ---------------------------------------------------------------- main

def process_page(page, page_no, args, roi):
    drawings = page.get_drawings()
    bar_layers = find_bar_layers(drawings, args.bar_layer)
    if args.bar_layer and not bar_layers:
        print(f"  warning: no layer named {args.bar_layer!r}; using black/gray lines")
    layer_names = {p.get("layer") or "" for p in drawings}
    if args.dim_layer:
        dim_layers = [n for n in layer_names if n.lower() == args.dim_layer.lower()]
    else:
        dim_layers = [n for n in layer_names if n and re.search(DIM_LAYER_PATTERN, n, re.I)]

    shapes, bar_paths, bar_mode = find_bars(page, drawings, bar_layers, roi)

    dims, groups = [], []
    if args.mm_per_pt:
        main_scale, scale_note = args.mm_per_pt, "given (--mm-per-pt)"
    elif args.scale:
        main_scale, scale_note = 25.4 / 72 * args.scale, f"given (--scale 1:{args.scale})"
    else:
        dims = read_dimensions(page, drawings, bar_paths, dim_layers)
        groups = scale_groups(dims)
        if groups:
            # Groups only slightly off the main one are the same scale: merge them
            main = groups[0]["scale"]
            for g in groups[1:]:
                if abs(g["scale"] / main - 1) <= SAME_SCALE:
                    groups[0]["count"] += g["count"]
                    for d in dims:
                        if d.get("group_scale") == g["scale"]:
                            d["group_scale"] = main
            groups = [groups[0]] + [g for g in groups[1:] if abs(g["scale"] / main - 1) > SAME_SCALE
                                    and is_standard_ratio(g["scale"] / main)]
            kept = {g["scale"] for g in groups}
            for d in dims:
                if d.get("group_scale") not in kept:
                    d["group_scale"] = None
            main_scale = groups[0]["scale"]
            scale_note = f"from {groups[0]['count']} dimensions"
        else:
            main_scale, n = scale_from_label(page)
            scale_note = f"from label SCALE 1:{n} (assumes true-size plot)" if main_scale else None

    if args.probe:
        probe(page, drawings, bar_layers, dim_layers, bar_mode, shapes, dims, groups)
    if main_scale is None:
        print(f"  page {page_no}: no scale found (no readable dimensions, no SCALE label)."
              " Use --scale N or --mm-per-pt X, or --probe to see what the page contains.")
        return None

    # Vertical scale: given, or assumed equal to the horizontal one
    if args.mm_per_pt_y or args.scale_y:
        scale_y = args.mm_per_pt_y or 25.4 / 72 * args.scale_y
        scale_y_note = "given"
    elif args.vertical_ratio:
        scale_y = main_scale / args.vertical_ratio
        scale_y_note = f"horizontal / {args.vertical_ratio:g} (given --vertical-ratio)"
    else:
        scale_y = main_scale
        vertical = [d for d in dims if d.get("group_scale") == main_scale
                    and abs(d["p1"][0] - d["p2"][0]) < 0.05]
        scale_y_note = (f"same as horizontal (checked by {len(vertical)} vertical dimensions)" if vertical
                        else "ASSUMED same as horizontal: no vertical dimensions to check it")
    if scale_y == main_scale:
        measure(shapes, dims if groups else [], main_scale)
    else:
        measure_xy(shapes, main_scale, scale_y)
    if scale_y_note.startswith("ASSUMED"):
        print(f"  warning: vertical scale {scale_y_note}. If the sheet is not drawn to scale"
              " vertically, give it with --vertical-ratio R, --scale-y N or --mm-per-pt-y X.")
    for n, s in enumerate(shapes, 1):
        s["tag"] = f"#{n}"
    print(f"  page {page_no}: {len(shapes)} shapes ({bar_mode}), scale {main_scale:.3f} mm/pt {scale_note}")
    return {"page": page_no, "mm_per_pt": round(main_scale, 4), "scale_from": scale_note,
            "mm_per_pt_vertical": round(scale_y, 4), "vertical_scale_from": scale_y_note,
            "bars_from": bar_mode, "shapes": shapes}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf")
    parser.add_argument("--pages", nargs="+", type=int, help="page numbers (default: all)")
    parser.add_argument("--scale", type=float, help="drawing scale N of 1:N (true-size plot)")
    parser.add_argument("--mm-per-pt", type=float, help="mm per PDF point, if known")
    parser.add_argument("--scale-y", type=float,
                        help="vertical drawing scale N of 1:N, if not the same as horizontal")
    parser.add_argument("--mm-per-pt-y", type=float, help="vertical mm per PDF point, if known")
    parser.add_argument("--vertical-ratio", type=float,
                        help="depths are drawn R times true size (e.g. 2 when a 300 deep beam is"
                             " drawn 600 deep and its vertical dimensions read half their length)")
    parser.add_argument("--bar-layer", help="CAD layer with the bars (default: auto)")
    parser.add_argument("--dim-layer", help="CAD layer with dimension lines (default: auto)")
    parser.add_argument("--roi", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"),
                        help="only look for bars inside this rectangle (PDF points)")
    parser.add_argument("--dpi", type=int, default=300, help="resolution of the output images")
    parser.add_argument("--out", help="output folder (default: <pdf name>_results)")
    parser.add_argument("--probe", action="store_true", help="print what the PDF contains")
    args = parser.parse_args()

    try:
        doc = pymupdf.open(args.pdf)
    except Exception as e:
        sys.exit(f"Could not open PDF: {e}")
    out_dir = args.out or os.path.splitext(os.path.basename(args.pdf))[0] + "_results"
    os.makedirs(out_dir, exist_ok=True)
    roi = pymupdf.Rect(*args.roi) if args.roi else None

    results = []
    for page_no in args.pages or range(1, len(doc) + 1):
        print(f"Page {page_no}:")
        result = process_page(doc[page_no - 1], page_no, args, roi)
        if result:
            draw(doc[page_no - 1], result["shapes"], args.dpi, roi, out_dir, page_no)
            results.append(result)

    rows = [{
        "page": r["page"],
        "tag": s["tag"],
        "shape": s["name"],
        "type": s["type"],
        "true_length_mm": s["true_length_mm"],
        "length_to_corners_mm": s["length_mm"],
        "segments_mm": s["segments_mm"],
        "straight_length_mm": s["straight_length_mm"],
        "straight_parts_mm": s["straight_mm"],
        "points_pt": s["points"],
    } for r in results for s in r["shapes"]]

    with open(os.path.join(out_dir, "shapes.json"), "w") as f:
        json.dump({
            "pdf": args.pdf,
            "pages": [{k: r[k] for k in ("page", "mm_per_pt", "scale_from", "mm_per_pt_vertical",
                                         "vertical_scale_from", "bars_from")}
                      for r in results],
            "shapes": rows,
        }, f, indent=2)
    with open(os.path.join(out_dir, "shapes.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["page", "tag", "shape", "type", "true_length_mm", "length_to_corners_mm",
                    "segments_mm", "straight_length_mm", "straight_parts_mm"])
        for row in rows:
            w.writerow([row["page"], row["tag"], row["shape"], row["type"], row["true_length_mm"],
                        row["length_to_corners_mm"], " + ".join(map(str, row["segments_mm"])),
                        row["straight_length_mm"], " + ".join(map(str, row["straight_parts_mm"]))])
    print(f"Saved {len(rows)} shapes to {out_dir}/ (shapes.json, shapes.csv, page images)")


if __name__ == "__main__":
    main()
