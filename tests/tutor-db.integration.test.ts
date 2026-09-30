import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";
import { cards, reviewers, sources, topics, users, views } from "@/lib/schema";
import { searchPacks } from "@/lib/search-queries";
import {
  clearThread,
  createCardFromMessage,
  findReusableAnswer,
  insertExchange,
  listSavedAnswers,
  listThread,
  loadAskSources,
  loadExplainTarget,
  setSaved,
  toChatMessageDto,
  type AskAnswerJson,
} from "@/lib/tutor-queries";

const runIntegration = process.env.RUN_DB_INTEGRATION === "1";
const describeDb = runIntegration ? describe : describe.skip;

const answerJson = (overrides: Partial<AskAnswerJson> = {}): AskAnswerJson => ({
  citationSources: [{ index: 1, sourceId: "s", filename: "Lecture.pdf", hasPages: true }],
  refused: false,
  origin: { kind: "ask" },
  ...overrides,
});

describeDb("Neon tutor integration", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const topicId = randomUUID();
  const reviewerId = randomUUID();
  const otherTopicId = randomUUID();
  const otherReviewerId = randomUUID();
  const pagedSourceId = randomUUID();
  const legacySourceId = randomUUID();
  const hugeSourceId = randomUUID();
  const failedSourceId = randomUUID();
  const liveCardId = randomUUID();
  const archivedCardId = randomUUID();

  const pagedText = [
    "<<<page 1>>>",
    "",
    "Cholesterol synthesis overview and the mevalonate pathway.",
    "",
    "<<<page 2>>>",
    "",
    "Statins inhibit HMG-CoA reductase, the rate limiting enzyme.",
    "",
    "<<<page 3>>>",
    "",
    "Side effects include myopathy and raised liver enzymes.",
  ].join("\n");
  const lockedIn = [
    "# Lipids",
    "",
    "Intro text about the course.",
    "",
    "## Statins",
    "",
    "Statins block zymoglobin reductase [S1 p.2].",
  ].join("\n");

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, email: `tutor-integration-${userId}@example.invalid`, passwordHash: "integration-only" },
      { id: otherUserId, email: `tutor-integration-${otherUserId}@example.invalid`, passwordHash: "integration-only" },
    ]);
    await db.insert(topics).values([
      { id: topicId, userId, name: "Tutor integration" },
      { id: otherTopicId, userId: otherUserId, name: "Other owner" },
    ]);
    await db.insert(reviewers).values([
      { id: reviewerId, topicId, name: "Pharmacology" },
      { id: otherReviewerId, topicId: otherTopicId, name: "Other pack" },
    ]);
    const base = Date.parse("2026-01-01T00:00:00Z");
    await db.insert(sources).values([
      {
        id: legacySourceId,
        reviewerId,
        filename: "Notes.txt",
        mime: "text/plain",
        kind: "paste",
        ingestStatus: "ready",
        extractedText: "Legacy notes about quokkasaurus anatomy without page markers.",
        createdAt: new Date(base),
      },
      {
        id: pagedSourceId,
        reviewerId,
        filename: "Lecture.pdf",
        mime: "application/pdf",
        kind: "pdf",
        ingestStatus: "ready",
        extractedText: pagedText,
        createdAt: new Date(base + 1000),
      },
      {
        id: failedSourceId,
        reviewerId,
        filename: "Broken.pdf",
        mime: "application/pdf",
        kind: "pdf",
        ingestStatus: "failed",
        extractedText: "Statins inhibit everything in this failed upload.",
        createdAt: new Date(base + 2000),
      },
      {
        reviewerId: otherReviewerId,
        filename: "Theirs.pdf",
        mime: "application/pdf",
        kind: "pdf",
        ingestStatus: "ready",
        extractedText: "<<<page 1>>>\n\nStatins inhibit HMG-CoA reductase in the other pack.",
      },
    ]);
    await db.insert(views).values([
      {
        reviewerId,
        kind: "locked_in",
        content: lockedIn,
        contentJson: {
          citationSources: [
            { index: 1, sourceId: pagedSourceId, filename: "Lecture.pdf", hasPages: true },
            { index: 2, sourceId: legacySourceId, filename: "Notes.txt", hasPages: false },
          ],
        },
      },
      {
        reviewerId,
        kind: "test_me",
        content: "",
        contentJson: [{
          id: "q1",
          question: "What do statins inhibit?",
          choices: ["HMG-CoA reductase", "Lipase"],
          answer: "HMG-CoA reductase",
          explanation: "Statins inhibit HMG-CoA reductase [S1 p.2].",
        }],
      },
    ]);
    await db.insert(cards).values([
      { id: liveCardId, reviewerId, sourceKey: "c1", front: "Statin target?", back: "HMG-CoA reductase" },
      {
        id: archivedCardId,
        reviewerId,
        sourceKey: "c2",
        front: "Archived xylotrombin card",
        back: "Hidden",
        archivedAt: new Date(),
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
  }, 60_000);

  it("adds the chat table, the chat_role enum and generated search columns", async () => {
    const columns = await db.execute(sql`
      SELECT table_name, column_name, data_type, is_generated
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((column_name = 'search_tsv' AND table_name IN ('sources', 'views', 'cards'))
          OR table_name = 'pack_chat_messages')
    `);
    const rows = columns.rows as { table_name: string; column_name: string; data_type: string; is_generated: string }[];
    for (const table of ["sources", "views", "cards"]) {
      expect(rows.find((row) => row.table_name === table && row.column_name === "search_tsv")).toMatchObject({
        data_type: "tsvector",
        is_generated: "ALWAYS",
      });
    }
    const chatColumns = rows.filter((row) => row.table_name === "pack_chat_messages").map((row) => row.column_name);
    expect(chatColumns.sort()).toEqual([
      "cleared_at", "content", "content_json", "created_at", "id", "model_id",
      "origin_key", "reply_to_id", "reviewer_id", "role", "saved_at", "user_id",
    ]);
    const enumRows = await db.execute(sql`
      SELECT e.enumlabel FROM pg_enum AS e JOIN pg_type AS t ON t.oid = e.enumtypid
      WHERE t.typname = 'chat_role' ORDER BY e.enumsortorder
    `);
    expect((enumRows.rows as { enumlabel: string }[]).map((row) => row.enumlabel)).toEqual(["user", "assistant"]);
  });

  it("inserts an exchange as two linked rows and lists the thread oldest first", async () => {
    const first = await insertExchange({
      reviewerId, userId, question: "What do statins do?", answer: "They inhibit a reductase [S1 p.2].",
      answerJson: answerJson(), modelId: "model/free", originKey: null,
    });
    const second = await insertExchange({
      reviewerId, userId, question: "And side effects?", answer: "Myopathy [S1 p.3].",
      answerJson: answerJson(), modelId: "model/free", originKey: null,
    });
    expect(first && second).toBeTruthy();
    expect(first!.answer.replyToId).toBe(first!.question.id);
    expect(first!.answer.createdAt.getTime()).toBeGreaterThan(first!.question.createdAt.getTime());

    const thread = await listThread(reviewerId, userId);
    expect(thread.map((row) => row.id)).toEqual([
      first!.question.id, first!.answer.id, second!.question.id, second!.answer.id,
    ]);
    const dto = toChatMessageDto(thread[1]!);
    expect(dto).toMatchObject({
      role: "assistant", refused: false, saved: false, origin: { kind: "ask" }, replyToId: first!.question.id,
    });
    expect(dto.citationSources).toHaveLength(1);
    expect(toChatMessageDto(thread[0]!).citationSources).toBeNull();

    expect(await insertExchange({
      reviewerId, userId: otherUserId, question: "x", answer: "y",
      answerJson: answerJson(), modelId: null, originKey: null,
    })).toBeNull();
    expect(await listThread(reviewerId, otherUserId)).toEqual([]);
  });

  it("rejects content over 20,000 characters and stores nothing", async () => {
    const before = await listThread(reviewerId, userId);
    await expect(insertExchange({
      reviewerId, userId, question: "Long?", answer: "a".repeat(20_001),
      answerJson: answerJson(), modelId: null, originKey: null,
    })).rejects.toThrow();
    expect(await listThread(reviewerId, userId)).toHaveLength(before.length);
  });

  it("keeps saved answers in Notes after Clear chat, and only for the owner", async () => {
    const thread = await listThread(reviewerId, userId);
    const answer = thread.find((row) => row.role === "assistant")!;
    const question = thread.find((row) => row.role === "user")!;

    expect(await setSaved(question.id, reviewerId, userId, true)).toBeNull();
    expect(await setSaved(answer.id, reviewerId, otherUserId, true)).toBeNull();
    expect(await setSaved(answer.id, otherReviewerId, userId, true)).toBeNull();
    expect(await setSaved("not-a-uuid", reviewerId, userId, true)).toBeNull();
    const saved = await setSaved(answer.id, reviewerId, userId, true);
    expect(saved?.savedAt).toBeInstanceOf(Date);

    expect(await clearThread(reviewerId, otherUserId)).toBe(0);
    expect(await clearThread(reviewerId, userId)).toBeGreaterThan(0);
    expect(await listThread(reviewerId, userId)).toEqual([]);

    const notes = await listSavedAnswers(reviewerId, userId);
    expect(notes.map((entry) => entry.answer.id)).toEqual([answer.id]);
    expect(notes[0]!.question?.id).toBe(answer.replyToId);
    expect(toChatMessageDto(notes[0]!.answer).saved).toBe(true);
    expect(await listSavedAnswers(reviewerId, otherUserId)).toEqual([]);

    const unsaved = await setSaved(answer.id, reviewerId, userId, false);
    expect(unsaved?.savedAt).toBeNull();
    expect(await listSavedAnswers(reviewerId, userId)).toEqual([]);
  });

  it("does not save a refused answer", async () => {
    const refused = await insertExchange({
      reviewerId, userId, question: "Who won the 1998 World Cup?",
      answer: "Your lecture covers statins, not football.",
      answerJson: answerJson({ refused: true, citationSources: null }), modelId: null, originKey: null,
    });
    expect(toChatMessageDto(refused!.answer).refused).toBe(true);
    expect(await setSaved(refused!.answer.id, reviewerId, userId, true)).toBeNull();
    expect(await createCardFromMessage({
      messageId: refused!.answer.id, reviewerId, userId, front: "Q", back: "A",
    })).toBeNull();
  });

  it("finds an uncleared Explain answer by origin key, owner-scoped", async () => {
    const origin = { kind: "explain", key: "test:q1" } as const;
    const exchange = await insertExchange({
      reviewerId, userId, question: "Explain: What do statins inhibit?",
      answer: "Statins inhibit HMG-CoA reductase [S1 p.2].",
      answerJson: answerJson({ origin }), modelId: "model/free", originKey: "test:q1",
    });
    const reused = await findReusableAnswer(reviewerId, userId, "test:q1");
    expect(reused?.answer.id).toBe(exchange!.answer.id);
    expect(reused?.question?.id).toBe(exchange!.question.id);
    expect(toChatMessageDto(reused!.answer).origin).toEqual(origin);
    expect(toChatMessageDto(reused!.question!).origin).toEqual(origin);
    expect(await findReusableAnswer(reviewerId, otherUserId, "test:q1")).toBeNull();
    expect(await findReusableAnswer(reviewerId, userId, "test:other")).toBeNull();

    await clearThread(reviewerId, userId);
    expect(await findReusableAnswer(reviewerId, userId, "test:q1")).toBeNull();
  });

  it("makes one user-authored FSRS-new card per answer", async () => {
    const exchange = await insertExchange({
      reviewerId, userId, question: "What is the statin target?", answer: "HMG-CoA reductase [S1 p.2].",
      answerJson: answerJson(), modelId: null, originKey: null,
    });
    const messageId = exchange!.answer.id;

    const first = await createCardFromMessage({
      messageId, reviewerId, userId, front: " What is the statin target? ", back: "HMG-CoA reductase [S1 p.2].",
    });
    expect(first?.created).toBe(true);
    expect(first?.card).toMatchObject({
      sourceKey: `ask:${messageId}`,
      front: "What is the statin target?",
      isEdited: true,
      fsrsState: 0,
      archivedAt: null,
    });
    expect(first!.card.dueAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    expect("searchTsv" in first!.card).toBe(false);

    const second = await createCardFromMessage({
      messageId, reviewerId, userId, front: "Changed", back: "Changed",
    });
    expect(second).toMatchObject({ created: false, card: { id: first!.card.id, front: "What is the statin target?" } });

    expect(await createCardFromMessage({
      messageId, reviewerId, userId: otherUserId, front: "Q", back: "A",
    })).toBeNull();
    expect(await createCardFromMessage({
      messageId: exchange!.question.id, reviewerId, userId, front: "Q", back: "A",
    })).toBeNull();
    await expect(createCardFromMessage({
      messageId, reviewerId, userId, front: "Bad {{ cloze", back: "A",
    })).rejects.toThrow();
    const rows = await db.select({ id: cards.id }).from(cards).where(eq(cards.sourceKey, `ask:${messageId}`));
    expect(rows).toHaveLength(1);
  });

  it("loads Ready sources with text in created_at order, owner-scoped", async () => {
    const loaded = await loadAskSources(reviewerId, userId);
    expect(loaded.map((source) => source.sourceId)).toEqual([legacySourceId, pagedSourceId]);
    expect(loaded[1]).toMatchObject({ filename: "Lecture.pdf", text: pagedText });
    expect(await loadAskSources(reviewerId, otherUserId)).toEqual([]);
  });

  it("loads an Explain target from the Test Me view or a live card", async () => {
    const item = await loadExplainTarget({ reviewerId, userId, target: { type: "test_item", itemId: "q1" } });
    expect(item).toMatchObject({
      type: "test_item",
      item: { id: "q1", answer: "HMG-CoA reductase" },
    });
    expect(item?.citationSources?.map((ref) => ref.sourceId)).toEqual([pagedSourceId, legacySourceId]);
    expect(await loadExplainTarget({ reviewerId, userId, target: { type: "test_item", itemId: "nope" } })).toBeNull();
    expect(await loadExplainTarget({
      reviewerId, userId: otherUserId, target: { type: "test_item", itemId: "q1" },
    })).toBeNull();

    const card = await loadExplainTarget({ reviewerId, userId, target: { type: "card", cardId: liveCardId } });
    expect(card).toMatchObject({ type: "card", card: { id: liveCardId, front: "Statin target?" } });
    expect(await loadExplainTarget({
      reviewerId, userId, target: { type: "card", cardId: archivedCardId },
    })).toBeNull();
    expect(await loadExplainTarget({
      reviewerId, userId: otherUserId, target: { type: "card", cardId: liveCardId },
    })).toBeNull();
  });

  it("stems English: inhibiting, inhibition and inhibitors find their forms", async () => {
    // The english config stems "inhibitors" to "inhibitor", not "inhibit", so
    // each query is paired with text that shares its stem.
    for (const query of ["inhibiting", "inhibition", "inhibits"]) {
      const hits = await searchPacks(userId, query);
      expect(hits.some((hit) => hit.kind === "source_page" && hit.sourceId === pagedSourceId), query).toBe(true);
    }
    const stem = await db.execute(sql`
      SELECT to_tsvector('english', 'ACE inhibitor') @@ websearch_to_tsquery('english', 'inhibitors') AS hit
    `);
    expect((stem.rows[0] as { hit: boolean }).hit).toBe(true);
  });

  it("returns page-level source hits with the right page, S index and a marked snippet", async () => {
    const hits = await searchPacks(userId, "reductase");
    const page = hits.find((hit) => hit.kind === "source_page" && hit.sourceId === pagedSourceId);
    expect(page).toMatchObject({
      topicId,
      reviewerId,
      packName: "Pharmacology",
      page: 2,
      sourceIndex: 1,
    });
    expect(page?.snippet).toContain("«reductase»");
    expect(hits.filter((hit) => hit.sourceId === pagedSourceId)).toHaveLength(1);

    const legacy = (await searchPacks(userId, "quokkasaurus")).find((hit) => hit.sourceId === legacySourceId);
    expect(legacy).toMatchObject({ kind: "source_page", page: null, sourceIndex: 2 });
  });

  it("returns Locked In hits with a match offset and live card hits", async () => {
    const hits = await searchPacks(userId, "zymoglobin");
    const study = hits.find((hit) => hit.kind === "locked_in");
    expect(study?.matchOffset).toBe(lockedIn.indexOf("zymoglobin"));
    expect(study?.snippet).toContain("«zymoglobin»");

    const cardHits = await searchPacks(userId, "statin target");
    expect(cardHits.some((hit) => hit.kind === "card")).toBe(true);
    expect(await searchPacks(userId, "xylotrombin")).toEqual([]);
  });

  it("never returns another owner's rows or non-Ready sources", async () => {
    const mine = await searchPacks(userId, "statins inhibit");
    expect(mine.every((hit) => hit.reviewerId === reviewerId)).toBe(true);
    expect(mine.some((hit) => hit.sourceId === failedSourceId)).toBe(false);

    const theirs = await searchPacks(otherUserId, "statins inhibit");
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((hit) => hit.reviewerId === otherReviewerId)).toBe(true);

    expect(await searchPacks(randomUUID(), "statins")).toEqual([]);
    expect(await searchPacks(userId, "the")).toEqual([]);
    expect(await searchPacks(userId, "x")).toEqual([]);
  });

  it("inserts a worst-case 150K+ character source without a tsvector error", async () => {
    const words: string[] = [];
    let length = 0;
    for (let i = 0; length < 400_000; i++) {
      const word = `lexeme${i.toString(36)}q`;
      words.push(word);
      length += word.length + 1;
    }
    const text = `<<<page 1>>>\n\nmegalithic ${"z".repeat(3_000)} ${words.join(" ")}`;
    await db.insert(sources).values({
      id: hugeSourceId,
      reviewerId,
      filename: "Huge.pdf",
      mime: "application/pdf",
      kind: "pdf",
      ingestStatus: "ready",
      extractedText: text,
    });
    const [row] = await db
      .select({ size: sql<number>`pg_column_size(${sources.searchTsv})` })
      .from(sources)
      .where(eq(sources.id, hugeSourceId));
    expect(Number(row!.size)).toBeLessThan(1_048_576);

    const hits = await searchPacks(userId, "megalithic");
    expect(hits.find((hit) => hit.sourceId === hugeSourceId)).toMatchObject({ page: 1 });
    // Past the 150,000-character prefix nothing is indexed.
    expect(await searchPacks(userId, words[words.length - 1]!)).toEqual([]);
  }, 60_000);
});
