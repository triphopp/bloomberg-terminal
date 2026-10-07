"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ArrowUp,
  Cpu,
  History,
  ImagePlus,
  MessageCircleDashed,
  MessageSquare,
  Square,
  SquarePen,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isDarkModeAtom } from "../atoms";
import { bloombergColors } from "../lib/theme-config";
import { AnswerBody, MathText } from "./ask-answer";
import { AskHistory, AskRecent } from "./ask-history";
import { AskSettings } from "./ask-settings";
import { ASK_IMAGE_ACCEPT, MAX_ASK_IMAGES, imageFiles, toAskImage } from "./images";
import {
  askArchiveNoteAtom,
  askChoiceAtom,
  askColumnShownAtom,
  askDraftImagesAtom,
  askDraftTextAtom,
  askDrawerShownAtom,
  askFocusSignalAtom,
  askHistoryOpenAtom,
  askHostCountAtom,
  askOpenAtom,
  askPageContextAtom,
  askSettingsOpenAtom,
  askTemporaryAtom,
} from "./store";
import type { AskMessage, AskPageContext, AskToolCall, ThemeColors } from "./types";
import { useAskConversation, useAskPersistence, useAskStatus } from "./useAskConversation";

function useColors(): ThemeColors {
  return useAtomValue(isDarkModeAtom) ? bloombergColors.dark : bloombergColors.light;
}

const EXAMPLES = ["สรุปข่าว watchlist วันนี้", "ตลาดสหรัฐวันนี้ขยับเพราะอะไร", "สัปดาห์นี้มีตัวเลขเศรษฐกิจอะไรบ้าง"];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The chat column's own surface: the page background with a little of the text
 * colour mixed in — a shade lighter than the news list on the dark theme, a
 * shade darker on the light one, so the eye can tell the two lanes apart.
 */
function tint(colors: ThemeColors, percent: number): string {
  return `color-mix(in srgb, ${colors.text} ${percent}%, ${colors.background})`;
}

