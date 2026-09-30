"use client";
import {
  type ChangeEvent,
  type InputHTMLAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  caretAfter,
  groupNumber,
  sameNumber,
  sanitizeNumber,
  significantBefore,
  toRawNumber,
} from "../../../lib/number-input";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string | number | null | undefined;
  /** Called like a normal input's onChange; `e.target.value` is the plain
   *  number text ("1234567.89"), never the grouped display. */
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Off by default: prices, quantities and fees are never negative. */
  allowNegative?: boolean;
};

/**
 * A number field that shows thousands separators while typing
 * ("1,234,567.89") but hands the form "1234567.89". Drop-in for
 * `<input type="number">`: same value/onChange, so the existing handlers and
 * parseFloat calls keep working. Keeps its own text so a half-typed "12." or
 * "0.0" survives a parent that stores the parsed number.
 */
export function NumInput({ value, onChange, allowNegative = false, min, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const [raw, setRaw] = useState(() => toRawNumber(value));
  const noNegative = !allowNegative || (min !== undefined && Number(min) >= 0);

  // The parent changed the value itself (form cleared, slip filled): follow it.
  useEffect(() => {
    setRaw((cur) => (sameNumber(cur, value) ? cur : toRawNumber(value)));
  }, [value]);

  const display = groupNumber(raw);
  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current === null || !el || document.activeElement !== el) return;
    const pos = caretAfter(display, caret.current);
    el.setSelectionRange(pos, pos);
    caret.current = null;
  });

  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const typed = el.value;
    const next = sanitizeNumber(typed, !noNegative);
    caret.current = significantBefore(typed, el.selectionStart ?? typed.length);
    if (next === raw) {
      // Nothing that counts changed (a letter, a second "."): put the display back.
      el.value = display;
      const pos = caretAfter(
        display,
        Math.min(caret.current, significantBefore(display, display.length))
      );
      el.setSelectionRange(pos, pos);
      caret.current = null;
      return;
    }
    setRaw(next);
    el.value = next; // the handler reads the plain number
    onChange(e);
  };

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode={noNegative ? "decimal" : "text"}
      autoComplete="off"
      spellCheck={false}
      value={display}
      onChange={handle}
    />
  );
}
