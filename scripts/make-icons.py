#!/usr/bin/env python3
"""Generate the extension icons — candidate F, "Hold".

A buffer with a fill level: the meter the popup already shows. What this
extension does is spend the page's memory to keep bytes reachable, so the mark
is the container and how full it is. One script so the SVG and the PNGs cannot
drift apart; both are drawn from the geometry below. Run it after changing
anything here:

    python3 scripts/make-icons.py     # needs Pillow

Four decisions worth keeping:

* **The level spans the cavity and meets the floor.** The candidate sheet drew it
  inset on all four sides, which reads as a block sitting in a box. A level has to
  touch the walls it is measured against; the gap is at the top only, and that gap
  is the whole idea.

* **Half full, exactly.** FILL_TOP is 32, which is both the grid's centre line and
  the midpoint of the cavity — and it is what keeps the boundary landing on a whole
  pixel at 16. At 42% the boundary row came out half-lit and the level went mushy.
  Change FILL_TOP and check the 16px alpha map before believing it.

* **One geometry at every size, no small-size variant.** The first cut thickened
  the wall to 9.5 for 16 and 32 on the theory that 6.5 (1.6px at 16) would turn
  grey. It does not — supersampling by 8 and downsampling LANCZOS holds the wall
  fine — and the thick wall was actively worse: it ate the cavity until the mark
  read as a notched block rather than a container with air in it. Widening the
  footprint to 56x52 and leaving the wall thin is what made 16px work.

* **The PNGs are one flat violet, not two-tone.** The mark was drawn ink-ring +
  accent-fill so it could invert with the theme, but a PNG cannot do that. In one
  colour the silhouette still reads correctly — open ring above, solid block below
  — because the level fuses with the wall on three sides and only its top edge is
  free. The accent is #8b5cf6, the midpoint of the popup's own #7c3aed/#a78bfa
  pair: the dark end vanishes on a dark toolbar and the light end washes out on a
  light one, so neither works alone.
"""

from PIL import Image, ImageDraw

OUT = "public/assets"
SS = 8  # supersample factor; downsampled with LANCZOS for clean edges

ACCENT = (139, 92, 246)   # #8b5cf6

# Geometry on a 64 grid, matching refs/icons.html. Fractions of the tile would
# be less readable here: the mark was drawn on this grid, so it stays on it.
GRID = 64.0
OUTER = (4, 6, 60, 58)    # x0, y0, x1, y1 — the outer silhouette edge, 56x52
OUTER_RADIUS = 12
STROKE = 6.5              # centred on OUTER's path, as SVG strokes it
FILL_TOP = 32             # the grid's centre line, and the cavity's midpoint

SIZES = (16, 32, 48, 128, 512)

# The inner face of the wall: OUTER inset by the full stroke, radius shrunk to
# match. (x0, y0, x1, y1, radius) on the 64 grid.
CAVITY = (OUTER[0] + STROKE, OUTER[1] + STROKE, OUTER[2] - STROKE, OUTER[3] - STROKE,
          max(OUTER_RADIUS - STROKE, 0.0))


def png(size: int) -> None:
    px = size * SS
    scale = px / GRID

    # Painted on a fully accent-coloured field and cut out with a mask, rather
    # than drawn onto transparency: downsampling RGBA whose transparent pixels
    # are black leaves a dark fringe along every edge.
    tile = Image.new("RGB", (px, px), ACCENT)

    mask = Image.new("L", (px, px), 0)
    draw = ImageDraw.Draw(mask)

    # The wall. Pillow strokes *inward* from the box it is given, so it wants the
    # outer silhouette edge as-is. SVG centres the stroke on its path instead,
    # which is why svg() hands the same wall a box inset by half a stroke — the
    # two describe one wall from opposite sides. Insetting here as well is the
    # mistake that shipped once: it drove the wall in by another half-stroke,
    # shrank the cavity from the top, and left the PNGs 55% full against the
    # SVG's 50%.
    x0, y0, x1, y1 = OUTER
    draw.rounded_rectangle(
        (x0 * scale, y0 * scale, x1 * scale, y1 * scale),
        radius=OUTER_RADIUS * scale, outline=255, width=round(STROKE * scale),
    )

    # The level: square where it meets open air, rounded where it meets the floor.
    cx0, _, cx1, cy1, r = CAVITY
    draw.rounded_rectangle(
        (cx0 * scale, FILL_TOP * scale, cx1 * scale, cy1 * scale),
        radius=r * scale, fill=255, corners=(False, False, True, True),
    )

    tile.putalpha(mask)
    tile.resize((size, size), Image.LANCZOS).save(f"{OUT}/icon-{size}.png")


def svg() -> None:
    x0, y0, x1, y1 = OUTER
    h = STROKE / 2
    cx0, _, cx1, cy1, r = CAVITY
    accent = "#%02x%02x%02x" % ACCENT
    with open(f"{OUT}/icon.svg", "w") as fh:
        fh.write(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">\n'
            '  <!-- Hold — a buffer with a fill level. One flat violet, matching the\n'
            '       PNGs; refs/icons.html carries the two-tone version for in-app use,\n'
            '       where currentColor can follow the theme. -->\n'
            f'  <rect x="{x0 + h:g}" y="{y0 + h:g}" width="{x1 - x0 - STROKE:g}"'
            f' height="{y1 - y0 - STROKE:g}" rx="{OUTER_RADIUS - h:g}"\n'
            f'        fill="none" stroke="{accent}" stroke-width="{STROKE:g}"/>\n'
            f'  <path fill="{accent}" d="M{cx0:g} {FILL_TOP:g}H{cx1:g}V{cy1 - r:g}'
            f'a{r:g} {r:g} 0 0 1-{r:g} {r:g}H{cx0 + r:g}'
            f'a{r:g} {r:g} 0 0 1-{r:g}-{r:g}Z"/>\n'
            '</svg>\n'
        )


if __name__ == "__main__":
    for size in SIZES:
        png(size)
    svg()
    _, cy0, _, cy1, _ = CAVITY
    print(f"cavity {cy0:g}..{cy1:g}, level at {FILL_TOP:g} "
          f"= {(cy1 - FILL_TOP) / (cy1 - cy0) * 100:.1f}% full")
    print("wrote", ", ".join(f"icon-{s}.png" for s in SIZES), "and icon.svg to", OUT)
