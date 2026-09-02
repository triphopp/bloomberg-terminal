/**
 * Icons for the event rail, drawn straight onto the chart canvas.
 *
 * The rail lives on the chart's own canvas, so a React icon component cannot be
 * used there — these are the same shapes expressed as SVG path data, stroked
 * with `Path2D`. The paths are authored on lucide's 24×24 grid so the DOM side
 * of the UI (the detail popover) can render the matching `lucide-react` icon and
 * the two stay recognisably the same mark.
 *
 * Everything here is deliberately low-detail. A chip on the rail is ~11px
 * across; an icon that carries its meaning in interior detail (a clock face
 * with two hands, a dollar sign inside a circle) turns into a grey blob at that
 * size, which is worse than the text glyph it replaced. Each mark below reads
 * from its silhouette alone.
 */

export type EventIconName = "cash" | "arrowUp" | "arrowDown" | "clock" | "split";

/**
 * Path data per icon, on a 24×24 grid, stroked (never filled).
 *
 * `arrowUp` / `arrowDown` are lucide's trending-up / trending-down; `split` is
 * lucide's split. `cash` and `clock` are trimmed for legibility at chip size.
 */
const ICON_PATHS: Record<EventIconName, string[]> = {
  // A banknote: outline plus one centre mark. Reads as money from the outline
  // alone, which a `$` glyph inside a circle does not at 11px.
  cash: [
    "M3 7 H21 A2 2 0 0 1 23 9 V15 A2 2 0 0 1 21 17 H3 A2 2 0 0 1 1 15 V9 A2 2 0 0 1 3 7 Z",
    "M12 10.5 V13.5",
  ],
  arrowUp: ["M22 7 L13.5 15.5 L8.5 10.5 L2 17", "M16 7 H22 V13"],
  arrowDown: ["M22 17 L13.5 8.5 L8.5 13.5 L2 7", "M16 17 H22 V11"],
  // One hand, not two. At chip size a minute hand and an hour hand merge into a
  // smudge, and the shape stops reading as a clock at all.
  clock: ["M12 3 A9 9 0 1 1 11.99 3 Z", "M12 7 V12 L16 14"],
  split: ["M16 3 H21 V8", "M8 3 H3 V8", "M12 22 V13.7 A4 4 0 0 0 10.83 10.83 L3 3", "M15 9 L21 3"],
};

/** Cached so the browser parses each path once, not on every frame. */
const cache = new Map<EventIconName, Path2D[]>();

function paths(name: EventIconName): Path2D[] {
  let built = cache.get(name);
  if (!built) {
    built = ICON_PATHS[name].map((d) => new Path2D(d));
    cache.set(name, built);
  }
  return built;
}

/**
 * Stroke an icon centred on (cx, cy), `size` pixels across.
 *
 * The stroke is set in grid units and scaled with the path, so it lands at
 * roughly 1.1 device-independent pixels at the sizes the rail uses — thin
 * enough to stay a line, thick enough not to disappear on a light background.
 */
export function drawEventIcon(
  ctx: CanvasRenderingContext2D,
  name: EventIconName,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  const scale = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Icons are never filled: a filled mark at this size loses its silhouette
  // against the chip's own tinted background.
  for (const path of paths(name)) ctx.stroke(path);
  ctx.restore();
}