function toolCounts(tools: AskToolCall[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
  return [...counts];
}

/** HH:mm of today, or "5 Oct 14:02" — an answer is a reading of the moment it was asked. */
function askedAt(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

/** Text to the clipboard; the fallback is for a page not opened on localhost / https. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement("textarea");
    box.value = text;
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    return ok;
  }
}

// memo: only the answer being streamed changes; the ones above it keep their
// message object and are not parsed and rendered again on every batch of tokens.
// `onAgain` is given to the last answer only, for the same reason.
const Answer = memo(function Answer({
  msg,
  colors,
  onAgain,
}: { msg: AskMessage; colors: ThemeColors; onAgain?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      {/* What was read to produce the answer — one entry per kind, details on hover. */}
      {msg.tools && msg.tools.length > 0 && (
        <div
          className="flex flex-wrap gap-x-2 text-[9px]"
          style={{ color: colors.textSecondary }}
          title={msg.tools.map((t) => `${t.label} ${t.detail}`.trim()).join("\n")}
        >
          {toolCounts(msg.tools).map(([label, n]) => (
            <span key={label}>
              <span style={{ color: colors.accent }}>{label}</span>
              {n > 1 && ` ×${n}`}
            </span>
          ))}
          {/* So it is never a surprise what left the machine. */}
          {msg.private && (
            <span
              style={{ color: "#ffc107" }}
              title="คำตอบนี้อ่านข้อมูลส่วนตัว (พอร์ต / thesis / คำถาม / note) — ข้อมูลที่อ่านถูกส่งให้ provider ของ model และจากนี้ในบทสนทนานี้ ASK จะเปิดได้เฉพาะลิงก์ที่เครื่องมือคืนมาหรือที่คุณพิมพ์เอง"
            >
              PRIVATE
            </span>
          )}
        </div>
      )}

      {msg.content && <AnswerBody text={msg.content} pending={msg.pending} colors={colors} />}

      {msg.pending && msg.status && (
        <div className="text-[9px] animate-pulse" style={{ color: colors.textSecondary }}>
          {msg.status}…
        </div>
      )}

      {msg.error && (
        <div className="text-[10px]" style={{ color: "#ef5350" }}>
          {msg.error}
        </div>
      )}

      {!msg.pending && (msg.content || onAgain) && (
        <div
          className="flex gap-3 pt-0.5 text-[9px] tracking-widest"
          style={{ color: colors.textSecondary }}
        >
          {msg.content && (
            <button
              type="button"
              className="hover:opacity-70"
              title="คัดลอกคำตอบ (ข้อความตามที่ model เขียน)"
              onClick={async () => {
                setCopied(await copyText(msg.content));
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "COPIED" : "COPY"}
            </button>
          )}
          {onAgain && (
            <button
              type="button"
              className="hover:opacity-70"
              title="ถามคำถามล่าสุดอีกครั้ง — คำตอบนี้จะถูกแทนที่"
              onClick={onAgain}
            >
              ASK AGAIN
            </button>
          )}
        </div>
      )}

      {msg.sources && msg.sources.length > 0 && (
        <div className="flex flex-col gap-0.5 pt-1 text-[9px]">
          {/* The pages read_page opened for this answer — not every source it cites. */}
          <span className="tracking-widest" style={{ color: colors.textSecondary }}>
            PAGES READ
          </span>
          {msg.sources.map((s, i) => (
            <a
              key={s.url}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate hover:opacity-70"
              style={{ color: colors.text }}
              title={s.url}
            >
              <span style={{ color: colors.textSecondary }}>{i + 1}. </span>
              {s.title}
              <span style={{ color: colors.textSecondary }}> · {hostOf(s.url)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
});

/**
 * The whole of ASK for one surface: conversation, model choice, status, open
 * flag. All of it is in ask/store.ts, so every caller gets the same thing.
 */
function useAsk() {
  // Which provider / model answers (MODEL ▸ panel). The status is the status
  // of that choice, so `ready` follows it.
  const [choice, setChoice] = useAtom(askChoiceAtom);
  const [settingsOpen, setSettingsOpen] = useAtom(askSettingsOpenAtom);
  // HISTORY and MODEL share the space under the header: opening one closes the other.
  const [historyOpen, setHistoryOpenRaw] = useAtom(askHistoryOpenAtom);
  const setHistoryOpen = (open: boolean) => {
    setHistoryOpenRaw(open);
    if (open) setSettingsOpen(false);
  };
  const openSettings = (open: boolean) => {
    setSettingsOpen(open);
    if (open) setHistoryOpenRaw(false);
  };
  /** The last save to the conversation's file failed, and why. */
  const archiveNote = useAtomValue(askArchiveNoteAtom);
  /** Temporary chat: this conversation is not saved (store.ts). */
  const temporary = useAtomValue(askTemporaryAtom);
  const status = useAskStatus(choice);
  const conversation = useAskConversation();
  const [open, setOpen] = useAtom(askOpenAtom);
  // The header's ASK icon / `c`: the caret goes to whichever box is on screen.
  const focusSignal = useAtomValue(askFocusSignalAtom);

  const attach = useAskAttach();

  const ready = status.data?.configured === true;
  /** Sends the text with the pictures in the tray. */
  const submit = (text: string) => {
    if (!ready || conversation.busy || (!text.trim() && attach.images.length === 0)) return false;
    setOpen(true);
    setHistoryOpenRaw(false); // the answer is read on CHAT
    void conversation.ask(text, attach.images);
    attach.clear();
    return true;
  };

  return {
    ...conversation,
    status,
    ready,
    open,
    setOpen,
    choice,
    setChoice,
    settingsOpen,
    setSettingsOpen: openSettings,
    historyOpen,
    setHistoryOpen,
    archiveNote,
    temporary,
    focusSignal,
    submit,
    attach,
  };
}

/**
 * The picture tray: what paste, drop and the attach button add to, and what
 * the next question takes with it. Handlers are spread onto a question box
 * (`onPaste`) or a surface (`drop`).
 */
function useAskAttach() {
  const [images, setImages] = useAtom(askDraftImagesAtom);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const add = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_ASK_IMAGES - images.length;
    setNote(files.length > room ? `แนบได้ไม่เกิน ${MAX_ASK_IMAGES} รูปต่อคำถาม` : null);
    const read = await Promise.allSettled(files.slice(0, Math.max(0, room)).map(toAskImage));
    const ok = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (ok.length < read.length) setNote("อ่านรูปไม่ได้ — ใช้ PNG, JPEG, WebP หรือ GIF");
    if (ok.length) setImages((prev) => [...prev, ...ok].slice(0, MAX_ASK_IMAGES));
  };

  return {
    images,
    note,
    dragging,
    add,
    remove: (index: number) => {
      setNote(null);
      setImages((prev) => prev.filter((_, i) => i !== index));
    },
    clear: () => {
      setNote(null);
      setImages([]);
    },
    /** Ctrl+V with a picture on the clipboard; text pastes as usual. */
    onPaste: (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void add(files);
    },
    /** Spread onto the element pictures may be dropped on. */
    drop: {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        const files = imageFiles(e.dataTransfer);
        if (files.length) void add(files);
        else setNote("ไฟล์ที่ปล่อยไม่ใช่รูป — ใช้ PNG, JPEG, WebP หรือ GIF");
      },
    },
  };
}

type AskAttach = ReturnType<typeof useAskAttach>;

/** The attach icon: opens the file picker. Paste and drop need no button. */
function AttachButton({
  colors,
  attach,
  disabled,
}: { colors: ThemeColors; attach: AskAttach; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const full = attach.images.length >= MAX_ASK_IMAGES;
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ASK_IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void attach.add([...(e.target.files ?? [])]);
          e.target.value = ""; // the same file can be picked again
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || full}
        className="shrink-0 hover:opacity-70 disabled:opacity-30"
        style={{ color: attach.images.length ? colors.accent : colors.textSecondary }}
        title={
          full
            ? `แนบครบ ${MAX_ASK_IMAGES} รูปแล้ว`
            : "แนบรูป — หรือวาง (Ctrl+V) / ลากรูปมาปล่อย · model ต้องอ่านรูปได้"
        }
        aria-label="Attach image"
      >
        <ImagePlus className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

/** Pictures in the tray, each with its ✕. Renders nothing when the tray is empty. */
function AttachTray({ colors, attach }: { colors: ThemeColors; attach: AskAttach }) {
  if (!attach.images.length && !attach.note) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[9px]">
      {attach.images.map((src, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a short list, edited by index
        <span key={i} className="relative">
          <img
            src={src}
            alt={`attachment ${i + 1}`}
            className="h-10 w-auto max-w-[80px] object-cover border"
            style={{ borderColor: colors.border }}
          />
          <button
            type="button"
            onClick={() => attach.remove(i)}
            className="absolute -top-1 -right-1 px-0.5 leading-none hover:opacity-70"
            style={{ color: colors.text, backgroundColor: colors.background }}
            title="เอารูปนี้ออก"
            aria-label={`Remove attachment ${i + 1}`}
            data-frame
          >
            ✕
          </button>
        </span>
      ))}
      {attach.note && <span style={{ color: "#ffc107" }}>{attach.note}</span>}
    </div>
  );
}

type AskController = ReturnType<typeof useAsk>;

interface AskProps {
  colors: ThemeColors;
  ask: AskController;
}

const ICON = "h-3.5 w-3.5";

/** Send, or stop while an answer is coming — one slot, so the row does not shift. */
function SendButton({ colors, ask, empty }: AskProps & { empty: boolean }) {
  if (ask.busy) {
    return (
      <button
        type="button"
        onClick={ask.stop}
        className="shrink-0 hover:opacity-70"
        style={{ color: "#ef5350" }}
        title="หยุดคำตอบ"
        aria-label="Stop"
      >
        <Square className={ICON} fill="currentColor" />
      </button>
    );
  }
  return (
    <button
      type="submit"
      disabled={!ask.ready || empty}
      className="shrink-0 hover:opacity-70 disabled:opacity-30"
      style={{ color: colors.accent }}
      title="ส่ง (Enter)"
      aria-label="Send"
    >
      <ArrowUp className={ICON} strokeWidth={2.5} />
    </button>
  );
}

/** Temporary chat on / off. */
function TemporaryButton({ colors, ask }: AskProps) {
  const filled = ask.messages.length > 0;
  return (
    <button
      type="button"
      aria-pressed={ask.temporary}
      onClick={() => {
        ask.setTemporary(!ask.temporary);
        ask.setHistoryOpen(false);
      }}
      className="shrink-0 hover:opacity-70"
      style={{ color: ask.temporary ? colors.accent : colors.textSecondary }}
      title={
        ask.temporary
          ? filled
            ? "แชตชั่วคราว (เปิดอยู่) — กดเพื่อเก็บบทสนทนานี้ลง HISTORY"
            : "แชตชั่วคราว (เปิดอยู่) — กดเพื่อกลับเป็นแชตปกติ"
          : filled
            ? "เริ่มแชตชั่วคราว — ไม่บันทึกลง HISTORY · บทสนทนานี้ยังอยู่ใน HISTORY"
            : "แชตชั่วคราว — ไม่บันทึกลง HISTORY หายเมื่อเริ่มแชตใหม่หรือโหลดหน้าใหม่"
      }
      aria-label="Temporary chat"
    >
      <MessageCircleDashed className={ICON} />
    </button>
  );
}

/** Opens the provider / model panel; the choice itself is in the tooltip. */
function ModelButton({ colors, ask }: AskProps) {
  const data = ask.status.data;
  if (!data) return null;
  const web = data.web_search
    ? ` · WEB${data.search_provider ? `+${data.search_provider.toUpperCase()}` : ""}`
    : "";
  return (
    <button
      type="button"
      aria-pressed={ask.settingsOpen}
      onClick={() => ask.setSettingsOpen(!ask.settingsOpen)}
      className="shrink-0 hover:opacity-70"
      style={{
        color: !ask.ready ? "#ffc107" : ask.settingsOpen ? colors.accent : colors.textSecondary,
      }}
      title={`MODEL — ${data.provider} · ${data.model || "no model"}${web} · ${data.tools.length} tools\nกดเพื่อเลือก provider, model และ API key`}
      aria-label="Model"
    >
      <Cpu className={ICON} />
    </button>
  );
}

/**
 * Tell ASK what this page is showing, for as long as the page is mounted:
 * `useAskContext({ symbols: [symbol], note: "Stock view, OPTIONS tab" })`.
 * It travels with every question. Optional — a page that says nothing still
 * has ASK, and the model still knows which view is open.
 */
export function useAskContext(context: AskPageContext | null) {
  const setContext = useSetAtom(askPageContextAtom);
  const key = JSON.stringify(context);
  useEffect(() => {
    const value = JSON.parse(key) as AskPageContext | null;
    setContext(value);
    return () => setContext((current) => (current === value ? null : current));
  }, [key, setContext]);
}

/** True while this view's <AskColumn> is on screen — give it the room. */
export function useAskColumnShown(): boolean {
  return useAtomValue(askColumnShownAtom);
}

/**
 * The question box before a conversation is on screen: one line across the top
 * of a view that hosts an <AskColumn>. Sending opens the column, and the box
 * moves to the foot of it (AskComposer) — so asking never pushes the page
 * down, and follow-ups are typed where the answers are read. Renders nothing
 * while the column is up.
 */
export function AskBar() {
  const shown = useAtomValue(askColumnShownAtom);
  return shown ? null : <AskBarLine />;
}

function AskBarLine() {
  const colors = useColors();
  const ask = useAsk();
  const { status, ready, busy, messages, open } = ask;
  const [draft, setDraft] = useAtom(askDraftTextAtom);
  const [focused, setFocused] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const seenSignal = useRef(ask.focusSignal);
  useEffect(() => {
    if (ask.focusSignal === seenSignal.current) return;
    seenSignal.current = ask.focusSignal;
    inputRef.current?.focus();
  }, [ask.focusSignal]);

  const hint = status.isLoading
    ? "checking…"
    : status.isError
      ? "backend ไม่ตอบ — ดู logs\\backend.log"
      : !status.data?.configured
        ? `${status.data?.provider ?? "ASK"} is not configured — open MODEL (chip icon) to set an API key and model`
        : "ถามเรื่องข่าว ตลาด หุ้น หรือตัวเลขเศรษฐกิจ — ตอบจากข้อมูลล่าสุด";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (ask.submit(draft)) setDraft("");
  };
  const questions = messages.filter((m) => m.role === "user").length;

  return (
    <div
      className="shrink-0 relative border-b"
      style={{ borderColor: ask.attach.dragging ? colors.accent : colors.border }}
      data-ask-surface
      {...ask.attach.drop}
    >
      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 px-2 py-1"
        style={{ backgroundColor: colors.surface }}
      >
        <span
          className="text-[9px] font-bold tracking-widest shrink-0"
          style={{ color: colors.accent }}
        >
          ASK ▸
        </span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          onPaste={ask.attach.onPaste}
          disabled={!ready}
          maxLength={4000}
          placeholder={hint}
          aria-label="Ask a question"
          className="flex-1 min-w-0 bg-transparent text-[11px] font-mono outline-none placeholder:opacity-40 disabled:cursor-not-allowed"
          style={{ color: colors.text }}
        />

        <AttachButton colors={colors} attach={ask.attach} disabled={!ready} />
        <SendButton
          colors={colors}
          ask={ask}
          empty={!draft.trim() && ask.attach.images.length === 0}
        />
        {questions > 0 && !open && (
          <button
            type="button"
            onClick={() => ask.setOpen(true)}
            className="text-[9px] tracking-widest shrink-0 hover:opacity-70"
            style={{ color: colors.textSecondary }}
          >
            SHOW ({questions})
          </button>
        )}
        <span className="shrink-0 w-px self-stretch" style={{ backgroundColor: colors.border }} />
        <TemporaryButton colors={colors} ask={ask} />
        <button
          type="button"
          aria-pressed={ask.historyOpen}
          onClick={() => ask.setHistoryOpen(!ask.historyOpen)}
          className="shrink-0 hover:opacity-70"
          style={{
            color: ask.archiveNote
              ? "#ffc107"
              : ask.historyOpen
                ? colors.accent
                : colors.textSecondary,
          }}
          title={ask.archiveNote ?? "HISTORY — บทสนทนาที่บันทึกไว้ และที่เก็บของเครื่องนี้"}
          aria-label="History"
        >
          <History className={ICON} />
        </button>
        <ModelButton colors={colors} ask={ask} />
      </form>

      {(ask.attach.images.length > 0 || ask.attach.note) && (
        <div className="px-2 pb-1" style={{ backgroundColor: colors.surface }}>
          <AttachTray colors={colors} attach={ask.attach} />
        </div>
      )}

      {ask.settingsOpen && status.data && (
        <div className="absolute left-0 right-0 top-full z-30">
          <AskSettings
            colors={colors}
            status={status.data}
            choice={ask.choice}
            onChoose={ask.setChoice}
            onClose={() => ask.setSettingsOpen(false)}
          />
        </div>
      )}

      {ask.historyOpen && (
        <div className="absolute left-0 right-0 top-full z-30">
          <AskHistory
            colors={colors}
            busy={busy}
            onOpen={(id, saved) => {
              ask.openSaved(id, saved);
              ask.setOpen(true);
            }}
            onClose={() => ask.setHistoryOpen(false)}
            onDeletedCurrent={ask.clear}
          />
        </div>
      )}

      {/* Starters float over the tab while the empty box has focus — no row of their own. */}
      {ready && focused && !draft && questions === 0 && !ask.settingsOpen && !ask.historyOpen && (
        <div
          className="absolute left-0 right-0 top-full z-20 flex flex-wrap gap-x-4 gap-y-0.5 px-2 py-1 border-b text-[9px]"
          style={{ backgroundColor: colors.surface, borderColor: colors.border }}
        >
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              // mousedown, not click: the blur that hides this row fires first otherwise
              onMouseDown={(e) => {
                e.preventDefault();
                ask.submit(ex);
              }}
              className="hover:opacity-70"
              style={{ color: colors.textSecondary }}
            >
              › {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The conversation as a column of the view it is placed in — the last child of
 * the view's flex row, with an <AskBar /> above the content. Appears with the
 * first question (useAskColumnShown() tells the view to make room). While one
 * is mounted the shell's drawer stays away: the conversation is on the page.
 */
export function AskColumn() {
  const setHosts = useSetAtom(askHostCountAtom);
  useEffect(() => {
    setHosts((n) => n + 1);
    return () => setHosts((n) => n - 1);
  }, [setHosts]);
  const shown = useAtomValue(askColumnShownAtom);
  return shown ? <AskAnswers /> : null;
}

/**
 * Mounted once, in the shell (layout/bloomberg-terminal.tsx): the drawer over
 * the right edge of every view that has no <AskColumn> of its own (header
 * icon / `c`, Esc closes). An overlay, not a column — the view under it keeps
 * its layout. This is what makes ASK available on a page that never mentions it.
 */
export function AskDock() {
  // The one mount that is always there — so it is also what keeps the
  // conversation across a reload, whichever surface shows it.
  useAskPersistence();
  const shown = useAtomValue(askDrawerShownAtom);
  return shown ? <AskAnswers overlay /> : null;
}

/**
 * The conversation itself. Full height, so a long answer scrolls in its own
 * lane. `overlay` is the drawer: on screen before the first question, so it
 * carries the starters too. Holds useAsk() itself so streamed tokens re-render
 * this column and not the view around it.
 */
function AskAnswers({ overlay = false }: { overlay?: boolean }) {
  const colors = useColors();
  const ask = useAsk();
  const { messages, busy } = ask;
  const close = () => ask.setOpen(false);

  // Follow the answer as it streams.
  const scrollRef = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];
  const tail = `${messages.length}:${last?.content.length ?? 0}:${last?.tools?.length ?? 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tail` is the change signal
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);

  return (
    <div
      className={`reading w-[440px] flex flex-col border-l overflow-hidden ${
        overlay
          ? "absolute right-0 top-0 bottom-0 z-40 max-w-full shadow-[-12px_0_24px_rgba(0,0,0,0.45)]"
          : "max-w-[45%] shrink-0"
      }`}
      style={{
        borderColor: ask.attach.dragging ? colors.accent : tint(colors, 22),
        backgroundColor: tint(colors, 6),
      }}
      data-ask-surface
      {...ask.attach.drop}
    >
      <div
        className="shrink-0 flex items-center justify-between px-2 py-1 border-b"
        style={{ borderColor: tint(colors, 16), backgroundColor: tint(colors, 10) }}
      >
        <div className="flex items-center gap-3">
          <span
            className={`text-[9px] font-bold tracking-widest ${busy ? "animate-pulse" : ""}`}
            style={{ color: colors.accent }}
            title={busy ? "กำลังตอบ" : undefined}
          >
            ASK
          </span>
          {/* Two tabs over one body: the conversation, or the saved ones. */}
          <button
            type="button"
            aria-pressed={!ask.historyOpen}
            onClick={() => ask.setHistoryOpen(false)}
            className="hover:opacity-70"
            style={{ color: ask.historyOpen ? colors.textSecondary : colors.text }}
            title="CHAT — บทสนทนาที่อยู่บนจอ"
            aria-label="Chat"
          >
            <MessageSquare className={ICON} />
          </button>
          <button
            type="button"
            aria-pressed={ask.historyOpen}
            onClick={() => ask.setHistoryOpen(true)}
            className="hover:opacity-70"
            style={{
              color: ask.archiveNote
                ? "#ffc107"
                : ask.historyOpen
                  ? colors.text
                  : colors.textSecondary,
            }}
            title={ask.archiveNote ?? "HISTORY — แชตเก่าที่บันทึกไว้ เปิดแล้วถามต่อได้"}
            aria-label="History"
          >
            <History className={ICON} />
          </button>
        </div>
        <div className="flex items-center gap-3">
          <TemporaryButton colors={colors} ask={ask} />
          <ModelButton colors={colors} ask={ask} />
          <button
            type="button"
            onClick={() => {
              ask.clear();
              ask.setHistoryOpen(false);
            }}
            className="hover:opacity-70"
            style={{ color: colors.textSecondary }}
            title={
              ask.temporary
                ? "เริ่มบทสนทนาใหม่ — แชตชั่วคราวนี้จะหายไป"
                : "เริ่มบทสนทนาใหม่ — อันนี้ยังอยู่ใน HISTORY"
            }
            aria-label="New chat"
          >
            <SquarePen className={ICON} />
          </button>
          <button
            type="button"
            onClick={close}
            className="hover:opacity-70"
            style={{ color: colors.textSecondary }}
            title="ซ่อน — บทสนทนายังอยู่"
            aria-label="Hide"
          >
            <X className={ICON} />
          </button>
        </div>
      </div>

      {ask.settingsOpen && ask.status.data && (
        <div className="shrink-0 font-mono">
          <AskSettings
            colors={colors}
            status={ask.status.data}
            choice={ask.choice}
            onChoose={ask.setChoice}
            onClose={() => ask.setSettingsOpen(false)}
          />
        </div>
      )}

      {ask.historyOpen && (
        <div className="flex-1 min-h-0 py-1">
          <AskHistory
            mode="tab"
            colors={colors}
            busy={busy}
            onOpen={ask.openSaved}
            onClose={() => ask.setHistoryOpen(false)}
            onDeletedCurrent={ask.clear}
          />
        </div>
      )}

      <div
        ref={scrollRef}
        className={`flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-3 ${ask.historyOpen ? "hidden" : ""}`}
        style={{ scrollbarWidth: "thin", scrollbarColor: "#333 transparent" }}
      >
        {messages.length === 0 && (
          <div className="flex flex-col gap-1 text-[10px]" style={{ color: colors.textSecondary }}>
            <span>
              {ask.ready
                ? "ถามเรื่องข่าว ตลาด หุ้น หรือตัวเลขเศรษฐกิจ — ตอบจากข้อมูลล่าสุด"
                : "ASK ยังใช้ไม่ได้ — กดไอคอน MODEL ด้านบนเพื่อตั้ง API key และ model"}
            </span>
            {ask.temporary && (
              <span style={{ color: colors.accent }}>
                แชตชั่วคราว — ไม่บันทึกลง HISTORY หายเมื่อเริ่มแชตใหม่หรือโหลดหน้าใหม่
              </span>
            )}
            {ask.ready &&
              EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => ask.submit(ex)}
                  className="text-left hover:opacity-70"
                >
                  › {ex}
                </button>
              ))}
            <AskRecent
              colors={colors}
              busy={busy}
              onOpen={ask.openSaved}
              onAll={() => ask.setHistoryOpen(true)}
            />
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
              key={i}
              className="text-[11px] font-bold pt-1 border-t first:border-t-0 first:pt-0"
              style={{ color: colors.accent, borderColor: colors.border }}
            >
              Q ▸{" "}
              <span style={{ color: colors.text }}>
                <MathText text={m.content} />
              </span>
              {m.at && (
                <span
                  className="pl-2 text-[9px] font-normal"
                  style={{ color: colors.textSecondary }}
                  title="เวลาที่ถาม — คำตอบคือข้อมูล ณ เวลานั้น"
                >
                  {askedAt(m.at)}
                </span>
              )}
              {!!m.lostImages && (
                <div
                  className="pt-0.5 text-[9px] font-normal"
                  style={{ color: colors.textSecondary }}
                >
                  [{m.lostImages} รูป — ไม่ได้เก็บไว้หลัง reload]
                </div>
              )}
              {m.images && m.images.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {m.images.map((src, n) => (
                    <a
                      // biome-ignore lint/suspicious/noArrayIndexKey: fixed once sent
                      key={n}
                      href={src}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="เปิดรูปเต็ม"
                    >
                      <img
                        src={src}
                        alt={`attachment ${n + 1}`}
                        className="h-16 w-auto max-w-[140px] object-cover border"
                        style={{ borderColor: colors.border }}
                      />
                    </a>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Answer
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
              key={i}
              msg={m}
              colors={colors}
              onAgain={i === messages.length - 1 && !busy ? ask.again : undefined}
            />
          )
        )}
      </div>

      <AskComposer colors={colors} ask={ask} />
    </div>
  );
}

/**
 * The question box while the answer column is open: at the foot of the column,
 * under the conversation it continues. (With the column closed the box is the
 * AskBar across the top — NewsView shows one or the other, never both.)
 */
function AskComposer({ colors, ask }: AskProps) {
  const { ready } = ask;
  const [draft, setDraft] = useAtom(askDraftTextAtom);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // The column opens because a question was just sent — keep the caret in the
  // box so the follow-up can be typed straight away. Again on the header's
  // ASK icon / `c` (focusSignal).
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSignal is the trigger
  useEffect(() => {
    boxRef.current?.focus();
  }, [ask.focusSignal]);

  // The box is as tall as what is typed in it — wrapped lines included, which
  // counting "\n" missed — and grows upward, the conversation above giving way.
  // Past the cap it scrolls inside itself.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `draft` is the change signal
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = "auto";
    const cap = Math.max(96, Math.round(window.innerHeight * 0.4));
    box.style.height = `${Math.min(box.scrollHeight, cap)}px`;
    box.style.overflowY = box.scrollHeight > cap ? "auto" : "hidden";
  }, [draft]);

  const send = () => {
    if (ask.submit(draft)) setDraft("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className="shrink-0 flex flex-col gap-1.5 px-3 py-2 border-t"
      style={{
        borderColor: ask.temporary ? colors.accent : tint(colors, 16),
        borderTopStyle: ask.temporary ? "dashed" : "solid",
        backgroundColor: tint(colors, 10),
      }}
    >
      <AttachTray colors={colors} attach={ask.attach} />
      <div className="flex items-end gap-2">
        <textarea
          ref={boxRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line; ignore Enter while an IME is composing.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") {
              e.currentTarget.blur();
            }
          }}
          onPaste={ask.attach.onPaste}
          disabled={!ready}
          maxLength={4000}
          rows={1}
          placeholder={!ready ? "ASK ยังใช้ไม่ได้" : ask.temporary ? "ถาม… (แชตชั่วคราว)" : "ถามต่อ…"}
          title="Enter ส่ง · Shift+Enter ขึ้นบรรทัด"
          aria-label="Ask a question"
          className="flex-1 min-w-0 resize-none bg-transparent text-[11px] leading-[1.5] outline-none placeholder:opacity-40 disabled:cursor-not-allowed"
          style={{ color: colors.text, scrollbarWidth: "thin", scrollbarColor: "#333 transparent" }}
        />
        <span className="flex items-center gap-2 pb-0.5">
          <AttachButton colors={colors} attach={ask.attach} disabled={!ready} />
          <SendButton
            colors={colors}
            ask={ask}
            empty={!draft.trim() && ask.attach.images.length === 0}
          />
        </span>
      </div>
    </form>
  );
}
