"""Measure the real length (mm) of every bar shape in a vector CAD PDF.

The drawing scale is worked out from the drawing's own dimensions:
  1. every dimension (a cyan line with an arrowhead at each end) is found and
     measured in PDF points,
  2. its number (e.g. 1350) is read with OCR (the text is drawn as strokes),
  3. value / measured length gives mm per point. Dimensions whose scales agree
     with each other form a scale group; misread numbers and non-length
     callouts don't agree with anything and are dropped,
  4. the most common scale is the drawing scale. A detail drawn at another
     scale (e.g. a 1:25 section) is the area its own dimensions enclose;
     shapes inside it use that scale, all others the drawing scale, so shapes
     without any dimension of their own are still measured.

Usage:
    python shape_lengths.py [pdf_path] [--page 1] [--dpi 300] [--roi x0 y0 x1 y1]

Needs the `tesseract` program (OCR) installed.

Outputs:
    shape_lengths.csv   - one row per shape: length to the corners and straight parts only, per segment
    shape_lengths.json  - the same plus the dimensions used for the scale
    shapes.json         - one entry per shape tag (#1, #2, ...) with its shape and lengths
    shape_lengths.png   - the drawing with every shape labelled with its length
    shape_lengths_only.png - the same labels on a white background
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
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import pymupdf

from detect_shapes_pdf import COLORS, detect_shapes

DIM_LINE_COLOR = (0.0, 1.0, 1.0)  # cyan dimension lines and arrowheads
DIM_TEXT_COLOR = (1.0, 0.5, 0.5)  # pink dimension text

# Dimension text sits just above (or left of, if vertical) its line, within this gap
TEXT_GAP = 1.2
MAX_TEXT_HEIGHT = 2.0

# Dimensions whose mm-per-point differ by less than this belong to one scale group
SCALE_TOLERANCE = 0.01
MIN_GROUP_SIZE = 2

# Dimensions of a minor scale within ZONE_LINK (pt) of each other form one
# detail; shapes inside the box they span (+ ZONE_MARGIN) use that scale
ZONE_LINK = 30
ZONE_MARGIN = 5


def color_of(path, key="color"):
    c = path.get(key)
    return tuple(round(v, 2) for v in c) if c else None


def path_lines(path):
    return [((it[1].x, it[1].y), (it[2].x, it[2].y)) for it in path["items"] if it[0] == "l"]


def arrowheads(drawings):
    """Filled cyan triangles as (tip, unit direction)."""
    heads = []
    for path in drawings:
        if "f" not in path["type"] or color_of(path, "fill") != DIM_LINE_COLOR:
            continue
        verts = []
        for a, b in path_lines(path):
            for q in (a, b):
                if all(math.dist(q, v) > 1e-3 for v in verts):
                    verts.append(q)
        if len(verts) != 3:
            continue
        # The tip is the corner opposite the shortest (base) edge
        edges = [math.dist(verts[1], verts[2]), math.dist(verts[0], verts[2]),
                 math.dist(verts[0], verts[1])]
        k = edges.index(min(edges))
        tip = verts[k]
        o = [verts[i] for i in range(3) if i != k]
        base = ((o[0][0] + o[1][0]) / 2, (o[0][1] + o[1][1]) / 2)
        d = (tip[0] - base[0], tip[1] - base[1])
        n = math.hypot(*d)
        heads.append((tip, (d[0] / n, d[1] / n)))
    return heads


def on_any_line(point, lines, tol=0.05):
    for a, b in lines:
        length = math.dist(a, b)
        if length < 1e-6:
            continue
        t = ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) / length ** 2
        dist = abs((point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])) / length
        if -0.01 <= t <= 1.01 and dist < tol:
            return True
    return False


def find_dimension_lines(drawings):
    """Pairs of arrowheads pointing away from each other on one cyan line."""
    heads = arrowheads(drawings)
    cyan_lines = [ln for p in drawings if p["type"] == "s" and color_of(p) == DIM_LINE_COLOR
                  for ln in path_lines(p)]

    def partner(i):
        tip, d = heads[i]
        best, best_dist = None, math.inf
        for j, (tip2, d2) in enumerate(heads):
            if j == i or d[0] * d2[0] + d[1] * d2[1] > -0.99:
                continue
            gap = (tip2[0] - tip[0], tip2[1] - tip[1])
            dist = math.hypot(*gap)
            if dist < 0.5 or abs(gap[0] * d[1] - gap[1] * d[0]) / dist > 0.02:
                continue
            # Arrow i must point away from its partner
            if gap[0] * d[0] + gap[1] * d[1] > 0:
                continue
            if dist < best_dist:
                best, best_dist = j, dist
        return best

    partners = [partner(i) for i in range(len(heads))]
    dims = []
    for i, j in enumerate(partners):
        if j is None or j < i or partners[j] != i:
            continue
        p1, p2 = heads[i][0], heads[j][0]
        mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        if on_any_line(mid, cyan_lines):
            dims.append({"p1": p1, "p2": p2, "length_pt": math.dist(p1, p2)})
    return dims


def ocr_number(strokes, vertical):
    """Draw the text strokes large and clean, then read the digits with tesseract."""
    x0 = min(s["rect"].x0 for s in strokes)
    y0 = min(s["rect"].y0 for s in strokes)
    x1 = max(s["rect"].x1 for s in strokes)
    y1 = max(s["rect"].y1 for s in strokes)
    zoom, margin = 40, 0.5
    img = np.full((int((y1 - y0 + 2 * margin) * zoom), int((x1 - x0 + 2 * margin) * zoom)),
                  255, np.uint8)
    for s in strokes:
        for a, b in path_lines(s):
            pa = (int((a[0] - x0 + margin) * zoom), int((a[1] - y0 + margin) * zoom))
            pb = (int((b[0] - x0 + margin) * zoom), int((b[1] - y0 + margin) * zoom))
            cv2.line(img, pa, pb, 0, 4, cv2.LINE_AA)
    if vertical:
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        path = f.name
    try:
        cv2.imwrite(path, img)
        out = subprocess.run(
            ["tesseract", path, "stdout", "--psm", "7",
             "-c", "tessedit_char_whitelist=0123456789-/@LTCRY()"],
            capture_output=True, text=True, check=True,
            env={**os.environ, "OMP_THREAD_LIMIT": "1"}).stdout.strip()
    finally:
        os.remove(path)
    return out


def read_dimensions(page):
    drawings = page.get_drawings()
    dims = find_dimension_lines(drawings)
    text_strokes = [p for p in drawings if p["type"] == "s" and color_of(p) == DIM_TEXT_COLOR]

    jobs = []
    for dim in dims:
        (ax, ay), (bx, by) = dim["p1"], dim["p2"]
        vertical = abs(ax - bx) < 0.05
        if vertical:
            lo, hi = sorted((ay, by))
            strokes = [s for s in text_strokes
                       if ax - TEXT_GAP <= s["rect"].x1 <= ax + 0.05
                       and s["rect"].width < MAX_TEXT_HEIGHT
                       and lo <= (s["rect"].y0 + s["rect"].y1) / 2 <= hi]
        else:
            lo, hi = sorted((ax, bx))
            strokes = [s for s in text_strokes
                       if ay - TEXT_GAP <= s["rect"].y1 <= ay + 0.05
                       and s["rect"].height < MAX_TEXT_HEIGHT
                       and lo <= (s["rect"].x0 + s["rect"].x1) / 2 <= hi]
        jobs.append((strokes, vertical))

    # A few OCR processes at once; too many can exhaust memory
    with ThreadPoolExecutor(max_workers=4) as pool:
        texts = list(pool.map(lambda job: ocr_number(*job) if job[0] else "", jobs))

    for dim, text in zip(dims, texts):
        dim["text"] = text
        # Only a plain number is a length; callouts like "2L-T8-100 C/C" are not
        dim["value"] = int(text) if re.fullmatch(r"\d{2,5}", text) else None
        dim["scale"] = dim["value"] / dim["length_pt"] if dim["value"] else None
    return dims


def scale_groups(dims):
    """Group dimensions with matching mm-per-point; groups of 2+ are trusted scales."""
    candidates = sorted((d for d in dims if d["scale"]), key=lambda d: d["scale"])
    groups, current = [], []
    for d in candidates:
        if current and d["scale"] > current[0]["scale"] * (1 + SCALE_TOLERANCE):
            groups.append(current)
            current = []
        current.append(d)
    if current:
        groups.append(current)

    trusted = []
    for g in groups:
        if len(g) < MIN_GROUP_SIZE:
            continue
        # Total value / total length: long dimensions weigh more, as the PDF's
        # coordinate rounding (~0.06 pt) is a smaller share of their length
        scale = sum(d["value"] for d in g) / sum(d["value"] / d["scale"] for d in g)
        for d in g:
            d["group_scale"] = scale
        trusted.append({"scale": scale, "count": len(g)})
    trusted.sort(key=lambda g: -g["count"])
    # Detail scales (1:50, 1:25, 1:20, ...) stay within a few times the main one;
    # a group far outside that comes from repeated misread callouts
    main = trusted[0]["scale"] if trusted else None
    keep = [g for g in trusted if 0.2 <= g["scale"] / main <= 5]
    for d in candidates:
        if d.get("group_scale") and not 0.2 <= d["group_scale"] / main <= 5:
            d["group_scale"] = None
    return keep


def distance_to_shape(point, shape):
    pts = shape["points"] + (shape["points"][:1] if shape["closed"] else [])
    best = math.inf
    for a, b in zip(pts, pts[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        seg = dx * dx + dy * dy
        t = 0 if seg == 0 else max(0, min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / seg))
        best = min(best, math.dist(point, (a[0] + t * dx, a[1] + t * dy)))
    return best


def detail_zones(dims, main_scale):
    """Areas drawn at a different scale than the main one (e.g. a 1:25 section).

    Dimensions of each other scale are grouped by proximity; the box they span
    (plus ZONE_MARGIN) is the area that uses that scale.
    """
    others = [d for d in dims if d.get("group_scale") and d["group_scale"] != main_scale]
    zones = []
    for d in others:
        pts = [d["p1"], d["p2"]]
        for z in zones:
            if z["scale"] == d["group_scale"] and any(
                    math.dist(p, q) <= ZONE_LINK for p in pts for q in z["points"]):
                z["points"] += pts
                z["values"].append(d["value"])
                break
        else:
            zones.append({"scale": d["group_scale"], "points": pts, "values": [d["value"]]})
    for z in zones:
        xs = [p[0] for p in z["points"]]
        ys = [p[1] for p in z["points"]]
        z["box"] = (min(xs) - ZONE_MARGIN, min(ys) - ZONE_MARGIN,
                    max(xs) + ZONE_MARGIN, max(ys) + ZONE_MARGIN)
    return zones


def measure(shapes, dims, main_scale):
    zones = detail_zones(dims, main_scale)
    main_dims = [d for d in dims if d.get("group_scale") == main_scale]
    for s in shapes:
        xs = [p[0] for p in s["points"]]
        ys = [p[1] for p in s["points"]]
        zone = next((z for z in zones if z["box"][0] <= min(xs) and max(xs) <= z["box"][2]
                     and z["box"][1] <= min(ys) and max(ys) <= z["box"][3]), None)
        if zone:
            scale = zone["scale"]
            values = ", ".join(map(str, zone["values"]))
            s["scale_from"] = f"detail with dimensions {values}"
        else:
            scale = main_scale
            nearest = min(main_dims, default=None, key=lambda d: distance_to_shape(
                ((d["p1"][0] + d["p2"][0]) / 2, (d["p1"][1] + d["p2"][1]) / 2), s))
            s["scale_from"] = f"drawing scale (e.g. dimension {nearest['value']})" if nearest \
                else "drawing scale"

        pts = s["points"] + (s["points"][:1] if s["closed"] else [])
        s["segments_mm"] = [round(math.dist(a, b) * scale) for a, b in zip(pts, pts[1:])]
        s["length_mm"] = sum(s["segments_mm"])
        # True length: along the bar as drawn, straight parts plus bends
        s["true_length_mm"] = round(s["bar_length"] * scale, 1)
        # Straight parts only: each segment up to where its bends start
        s["straight_mm"] = [round(v * scale) for v in s["straight_parts"]]
        s["straight_length_mm"] = sum(s["straight_mm"])
        s["mm_per_pt"] = round(scale, 3)


def draw(page, shapes, dpi, roi):
    pix = page.get_pixmap(dpi=dpi, clip=roi)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR if pix.n == 3 else cv2.COLOR_RGBA2BGR)
    only = np.full_like(img, 255)
    zoom = dpi / 72
    ox, oy = (roi.x0, roi.y0) if roi else (0, 0)
    thickness = max(1, round(zoom / 2))
    font_scale, font_thickness = 0.1 * zoom, max(1, thickness // 2)
    placed = []  # label boxes already drawn, so labels don't cover each other
    for n, s in enumerate(shapes, 1):
        color = COLORS[s["type"]]
        pts = np.array([((x - ox) * zoom, (y - oy) * zoom) for x, y in s["points"]], np.int32)
        x, y = (int(v) for v in pts.min(axis=0))
        label = f"#{n} {s['true_length_mm']:.0f}"
        (w, h), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thickness)
        y -= 3
        while any(x < bx1 and bx0 < x + w and y - h < by1 and by0 < y
                  for bx0, by0, bx1, by1 in placed):
            y += h + 4
        placed.append((x, y - h, x + w, y))
        for canvas in (img, only):
            cv2.polylines(canvas, [pts], s["closed"], color, thickness, cv2.LINE_AA)
            cv2.putText(canvas, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX,
                        font_scale, color, font_thickness, cv2.LINE_AA)
    cv2.imwrite("shape_lengths.png", img)
    cv2.imwrite("shape_lengths_only.png", only)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", nargs="?", default="drawing.pdf")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--dpi", type=int, default=300, help="resolution of the output images")
    parser.add_argument("--roi", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"),
                        help="only measure shapes inside this rectangle (PDF points)")
    args = parser.parse_args()

    try:
        page = pymupdf.open(args.pdf)[args.page - 1]
    except Exception as e:
        sys.exit(f"Could not open PDF: {e}")
    roi = pymupdf.Rect(*args.roi) if args.roi else None

    # Dimensions are read from the whole page so shapes near the ROI edge still get one
    dims = read_dimensions(page)
    groups = scale_groups(dims)
    if not groups:
        sys.exit("No readable dimensions found, so the drawing scale is unknown.")
    used = sum(g["count"] for g in groups)
    print(f"Dimensions found: {len(dims)}, used for scale: {used}")
    for g in groups:
        print(f"  scale group: {g['scale']:.3f} mm per pt  ({g['count']} dimensions)")

    shapes = detect_shapes(page, roi)
    measure(shapes, dims, groups[0]["scale"])

    print("\ntrue = along the bar incl. bends; to corner = to the corner points;"
          " straight = straight parts only")
    print(f"{'#':>4}  {'type':<26} {'true mm':>9}  {'to corner mm':>27}  {'straight parts mm':>27}")
    for n, s in enumerate(shapes, 1):
        corner = f"{s['length_mm']} = " + " + ".join(map(str, s["segments_mm"]))
        straight = f"{s['straight_length_mm']} = " + " + ".join(map(str, s["straight_mm"]))
        print(f"{n:>4}  {s['name']:<26} {s['true_length_mm']:>9}  {corner:>27}  {straight:>27}"
              f"   ({s['scale_from']})")

    with open("shape_lengths.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "type", "shape", "true_length_mm", "length_mm", "segments_mm",
                    "straight_length_mm", "straight_parts_mm", "scale_from",
                    "mm_per_pt", "points_pt"])
        for n, s in enumerate(shapes, 1):
            w.writerow([n, s["type"], s["name"], s["true_length_mm"], s["length_mm"],
                        " + ".join(map(str, s["segments_mm"])), s["straight_length_mm"],
                        " + ".join(map(str, s["straight_mm"])), s["scale_from"],
                        s["mm_per_pt"], s["points"]])
    for n, s in enumerate(shapes, 1):
        s["tag"] = f"#{n}"  # same numbers as the labels on the images
    with open("shapes.json", "w") as f:
        json.dump({
            "pdf": args.pdf,
            "page": args.page,
            "mm_per_pt": round(groups[0]["scale"], 3),
            "shapes": [{
                "tag": s["tag"],
                "shape": s["name"],
                "type": s["type"],
                "true_length_mm": s["true_length_mm"],
                "length_to_corners_mm": s["length_mm"],
                "segments_mm": s["segments_mm"],
                "straight_length_mm": s["straight_length_mm"],
                "straight_parts_mm": s["straight_mm"],
                "points_pt": s["points"],
            } for s in shapes],
        }, f, indent=2)
    with open("shape_lengths.json", "w") as f:
        json.dump({
            "scale_groups": groups,
            "dimensions": [{k: d.get(k) for k in ("p1", "p2", "length_pt", "text", "value", "group_scale")}
                           for d in dims],
            "shapes": shapes,
        }, f, indent=1)
    draw(page, shapes, args.dpi, roi)
    print("\nSaved: shapes.json, shape_lengths.csv, shape_lengths.json, shape_lengths.png,"
          " shape_lengths_only.png")


if __name__ == "__main__":
    main()
