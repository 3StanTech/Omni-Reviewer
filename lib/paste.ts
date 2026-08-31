import { PublicError } from "@/lib/public-errors";

export const MAX_PASTE_TEXT_CHARS = 200_000;
export const MAX_PASTE_TITLE_CHARS = 180;
/** Covers the UTF-8 JSON envelope for the maximum accepted text. */
export const MAX_PASTE_BODY_BYTES = 1_000_000;

export function normalizePasteTitle(value: string): string {
  const title = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) throw new PublicError("Paste title is required");
  if (title.length > MAX_PASTE_TITLE_CHARS) {
    throw new PublicError(
      `Paste title exceeds the ${MAX_PASTE_TITLE_CHARS.toLocaleString()} character limit`,
    );
  }
  return title;
}

export function normalizePasteText(value: string): string {
  const text = value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new PublicError("Paste text is required");
  if (text.length > MAX_PASTE_TEXT_CHARS) {
    throw new PublicError(
      `Paste text exceeds the ${MAX_PASTE_TEXT_CHARS.toLocaleString()} character limit`,
    );
  }
  return text;
}
