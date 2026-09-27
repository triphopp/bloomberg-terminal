"use client";

/**
 * `ResponsiveContainer` that mounts its chart only once it scrolls near view.
 *
 * BOND opens with 16 Recharts charts of which ONE is on screen (643 px of a
 * 2,208 px page), and mounting all of them — layout, tick-text measurement,
 * the container's measure-then-render pass — was the whole cost of opening the
 * view. Until the placeholder comes within `rootMargin` of the viewport it is
 * an empty box of exactly the chart's size, so nothing below it moves; after
 * that it is a plain ResponsiveContainer and stays mounted.
 *
 * Same props as ResponsiveContainer, so a file switches with its import:
 *   import { LazyResponsiveContainer as ResponsiveContainer } from "…/ui/LazyResponsiveContainer";
 */

import { useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { ResponsiveContainer } from "recharts";

type Props = ComponentProps<typeof ResponsiveContainer>;

/** How far outside the viewport a chart starts mounting — ahead of a normal scroll. */
const ROOT_MARGIN = "400px 0px";

export function LazyResponsiveContainer(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(
    () => typeof window === "undefined" || typeof IntersectionObserver === "undefined"
  );

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: ROOT_MARGIN }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  if (visible) return <ResponsiveContainer {...props} />;

  const { width = "100%", height = "100%", minHeight, minWidth, aspect } = props;
  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        width,
        height: aspect ? undefined : height,
        minHeight,
        minWidth,
        aspectRatio: aspect ? String(aspect) : undefined,
      }}
    />
  );
}
