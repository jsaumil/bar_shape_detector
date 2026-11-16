"""Draw a CAD-style dimension (straight-part length in mm) on every bar of a vector PDF.

Each straight part of each bar gets a dimension line parallel to it, on the
outer side of the bar, with extension lines, arrowheads and its real length,
like the 6825 / 446 dimensions in a CAD drawing. Lengths are the straight parts
only (bends excluded), using the drawing scale worked out by shape_lengths.py.

Usage:
    python dimension_bars.py [pdf_path] [--page 1] [--dpi 400] [--roi x0 y0 x1 y1]

Outputs:
    bar_dimensions.pdf       - the drawing with the dimensions added (vector, zoomable)
    bar_dimensions.png       - the same as an image
    bar_dimensions_only.pdf  - only the bars and their dimensions
    bar_dimensions_only.png  - the same as an image
"""
import argparse
import math
import sys

import pymupdf

from detect_shapes_pdf import detect_shapes
from shape_lengths import measure, read_dimensions, scale_groups

DIM_COLOR = (0.85, 0.0, 0.85)   # magenta, stands out from the drawing's own colors
BAR_COLOR = (0.0, 0.0, 0.0)

# Sizes in PDF points (the drawing's own dimension text is about 1.4 pt high)
FONT_SIZE = 1.1
LINE_WIDTH = 0.06
FIRST_OFFSET = 1.2   # distance from the bar to its dimension line
OFFSET_STEP = 1.6    # extra distance when the spot is already taken
EXT_GAP = 0.25       # gap between the bar and the start of an extension line
EXT_OVERSHOOT = 0.4  # extension line continues this far past the dimension line
ARROW_LENGTH = 0.6
ARROW_HALF_WIDTH = 0.13
TEXT_GAP = 0.25      # gap between dimension line and its text

# Straight parts shorter than this (mm) are not dimensioned
MIN_DIMENSION_MM = 50


def add(p, v, k=1.0):
    return (p[0] + v[0] * k, p[1] + v[1] * k)


def outward_normal(a, b, shape):
    """Unit normal of segment a-b pointing away from the rest of the shape."""
    length = math.dist(a, b)
    u = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
    n = (-u[1], u[0])
    xs = [p[0] for p in shape["points"]]
    ys = [p[1] for p in shape["points"]]
    centre = (sum(xs) / len(xs), sum(ys) / len(ys))
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    side = (mid[0] - centre[0]) * n[0] + (mid[1] - centre[1]) * n[1]
    if abs(side) < 1e-6:
        # Straight bar: put the dimension above it (or left of it if vertical)
        side = -(n[1] if abs(n[1]) > abs(n[0]) else n[0])
    return u, (n if side > 0 else (-n[0], -n[1]))


def text_layout(text, mid, n, u):
    """Return (insert point, rotate, bounding rect) for text beside the dimension line."""
    width = pymupdf.get_text_length(text, fontname="helv", fontsize=FONT_SIZE)
    height = FONT_SIZE * 0.75
    vertical = abs(u[1]) > abs(u[0])
    if not vertical:
        x = mid[0] - width / 2
        if n[1] <= 0:   # text above the line
            y = mid[1] - TEXT_GAP
            rect = pymupdf.Rect(x, y - height, x + width, y)
        else:           # text below the line
            y = mid[1] + TEXT_GAP + height
            rect = pymupdf.Rect(x, y - height, x + width, y)
        return pymupdf.Point(x, y), 0, rect
    # Vertical: text reads bottom to top, like CAD
    y = mid[1] + width / 2
    if n[0] <= 0:       # text left of the line
        x = mid[0] - TEXT_GAP
        rect = pymupdf.Rect(x - height, y - width, x, y)
    else:               # text right of the line
        x = mid[0] + TEXT_GAP + height
        rect = pymupdf.Rect(x - height, y - width, x, y)
    return pymupdf.Point(x, y), 90, rect


