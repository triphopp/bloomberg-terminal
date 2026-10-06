import type { AskMessage } from "./types.ts";

/**
 * What of the conversation goes back to the model with the next question. Pure.
 *
 * Only finished exchanges: a question with the answer that followed it. A
 * question that was stopped or failed is left out together with what there was
 * of its answer — sent alone it would put two user turns in a row, which some
 * providers refuse and none can make sense of. Tool results are not part of
 * the history; the model reads again what a follow-up needs.
 */

/** Longest earlier answer sent back. The backend cuts at 20,000 (`_HISTORY_CHARS`). */
export const HISTORY_CHARS = 12_000;

/**
 * How many exchanges back a question's pictures still travel with the
 * conversation. Within it "and the second chart?" works; past it the pictures
 * are only mentioned. Each resend costs the picture's tokens again, which is
 * why this is small and only the latest set is kept.
 */
export const PICTURE_MEMORY = 3;

/**
 * Exchanges the model is given in full — the backend's `_HISTORY_TURNS` / 2.
 * Older ones still go, their answers cut to DIGEST_CHARS: the backend lists
 * them one line each (`_conversation_note`) instead of dropping them, so a
 * long conversation opened again from HISTORY keeps its beginning.
 */
export const HISTORY_PAIRS = 6;
export const DIGEST_CHARS = 600;

export interface AskTurn {
  role: "user" | "assistant";
  content: string;
  /** User turns only: pictures sent again with this turn (see PICTURE_MEMORY). */
  images?: string[];
  /**
   * User turns only: when it was asked (epoch ms). The model is told, so an
   * answer from a conversation opened again days later is read as of its day.
   */
  at?: number;
}

function finished(question: AskMessage, answer: AskMessage): boolean {
  return (
    question.role === "user" &&
    answer.role === "assistant" &&
    !answer.pending &&
    !answer.error &&
    answer.content.trim() !== "" &&
    question.content.trim() !== ""
  );
}

/** Finished exchanges as [question, answer] pairs, oldest first. */
function exchanges(messages: AskMessage[]): [AskMessage, AskMessage][] {
  const out: [AskMessage, AskMessage][] = [];
  for (let i = 0; i + 1 < messages.length; i++) {
    if (!finished(messages[i], messages[i + 1])) continue;
    out.push([messages[i], messages[i + 1]]);
    i++;
  }
  return out;
}

export function historyFor(messages: AskMessage[]): AskTurn[] {
  const pairs = exchanges(messages);
  // The latest question that came with pictures keeps them for a few exchanges.
  let withPictures = -1;
  for (let i = pairs.length - 1; i >= Math.max(0, pairs.length - PICTURE_MEMORY); i--) {
    if (pairs[i][0].images?.length) {
      withPictures = i;
      break;
    }
  }

  const out: AskTurn[] = [];
  const firstInFull = pairs.length - HISTORY_PAIRS;
  pairs.forEach(([question, answer], i) => {
    const pictures = question.images?.length ?? question.lostImages ?? 0;
    const resend = i === withPictures;
    const limit = i < firstInFull ? DIGEST_CHARS : HISTORY_CHARS;
    out.push(
      {
        role: "user",
        // A turn whose pictures are not sent is told there were some, so "the
        // second chart" is not a riddle to the model.
        content:
          pictures && !resend
            ? `${question.content}\n[${pictures} picture(s) were attached to this question; they are not sent again]`
            : question.content,
        ...(resend ? { images: question.images } : {}),
        ...(question.at ? { at: question.at } : {}),
      },
      {
        role: "assistant",
        content:
          answer.content.length > limit
            ? `${answer.content.slice(0, limit)}\n… [earlier answer cut here]`
            : answer.content,
      }
    );
  });
  return out;
}

/**
 * An answer that is going back as history was written from private data (the
 * portfolio, a thesis, a note). The backend then keeps read_page to links it
 * was given, for this question too — what that answer said is in the context.
 */
export function historyIsPrivate(messages: AskMessage[]): boolean {
  return exchanges(messages).some(([, answer]) => answer.private);
}
