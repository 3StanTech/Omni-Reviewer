/**
 * Shared shapes for the pack tutor (Ask, Explain, Ask why).
 * Type-only module: client components import it, so it must stay free of
 * server and node imports.
 */

import type { CitationSourceRef } from "@/lib/citations";

export type AskOrigin =
  | { kind: "ask" }
  | { kind: "explain"; key: string }
  | { kind: "ask_why"; key: string };

export type AskRequest =
  | { kind: "ask"; question: string }
  | {
      kind: "explain";
      target: { type: "test_item"; itemId: string; chosen: string } | { type: "card"; cardId: string };
    }
  | { kind: "ask_why"; sentence: string };

export type ChatMessageDto = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  refused: boolean;
  saved: boolean;
  origin: AskOrigin;
  citationSources: CitationSourceRef[] | null;
  replyToId: string | null;
};

export type AskResponse = { messages: ChatMessageDto[]; reused: boolean };

export const MAX_ASK_QUESTION_CHARS = 2_000;
