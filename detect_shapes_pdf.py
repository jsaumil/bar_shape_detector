"""Detect black bar shapes (straight, L, U, Z, closed link, ...) directly from a vector PDF.

CAD PDFs store every line as exact vector geometry, so instead of guessing
lines from pixels, the black paths are read from the PDF, their rounded
corners are simplified away, and each bar is classified by its bends.

Usage:
    python detect_shapes_pdf.py [pdf_path] [--page 1] [--dpi 300] [--roi x0 y0 x1 y1]

Outputs:
    shapes_pdf_detected.png  - the page with each shape traced and labelled
    shapes_pdf_only.png      - only the shapes, on a white background
    shapes_pdf.json          - every shape with its points (PDF points, 1/72 inch)
"""
import argparse
import json
import math
import sys

import cv2
import numpy as np
import pymupdf

# A stroke counts as black if every color channel is below this (0..1)
MAX_BLACK = 0.1

# Some bars are drawn in mid gray (0.5), the same color as dashed hidden
# lines. Gray paths are joined separately from black ones, and a gray shape
# counts as a bar only if it is open, has at most 3 parts and all parts are
# horizontal/vertical (gray break symbols are slanted, gray outlines have more
# bends, dashes are too short).
GRAY_BAR_RANGE = (0.45, 0.52)

# Ends closer than this (PDF points) are the same point
SNAP = 0.05

# Segments shorter than this are rounded-corner pieces and get merged away
MIN_SEGMENT = 1.0

# Consecutive segments within this angle (degrees) are one straight run
STRAIGHT_ANGLE = 10

# Shapes shorter than this in total are text strokes and symbols
MIN_SHAPE_LENGTH = 8.0

# A horizontal line with at least this many text strokes just above it
# (within TEXT_GAP points) is a title underline, not a bar
MIN_TEXT_STROKES = 5
TEXT_GAP = 4.0

COLORS = {
    "straight": (0, 160, 0),
    "L": (255, 0, 0),
    "U": (0, 0, 255),
    "Z": (255, 0, 255),
    "closed": (0, 140, 255),
    "other": (128, 0, 128),
}


def black_polylines(page, roi=None, levels=(0.0, MAX_BLACK)):
    """Return every stroked path whose gray level is within `levels` (black by
    default) as a list of points."""
    polylines = []
    for path in page.get_drawings():
        color = path.get("color")
        if "s" not in path["type"] or color is None:
            continue
        # Neutral (black/gray) only, within the requested gray levels
        if max(color) - min(color) > 0.02 or not levels[0] <= max(color) <= levels[1]:
            continue
        # Rect.intersects() is always False for the zero-height box of a
        # horizontal line, so compare the bounds directly
        r = path["rect"]
        if roi is not None and (r.x1 < roi.x0 or r.x0 > roi.x1 or r.y1 < roi.y0 or r.y0 > roi.y1):
            continue
        polylines.extend(path_polylines(path))
    return polylines


def path_polylines(path):
    """Convert one PDF path into polylines (one per connected sub-path)."""
    polylines = []
    current = []
    for item in path["items"]:
        if item[0] == "l":
            pts = [item[1], item[2]]
        elif item[0] == "c":
            # Bezier curve (e.g. a bend): sample it so its length is measured along the arc
            p0, p1, p2, p3 = item[1:5]
            pts = [p0 * (1 - t) ** 3 + p1 * 3 * (1 - t) ** 2 * t + p2 * 3 * (1 - t) * t ** 2
                   + p3 * t ** 3 for t in (i / 8 for i in range(9))]
        elif item[0] == "qu":
            q = item[1]
            pts = [q.ul, q.ur, q.lr, q.ll, q.ul]
        elif item[0] == "re":
            r = item[1]
            pts = [r.tl, r.tr, r.br, r.bl, r.tl]
        else:
            continue
        pts = [(p.x, p.y) for p in pts]
        # A new sub-path starts where the previous one did not end
        if current and math.dist(current[-1], pts[0]) > SNAP:
            polylines.append(current)
            current = []
        current.extend(pts if not current else pts[1:])
    if current:
        polylines.append(current)
    return polylines


