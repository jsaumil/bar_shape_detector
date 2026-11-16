"""Detect black bar shapes (straight, L, U, Z, closed link, ...) in a CAD drawing image.

Every black line is converted into horizontal/vertical segments, segments that
meet at a corner are chained together, and each chain is classified by its
number of segments and the direction of its bends.

Usage:
    python detect_shapes.py [image_path] [--dpi 600] [--roi x y w h]

For images made with pdf_to_image.py, pass the same --dpi so the pixel sizes
below are scaled to match.

Outputs:
    shapes_detected.png  - original image with each shape traced and labelled
    shapes_only.png      - only the detected shapes on a white background
"""
import argparse
import sys

import cv2
import numpy as np

# Black CAD lines are anti-aliased, so they show up as gray (value ~20-180)
# with almost no color saturation.
MAX_SATURATION = 40
MAX_VALUE = 200

# Solid bars are drawn about twice as dark as dashed/hidden lines and grid
# centerlines. Darkness is summed across the line's width (3 px): a solid
# line gives ~255, a dashed line ~120.
MIN_LINE_WEIGHT = 190

# The pixel sizes below are tuned for a drawing rendered at this DPI
BASE_DPI = 600

# Colored dimension lines crossing a black line cut it into pieces.
# Gaps up to this many pixels are bridged, but only through colored pixels.
MAX_GAP = 4

# Straight runs shorter than this are ignored (text strokes, small spurs)
MIN_SEGMENT = 20

# Two segment ends closer than this are treated as one corner
JOIN_DIST = 6


def scale_to_dpi(dpi):
    """Scale the pixel sizes above for an image rendered at another DPI."""
    global MAX_GAP, MIN_SEGMENT, JOIN_DIST
    factor = dpi / BASE_DPI
    MAX_GAP = max(2, round(4 * factor))
    MIN_SEGMENT = max(10, round(20 * factor))
    JOIN_DIST = max(3, round(6 * factor))

COLORS = {
    "straight": (0, 160, 0),
    "L": (255, 0, 0),
    "U": (0, 0, 255),
    "Z": (255, 0, 255),
    "closed": (0, 140, 255),
    "other": (128, 0, 128),
}