def plan_dimensions(shapes):
    """Work out where every dimension goes, moving it out until it is free."""
    placed, plans = [], []
    for s in shapes:
        if s["type"] == "closed":
            continue  # filled dots and similar outlines, not bars
        for (a, b), mm in zip(s["straight_ends"], s["straight_mm"]):
            if mm < MIN_DIMENSION_MM:
                continue
            u, n = outward_normal(a, b, s)
            text = str(mm)
            offset = FIRST_OFFSET
            while True:
                da, db = add(a, n, offset), add(b, n, offset)
                mid = ((da[0] + db[0]) / 2, (da[1] + db[1]) / 2)
                point, rotate, text_rect = text_layout(text, mid, n, u)
                line_rect = pymupdf.Rect(min(da[0], db[0]), min(da[1], db[1]),
                                         max(da[0], db[0]), max(da[1], db[1]))
                line_rect = line_rect + (-0.2, -0.2, 0.2, 0.2)
                box = line_rect | text_rect
                if not any(box.intersects(r) for r in placed) or offset > 20 * OFFSET_STEP:
                    break
                offset += OFFSET_STEP
            placed.append(box)
            plans.append({"a": a, "b": b, "da": da, "db": db, "u": u, "n": n,
                          "text": text, "point": point, "rotate": rotate})
    return plans


def draw_dimensions(page, plans):
    shape = page.new_shape()
    for d in plans:
        a, b, da, db, u, n = d["a"], d["b"], d["da"], d["db"], d["u"], d["n"]
        # Extension lines from the bar ends past the dimension line
        for p, q in ((a, da), (b, db)):
            shape.draw_line(add(p, n, EXT_GAP), add(q, n, EXT_OVERSHOOT))
        shape.draw_line(da, db)
        shape.finish(color=DIM_COLOR, width=LINE_WIDTH)
        # Arrowheads pointing at the extension lines
        for tip, back in ((da, u), (db, (-u[0], -u[1]))):
            base = add(tip, back, ARROW_LENGTH)
            shape.draw_polyline([tip, add(base, n, ARROW_HALF_WIDTH),
                                 add(base, n, -ARROW_HALF_WIDTH), tip])
            shape.finish(color=DIM_COLOR, fill=DIM_COLOR, width=0.01, closePath=True)
        shape.insert_text(d["point"], d["text"], fontsize=FONT_SIZE, fontname="helv",
                          color=DIM_COLOR, rotate=d["rotate"])
    shape.commit()


def draw_bars(page, shapes):
    shape = page.new_shape()
    for s in shapes:
        if s["type"] == "closed":
            continue
        pts = s["points"] + (s["points"][:1] if s["closed"] else [])
        shape.draw_polyline(pts)
        shape.finish(color=BAR_COLOR, width=0.12, closePath=False)
    shape.commit()


def save(doc, page, name, dpi, roi):
    doc.save(f"{name}.pdf", garbage=3, deflate=True)
    page.get_pixmap(dpi=dpi, clip=roi).save(f"{name}.png")
    print(f"Saved: {name}.pdf, {name}.png")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", nargs="?", default="drawing.pdf")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--dpi", type=int, default=400, help="resolution of the PNG images")
    parser.add_argument("--roi", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"),
                        help="only dimension bars inside this rectangle (PDF points)")
    args = parser.parse_args()

    try:
        src = pymupdf.open(args.pdf)
        page = src[args.page - 1]
    except Exception as e:
        sys.exit(f"Could not open PDF: {e}")
    roi = pymupdf.Rect(*args.roi) if args.roi else None

    dims = read_dimensions(page)
    groups = scale_groups(dims)
    if not groups:
        sys.exit("No readable dimensions found, so the drawing scale is unknown.")
    shapes = detect_shapes(page, roi)
    measure(shapes, dims, groups[0]["scale"])
    print(f"Drawing scale: {groups[0]['scale']:.3f} mm per pt; bars: "
          f"{sum(s['type'] != 'closed' for s in shapes)}")

    plans = plan_dimensions(shapes)
    print(f"Dimensions drawn: {len(plans)}")

    # 1. The drawing with dimensions added
    out = pymupdf.open()
    out.insert_pdf(src, from_page=args.page - 1, to_page=args.page - 1)
    draw_dimensions(out[0], plans)
    save(out, out[0], "bar_dimensions", args.dpi, roi)

    # 2. Only the bars and their dimensions
    only = pymupdf.open()
    blank = only.new_page(width=page.rect.width, height=page.rect.height)
    draw_bars(blank, shapes)
    draw_dimensions(blank, plans)
    save(only, blank, "bar_dimensions_only", args.dpi, roi)


if __name__ == "__main__":
    main()