def join_polylines(polylines, tol=None):
    """Join polylines that continue each other (one end on another's end).

    Ends closer than `tol` (default SNAP) count as touching; use a larger tol
    for PDFs that draw each piece of a bar as a separate, slightly offset path.
    Ends where three or more lines meet are junctions and are not joined.
    """
    # CAD files often hold the same piece twice (e.g. a bend arc copied onto
    # itself); the copy would turn both of its ends into false junctions
    unique = {}
    for line in polylines:
        ends = sorted((tuple(round(v, 2) for v in line[0]), tuple(round(v, 2) for v in line[-1])))
        length = round(sum(math.dist(a, b) for a, b in zip(line, line[1:])), 2)
        unique.setdefault((*ends, length), line)
    polylines = list(unique.values())
    if tol is not None:
        # A piece shorter than tol (e.g. a tiny bend arc at a crank) has both ends
        # in one cluster and would make it a false junction; its neighbours join
        # straight across the gap it leaves
        polylines = [line for line in polylines
                     if sum(math.dist(a, b) for a, b in zip(line, line[1:])) > tol]

    if tol is None:
        def key(pt):
            return (round(pt[0] / SNAP), round(pt[1] / SNAP))
    else:
        # Cluster nearby end points; every point maps to its cluster's id
        points = [pt for line in polylines for pt in (line[0], line[-1])]
        cell = {}
        for i, pt in enumerate(points):
            cell.setdefault((int(pt[0] // tol), int(pt[1] // tol)), []).append(i)
        parent = list(range(len(points)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for i, pt in enumerate(points):
            cx, cy = int(pt[0] // tol), int(pt[1] // tol)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for j in cell.get((cx + dx, cy + dy), ()):
                        if j < i and math.dist(pt, points[j]) <= tol:
                            parent[find(i)] = find(j)
        cluster = {pt: find(i) for i, pt in enumerate(points)}

        def key(pt):
            return cluster[pt]

    ends = {}
    for i, line in enumerate(polylines):
        ends.setdefault(key(line[0]), []).append(i)
        ends.setdefault(key(line[-1]), []).append(i)

    def next_line(pt, current, used):
        touching = ends[key(pt)]
        if len(touching) != 2:
            return None
        other = touching[1] if touching[0] == current else touching[0]
        return None if other in used else other

    used = set()
    joined = []
    for i, line in enumerate(polylines):
        if i in used:
            continue
        used.add(i)
        chain = list(line)
        # Grow forwards from the last point, then backwards from the first
        for forward in (True, False):
            current = i
            while True:
                pt = chain[-1] if forward else chain[0]
                j = next_line(pt, current, used)
                if j is None:
                    break
                used.add(j)
                other = polylines[j]
                if key(other[0]) != key(pt):
                    other = other[::-1]
                # Keep both ends across the small gap: the piece's own end keeps
                # its straight run's true direction
                chain = chain + other if forward else other[::-1] + chain
                current = j
        joined.append(chain)
    return joined


def simplify(points):
    """Reduce a polyline with rounded corners to its main straight runs and corners.

    Returns (points, closed, straight_ends): straight_ends[i] is the (start, end)
    of the straight part of segment i, i.e. without the rounded bends at its ends.
    """
    closed = len(points) > 3 and math.dist(points[0], points[-1]) <= SNAP

    runs = straight_runs(points)
    for r in runs:
        r["start"], r["end"] = points[r["i0"]], points[r["i1"]]
    if closed and len(runs) > 2:
        diff = abs((runs[0]["angle"] - runs[-1]["angle"] + 180) % 360 - 180)
        if diff < STRAIGHT_ANGLE:
            runs[0]["start"] = runs.pop()["start"]

    # Corners where consecutive runs meet
    corners = []
    pairs = list(zip(runs, runs[1:])) + ([(runs[-1], runs[0])] if closed and len(runs) > 2 else [])
    for a, b in pairs:
        corners.append(intersect(a["start"], a["end"], b["start"], b["end"]))

    straight_ends = [(r["start"], r["end"]) for r in runs]
    if closed and len(runs) > 2:
        return corners[-1:] + corners[:-1], True, straight_ends
    return [runs[0]["start"]] + corners + [runs[-1]["end"]], False, straight_ends


def straight_runs(points):
    """Straight runs: consecutive segments heading the same way.

    Each run has its angle, length and i0 / i1, the indices of its start / end
    in points. Small arc pieces of rounded corners are skipped.
    """
    runs = []
    for i, (p, q) in enumerate(zip(points, points[1:])):
        length = math.dist(p, q)
        if length < 1e-6 or (runs and length < MIN_SEGMENT):
            continue
        angle = math.degrees(math.atan2(q[1] - p[1], q[0] - p[0]))
        if runs and abs((angle - runs[-1]["angle"] + 180) % 360 - 180) < STRAIGHT_ANGLE:
            runs[-1]["i1"] = i + 1
            runs[-1]["length"] += length
        else:
            runs.append({"angle": angle, "length": length, "i0": i, "i1": i + 1})
    return [r for r in runs if r["length"] >= MIN_SEGMENT] or runs[:1]


def bar_length(path, sx=1.0, sy=1.0):
    """Length along a bar, bends included, rebuilt from its straight runs.

    CAD plots round every coordinate (to ~0.06 pt), which matters most in the
    short bend arcs, so the drawn pieces are not summed. Instead the straight
    runs are intersected for exact corners and each bend takes off what an arc
    of its radius saves over the sharp corner: 2 r tan(a/2) - r a, with r from
    how far before the corner the runs stop. sx / sy scale x / y (mm per pt).
    Pieces before the first run and after the last (e.g. end hooks) are added
    as drawn, and so is what a run's small kinks (cranks) add over its chord.
    """
    closed = len(path) > 3 and math.dist(path[0], path[-1]) <= SNAP
    runs = straight_runs(path)
    pts = [(x * sx, y * sy) for x, y in path]
    if closed or len(runs) < 2:
        return length(pts, False)

    def drawn(i, j):
        return sum(math.dist(p, q) for p, q in zip(pts[i:j], pts[i + 1:j + 1]))

    def long_pieces(r):
        """First and last segment of a run that are not kinks."""
        long = [i for i in range(r["i0"], r["i1"]) if math.dist(path[i], path[i + 1]) >= MIN_SEGMENT]
        return (pts[long[0]], pts[long[0] + 1]), (pts[long[-1]], pts[long[-1] + 1])

    pieces = [long_pieces(r) for r in runs]
    ends = [(pts[r["i0"]], pts[r["i1"]]) for r in runs]
    total = drawn(0, runs[0]["i0"]) + drawn(runs[-1]["i1"], len(pts) - 1)
    total += sum(drawn(r["i0"], r["i1"]) - math.dist(*e) for r, e in zip(runs, ends))
    previous = ends[0][0]
    for (_, a1), (b0, _), (_, a_last), (b_first, _) in zip(ends, ends[1:], pieces, pieces[1:]):
        corner = intersect(*a_last, *b_first)
        u = unit_vector(*a_last)
        v = unit_vector(*b_first)
        turn = math.acos(max(-1.0, min(1.0, u[0] * v[0] + u[1] * v[1])))
        if turn < math.radians(STRAIGHT_ANGLE) or turn > math.radians(170):
            # nearly straight or folded back: no reliable corner, keep it as drawn
            total += math.dist(previous, a1) + math.dist(a1, b0)
            previous = b0
            continue
        total += math.dist(previous, corner)
        setback = (math.dist(a1, corner) + math.dist(b0, corner)) / 2
        radius = setback / math.tan(turn / 2)
        total -= 2 * setback - radius * turn
        previous = corner
    return total + math.dist(previous, ends[-1][1])


def unit_vector(a, b):
    d = math.dist(a, b) or 1.0
    return ((b[0] - a[0]) / d, (b[1] - a[1]) / d)


def intersect(p1, p2, p3, p4):
    """Intersection of the infinite lines p1-p2 and p3-p4 (midpoint if parallel)."""
    d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0])
    if abs(d) < 1e-9:
        return ((p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2)
    a = p1[0] * p2[1] - p1[1] * p2[0]
    b = p3[0] * p4[1] - p3[1] * p4[0]
    return ((a * (p3[0] - p4[0]) - (p1[0] - p2[0]) * b) / d,
            (a * (p3[1] - p4[1]) - (p1[1] - p2[1]) * b) / d)


def direction_name(v):
    angle = math.degrees(math.atan2(v[1], v[0])) % 360  # y grows downwards
    names = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"]
    return names[int((angle + 22.5) // 45) % 8]


def classify(points, closed):
    n = len(points) if closed else len(points) - 1
    if closed:
        return "closed", f"closed link ({n} sides)"
    if n == 1:
        (x1, y1), (x2, y2) = points
        if abs(y1 - y2) < abs(x1 - x2) * 0.05:
            return "straight", "straight (horizontal)"
        if abs(x1 - x2) < abs(y1 - y2) * 0.05:
            return "straight", "straight (vertical)"
        return "straight", "straight (inclined)"

    bends = []
    for a, b, c in zip(points, points[1:], points[2:]):
        cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        bends.append(1 if cross > 0 else -1)

    if n == 2:
        corner = points[1]
        legs = [direction_name(np.subtract(p, corner)) for p in (points[0], points[2])]
        return "L", f"L (legs {legs[0]} and {legs[1]})"
    if n == 3:
        if bends[0] != bends[1]:
            return "Z", "Z / crank"
        # Legs point the same way -> U; name the side it opens to
        opens = direction_name(np.add(np.subtract(points[0], points[1]),
                                      np.subtract(points[3], points[2])))
        return "U", f"U (opens {opens})"
    return "other", f"other ({n} segments)"


def length(points, closed):
    pts = points + points[:1] if closed else points
    return sum(math.dist(p, q) for p, q in zip(pts, pts[1:]))


def is_underline(points, strokes):
    (x1, y1), (x2, y2) = points
    if abs(y1 - y2) > 0.05:
        return False
    x1, x2 = sorted((x1, x2))
    above = [b for b in strokes
             if x1 <= b[0] and b[2] <= x2 and y1 - TEXT_GAP <= b[1] and b[3] < y1]
    return len(above) >= MIN_TEXT_STROKES


def is_axis_aligned(points, closed):
    pts = points + (points[:1] if closed else [])
    return all(abs(a[0] - b[0]) < 0.05 or abs(a[1] - b[1]) < 0.05 for a, b in zip(pts, pts[1:]))


def detect_shapes(page, roi=None):
    lines = [(line, "black") for line in join_polylines(black_polylines(page, roi))]
    lines += [(line, "gray") for line in join_polylines(black_polylines(page, roi, GRAY_BAR_RANGE))]
    return shapes_from_lines(lines)


def shapes_from_lines(lines):
    """Build classified shapes from (polyline, source) pairs.

    source is "black", "gray" (only simple axis-aligned open shapes kept) or
    any other tag, e.g. "layer" for bars picked by CAD layer.
    """
    shapes, strokes = [], []
    for line, color in lines:
        if length(line, False) < MIN_SHAPE_LENGTH:
            if color == "black":
                xs, ys = zip(*line)
                strokes.append((min(xs), min(ys), max(xs), max(ys)))
            continue
        points, closed, straight_ends = simplify(line)
        if length(points, closed) < MIN_SHAPE_LENGTH:
            continue
        if color == "gray" and (closed or len(points) > 4 or not is_axis_aligned(points, closed)):
            continue
        kind, name = classify(points, closed)
        shapes.append({
            "color": color,
            "type": kind,
            "name": name,
            "closed": closed,
            "points": [(round(x, 2), round(y, 2)) for x, y in points],
            "length": round(length(points, closed), 2),
            # Full length along the drawn bar, bends (arcs) included
            "path_length": round(length(line, False), 4),
            # Full length rebuilt from the straight runs and bend radii (see bar_length)
            "bar_length": round(bar_length(line), 4),
            "path": [(round(x, 3), round(y, 3)) for x, y in line],
            "straight_parts": [round(math.dist(a, b), 2) for a, b in straight_ends],
            "straight_ends": [[(round(a[0], 2), round(a[1], 2)), (round(b[0], 2), round(b[1], 2))]
                              for a, b in straight_ends],
        })
    shapes = [s for s in shapes
              if not (s["type"] == "straight" and is_underline(s["points"], strokes))]
    shapes.sort(key=lambda s: (round(min(p[1] for p in s["points"]) / 20),
                               min(p[0] for p in s["points"])))
    return shapes


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", nargs="?", default="drawing.pdf")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--dpi", type=int, default=300, help="resolution of the output image")
    parser.add_argument("--roi", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"),
                        help="only look inside this rectangle (PDF points)")
    args = parser.parse_args()

    try:
        doc = pymupdf.open(args.pdf)
    except Exception as e:
        sys.exit(f"Could not open PDF: {e}")
    page = doc[args.page - 1]
    roi = pymupdf.Rect(*args.roi) if args.roi else None

    shapes = detect_shapes(page, roi)
    counts = {}
    for s in shapes:
        counts[s["type"]] = counts.get(s["type"], 0) + 1
    print(f"Found {len(shapes)} shape(s): {counts}")
    for n, s in enumerate(shapes, 1):
        print(f"  #{n}: {s['name']}, length={s['length']}pt, points={s['points']}")

    # Draw the result on a rendering of the page
    pix = page.get_pixmap(dpi=args.dpi, clip=roi)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR if pix.n == 3 else cv2.COLOR_RGBA2BGR)
    zoom = args.dpi / 72
    ox, oy = (roi.x0, roi.y0) if roi else (0, 0)
    thickness = max(1, round(zoom / 2))
    only = np.full_like(img, 255)
    for n, s in enumerate(shapes, 1):
        color = COLORS[s["type"]]
        pts = np.array([((x - ox) * zoom, (y - oy) * zoom) for x, y in s["points"]], np.int32)
        x, y = pts.min(axis=0)
        for canvas in (img, only):
            cv2.polylines(canvas, [pts], s["closed"], color, thickness, cv2.LINE_AA)
            cv2.putText(canvas, f"#{n}", (int(x), int(y) - 3), cv2.FONT_HERSHEY_SIMPLEX,
                        0.1 * zoom, color, max(1, thickness // 2), cv2.LINE_AA)

    cv2.imwrite("shapes_pdf_detected.png", img)
    cv2.imwrite("shapes_pdf_only.png", only)
    with open("shapes_pdf.json", "w") as f:
        json.dump(shapes, f, indent=1)
    print("Saved: shapes_pdf_detected.png, shapes_pdf_only.png, shapes_pdf.json")


if __name__ == "__main__":
    main()