def black_line_masks(img):
    """Return (horizontal, vertical) masks of solid black line pixels."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray_ink = hsv[..., 1] < MAX_SATURATION
    black = gray_ink & (hsv[..., 2] < MAX_VALUE)
    darkness = np.where(gray_ink, 255 - hsv[..., 2].astype(np.float32), 0)

    # Any non-white pixel (black or colored ink)
    ink = ((hsv[..., 2] < 245) | (hsv[..., 1] > 40)).astype(np.uint8) * 255

    masks = []
    for across, along in (((3, 1), (1, 2 * MAX_GAP + 1)), ((1, 3), (2 * MAX_GAP + 1, 1))):
        # Weight measured across the line drops faint lines (dashed, hidden,
        # grid centerlines), even where they cross a solid bar.
        weight = cv2.boxFilter(darkness, -1, across[::-1], normalize=False)
        solid = (black & (weight > MIN_LINE_WEIGHT)).astype(np.uint8) * 255

        # Close small gaps along the line, but keep only the filled pixels
        # that lie on ink. White space (e.g. the gap between two parallel
        # legs) is never filled, so separate bars stay separate.
        closed = cv2.morphologyEx(solid, cv2.MORPH_CLOSE, np.ones(along, np.uint8))
        masks.append(cv2.bitwise_or(solid, cv2.bitwise_and(closed, ink)))
    return masks


def extract_segments(h_mask, v_mask, ox, oy):
    """Split one connected piece of line into horizontal and vertical segments.

    Each segment is ((x1, y1), (x2, y2)) in image coordinates, sorted so that
    the first point is the left/top end.
    """
    segments = []
    for mask, kernel, horizontal in ((h_mask, (1, MIN_SEGMENT), True),
                                     (v_mask, (MIN_SEGMENT, 1), False)):
        # Border must count as background, or short crops produce fake runs
        runs = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones(kernel, np.uint8),
                                borderType=cv2.BORDER_CONSTANT, borderValue=0)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(runs, connectivity=8)
        for i in range(1, n):
            x, y, w, h, _ = stats[i]
            ys, xs = np.nonzero(labels == i)
            if horizontal:
                yc = int(round(ys.mean()))
                segments.append(((ox + x, oy + yc), (ox + x + w - 1, oy + yc)))
            else:
                xc = int(round(xs.mean()))
                segments.append(((ox + xc, oy + y), (ox + xc, oy + y + h - 1)))
    return segments


def is_horizontal(seg):
    return seg[0][1] == seg[1][1]


def seg_length(seg):
    return abs(seg[1][0] - seg[0][0]) + abs(seg[1][1] - seg[0][1])


def distance(p, q):
    return float(np.hypot(p[0] - q[0], p[1] - q[1]))


def interior_hit(point, seg):
    """Return the split position on seg if point touches seg away from its ends."""
    (x1, y1), (x2, y2) = seg
    px, py = point
    if is_horizontal(seg):
        if abs(py - y1) <= JOIN_DIST and x1 + JOIN_DIST < px < x2 - JOIN_DIST:
            return (px, y1)
    elif abs(px - x1) <= JOIN_DIST and y1 + JOIN_DIST < py < y2 - JOIN_DIST:
        return (x1, py)
    return None


def split_t_junctions(segments):
    """Split a bar where another bar's end touches its middle (T-junction).

    In a drawing this happens when a hooked bar overlaps a straight bar on the
    same line. The bar is cut at the junction; the hook later joins the shorter
    piece, since a hook belongs to the end of a bar.
    """
    changed = True
    while changed:
        changed = False
        for i, seg in enumerate(segments):
            for j, other in enumerate(segments):
                if i == j or is_horizontal(seg) == is_horizontal(other):
                    continue
                for end in other:
                    hit = interior_hit(end, seg)
                    if hit is None:
                        continue
                    a, b = (seg[0], hit), (hit, seg[1])
                    # Pull the longer piece back so only the shorter one meets the hook
                    if seg_length(a) <= seg_length(b):
                        b = (shift_towards(hit, seg[1]), seg[1])
                    else:
                        a = (seg[0], shift_towards(hit, seg[0]))
                    segments[i:i + 1] = [a, b]
                    changed = True
                    break
                if changed:
                    break
            if changed:
                break
    return [s for s in segments if seg_length(s) >= MIN_SEGMENT // 2]


def shift_towards(p, q):
    step = 2 * JOIN_DIST
    dx = int(np.sign(q[0] - p[0])) * step
    dy = int(np.sign(q[1] - p[1])) * step
    return (p[0] + dx, p[1] + dy)


def group_segments(segments):
    """Link segments whose ends meet at a corner; return groups as ordered chains."""
    n = len(segments)
    links = {i: [] for i in range(n)}
    for i in range(n):
        for j in range(i + 1, n):
            if is_horizontal(segments[i]) == is_horizontal(segments[j]):
                continue
            if any(distance(p, q) <= JOIN_DIST for p in segments[i] for q in segments[j]):
                links[i].append(j)
                links[j].append(i)

    seen = set()
    groups = []
    for start in range(n):
        if start in seen:
            continue
        stack, members = [start], []
        seen.add(start)
        while stack:
            k = stack.pop()
            members.append(k)
            for m in links[k]:
                if m not in seen:
                    seen.add(m)
                    stack.append(m)
        groups.append(order_chain(members, links))
    return groups, links


def order_chain(members, links):
    """Order segments of a group from one free end to the other (if it is a chain)."""
    ends = [m for m in members if len(links[m]) == 1]
    if len(members) == 1 or not ends:
        return members
    chain = [ends[0]]
    while len(chain) < len(members):
        nxt = [m for m in links[chain[-1]] if m not in chain]
        if not nxt:
            break
        chain.append(nxt[0])
    return chain if len(chain) == len(members) else members


def corner_point(a, b):
    """Corner of a horizontal and a vertical segment."""
    h, v = (a, b) if is_horizontal(a) else (b, a)
    return (v[0][0], h[0][1])


def build_polyline(chain, segments, closed):
    segs = [segments[k] for k in chain]
    if len(segs) == 1:
        return list(segs[0])
    corners = [corner_point(segs[k], segs[k + 1]) for k in range(len(segs) - 1)]
    if closed:
        return corners + [corner_point(segs[-1], segs[0])]
    # Free ends: the end of the first/last segment farthest from its corner
    first = max(segs[0], key=lambda p: distance(p, corners[0]))
    last = max(segs[-1], key=lambda p: distance(p, corners[-1]))
    return [first] + corners + [last]


def classify(polyline, chain, links):
    is_path = all(len(links[k]) <= 2 for k in chain)
    is_closed = is_path and len(chain) >= 4 and all(len(links[k]) == 2 for k in chain)
    n = len(chain)

    if is_closed:
        return "closed", f"closed link ({n} sides)"
    if not is_path:
        return "other", f"other ({n} segments, branched)"
    if n == 1:
        (_, y1), (_, y2) = polyline
        return "straight", "straight (horizontal)" if y1 == y2 else "straight (vertical)"
    if n == 2:
        start, corner, end = polyline
        vert = start if start[0] == corner[0] else end
        horz = end if vert is start else start
        side_v = "top" if vert[1] > corner[1] else "bottom"
        side_h = "left" if horz[0] > corner[0] else "right"
        return "L", f"L (corner at {side_v}-{side_h})"
    if n == 3:
        p0, c1, c2, p3 = polyline
        # Legs pointing the same way -> U, opposite ways -> Z (crank)
        leg1 = np.sign(np.subtract(p0, c1))
        leg2 = np.sign(np.subtract(p3, c2))
        if not np.array_equal(leg1, leg2):
            return "Z", "Z / crank"
        direction = {(0, -1): "opens up", (0, 1): "opens down",
                     (-1, 0): "opens left", (1, 0): "opens right"}[tuple(int(v) for v in leg1)]
        return "U", f"U ({direction})"
    return "other", f"other ({n} segments)"


def detect_shapes(img, roi=None):
    h_mask, v_mask = black_line_masks(img)
    if roi is not None:
        x, y, w, h = roi
        keep = np.zeros_like(h_mask)
        keep[y:y + h, x:x + w] = 255
        h_mask = cv2.bitwise_and(h_mask, keep)
        v_mask = cv2.bitwise_and(v_mask, keep)
    mask = cv2.bitwise_or(h_mask, v_mask)

    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    shapes = []
    for i in range(1, n):
        x, y, w, h, _ = stats[i]
        if max(w, h) < MIN_SEGMENT:
            continue
        component = labels[y:y + h, x:x + w] == i
        segments = split_t_junctions(extract_segments(
            np.where(component, h_mask[y:y + h, x:x + w], 0).astype(np.uint8),
            np.where(component, v_mask[y:y + h, x:x + w], 0).astype(np.uint8), x, y))
        if not segments:
            continue

        groups, links = group_segments(segments)
        for chain in groups:
            closed = len(chain) >= 4 and all(len(links[k]) == 2 for k in chain)
            polyline = build_polyline(chain, segments, closed)
            kind, name = classify(polyline, chain, links)
            shapes.append({
                "type": kind,
                "name": name,
                "polyline": [(int(px), int(py)) for px, py in polyline],
                "closed": closed,
            })

    shapes.sort(key=lambda s: (min(p[0] for p in s["polyline"]), min(p[1] for p in s["polyline"])))
    return shapes


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("image", nargs="?", default="image.png")
    parser.add_argument("--dpi", type=int, default=BASE_DPI,
                        help=f"DPI the PDF was rendered at (default {BASE_DPI})")
    parser.add_argument("--roi", nargs=4, type=int, metavar=("X", "Y", "W", "H"),
                        help="only look inside this rectangle")
    args = parser.parse_args()
    scale_to_dpi(args.dpi)

    img = cv2.imread(args.image)
    if img is None:
        sys.exit(f"Could not read image: {args.image}")

    shapes = detect_shapes(img, args.roi)
    print(f"Found {len(shapes)} shape(s)")

    output = img.copy()
    only_shapes = np.full_like(img, 255)
    for n, s in enumerate(shapes, 1):
        color = COLORS[s["type"]]
        print(f"  #{n}: {s['name']}, points={s['polyline']}")
        pts = np.array(s["polyline"], np.int32)
        for canvas in (output, only_shapes):
            cv2.polylines(canvas, [pts], s["closed"], color, 2)
            x, y = pts.min(axis=0)
            cv2.putText(canvas, f"#{n}", (int(x), int(y) - 3),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1, cv2.LINE_AA)

    cv2.imwrite("shapes_detected.png", output)
    cv2.imwrite("shapes_only.png", only_shapes)
    print("Saved: shapes_detected.png, shapes_only.png")


if __name__ == "__main__":
    main()
