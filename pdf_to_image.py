"""Convert every page of a PDF to a high-resolution image.

Usage:
    python pdf_to_image.py [pdf_path] [--dpi 600] [--out pdf_images] [--format png] [--antialias]

Pages are saved as <out>/<pdf name>_page_<n>.<format>.

CAD drawings use hairlines (zero-width lines), which are always drawn 1 px
wide whatever the DPI. With anti-aliasing they come out as faint gray,
broken lines, so it is off by default: lines stay solid black and keep their
real colors (e.g. dashed lines stay gray), which is what detect_shapes.py needs.
"""
import argparse
import os
import subprocess
import sys

from pdf2image import pdfinfo_from_path

FORMAT_FLAGS = {
    "png": ["-png"],
    "jpg": ["-jpeg", "-jpegopt", "quality=95"],
    "tiff": ["-tiff"],
}


def pdf_to_images(pdf_path, out_dir="pdf_images", dpi=600, fmt="png", antialias=False):
    os.makedirs(out_dir, exist_ok=True)
    name = os.path.splitext(os.path.basename(pdf_path))[0]
    pages = pdfinfo_from_path(pdf_path)["Pages"]
    aa = "yes" if antialias else "no"

    saved = []
    # Render one page at a time so large PDFs at high DPI don't run out of memory
    for n in range(1, pages + 1):
        prefix = os.path.join(out_dir, f"{name}_page_{n}")
        subprocess.run(
            ["pdftoppm", "-r", str(dpi), "-f", str(n), "-l", str(n), "-singlefile",
             "-aa", aa, "-aaVector", aa, *FORMAT_FLAGS[fmt], pdf_path, prefix],
            check=True,
        )
        ext = "tif" if fmt == "tiff" else fmt
        path = f"{prefix}.{ext}"
        print(f"Saved: {path}")
        saved.append(path)
    return saved


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", nargs="?", default="drawing.pdf")
    parser.add_argument("--dpi", type=int, default=600,
                        help="resolution; higher = sharper and bigger (default 600)")
    parser.add_argument("--out", default="pdf_images", help="output folder")
    parser.add_argument("--format", choices=["png", "jpg", "tiff"], default="png")
    parser.add_argument("--antialias", action="store_true",
                        help="smooth edges (looks nicer, but thin lines turn faint gray)")
    args = parser.parse_args()

    if not os.path.isfile(args.pdf):
        sys.exit(f"PDF not found: {args.pdf}")
    pdf_to_images(args.pdf, args.out, args.dpi, args.format, args.antialias)


if __name__ == "__main__":
    main()
