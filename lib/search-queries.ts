import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { readStudyDocumentMeta } from "@/lib/citations";
import { db } from "@/lib/db";
import { reviewers, sources, topics, views } from "@/lib/schema";

export type SearchHitKind = "source_page" | "locked_in" | "summary" | "card";

/**
 * One owner-scoped full-text hit. `snippet` is raw `ts_headline` text with
 * matches wrapped in « and »; the app escapes it before rendering.
 */
export type SearchHitRow = {
  kind: SearchHitKind;
  topicId: string;
  reviewerId: string;
  packName: string;
  /** Source hits: the matched upload. */
  sourceId?: string;
  /**
   * Source hits: the S<n> position the pack's source viewer resolves. From the
   * Locked In citation sources when present (null if that list lacks the
   * source), else the position among Ready sources by `created_at`.
   */
  sourceIndex?: number | null;
  /** Source hits: the page, or null for text without page markers. */
  page?: number | null;
  /** Study hits: 0-based character offset of the match in the view's Markdown, when found. */
  matchOffset?: number | null;
  snippet: string;
  rank: number;
};

export const SEARCH_RESULT_LIMIT = 30;
const MATCHED_SOURCE_LIMIT = 10;
const PAGES_PER_SOURCE = 3;
const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 200;

/** Must match the generated `search_tsv` prefix in lib/schema.ts. */
const PREFIX = sql.raw("150000");
const HEADLINE_OPTIONS = "StartSel=«, StopSel=», MaxFragments=1";

type RawHit = {
  kind: string;
  topic_id: string;
  reviewer_id: string;
  pack_name: string;
  source_id: string | null;
  page: number | string | null;
  match_offset: number | string | null;
  snippet: string | null;
  rank: number | string;
};

function asNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Full-text search over the user's packs: source pages, Locked In, Summary
 * and live cards. Packs and topics being deleted, non-Ready or deleting
 * sources and archived cards are excluded. At most 30 rows, best first.
 */
export async function searchPacks(userId: string, query: string): Promise<SearchHitRow[]> {
  const q = query.trim().replace(/\s+/g, " ");
  if (q.length < MIN_QUERY_CHARS || q.length > MAX_QUERY_CHARS) return [];

  const result = await db.execute(sql`
    WITH q AS (
      SELECT query FROM (SELECT websearch_to_tsquery('english', ${q}) AS query) AS parsed
      WHERE numnode(query) > 0
    ),
    packs AS (
      SELECT r.id AS reviewer_id, r.topic_id, r.name AS pack_name
      FROM reviewers AS r
      JOIN topics AS t ON t.id = r.topic_id
      WHERE t.user_id = ${userId}
        AND r.deleting_at IS NULL
        AND t.deleting_at IS NULL
    ),
    matched_sources AS (
      SELECT s.id, s.reviewer_id,
        left(coalesce(s.extracted_text, ''), ${PREFIX}) AS body,
        ts_rank_cd(s.search_tsv, q.query) AS rank
      FROM sources AS s
      JOIN packs AS p ON p.reviewer_id = s.reviewer_id
      CROSS JOIN q
      WHERE s.ingest_status = 'ready'
        AND s.deleting_at IS NULL
        AND s.search_tsv @@ q.query
      ORDER BY rank DESC, s.id
      LIMIT ${MATCHED_SOURCE_LIMIT}
    ),
    chunks AS (
      SELECT ms.id AS source_id, ms.reviewer_id, c.chunk, c.ord
      FROM matched_sources AS ms
      CROSS JOIN LATERAL regexp_split_to_table(ms.body, '^<<<page [0-9]{1,4}>>>$', 'n')
        WITH ORDINALITY AS c(chunk, ord)
    ),
    markers AS (
      SELECT ms.id AS source_id, m.ord, (m.match)[1]::int AS page
      FROM matched_sources AS ms
      CROSS JOIN LATERAL regexp_matches(ms.body, '^<<<page ([0-9]{1,4})>>>$', 'gn')
        WITH ORDINALITY AS m(match, ord)
    ),
    page_hits AS (
      SELECT ch.source_id, ch.reviewer_id, mk.page, ch.chunk,
        ts_rank_cd(v.tsv, q.query) AS rank
      FROM chunks AS ch
      CROSS JOIN q
      CROSS JOIN LATERAL (SELECT to_tsvector('english', ch.chunk) AS tsv) AS v
      -- Chunk n+1 follows the n-th marker line; chunk 1 is text before any marker.
      LEFT JOIN markers AS mk ON mk.source_id = ch.source_id AND mk.ord = ch.ord - 1
      WHERE v.tsv @@ q.query
    ),
    top_pages AS (
      SELECT ph.*,
        row_number() OVER (
          PARTITION BY ph.source_id ORDER BY ph.rank DESC, ph.page NULLS FIRST
        ) AS rn
      FROM page_hits AS ph
    ),
    source_rows AS (
      SELECT 'source_page'::text AS kind, tp.reviewer_id, tp.source_id, tp.page,
        NULL::int AS match_offset,
        ts_headline('english', tp.chunk, q.query, ${HEADLINE_OPTIONS}) AS snippet,
        tp.rank
      FROM top_pages AS tp
      CROSS JOIN q
      WHERE tp.rn <= ${PAGES_PER_SOURCE}
      UNION ALL
      -- A source can match as a whole while no single page holds every term.
      SELECT 'source_page'::text, ms.reviewer_id, ms.id, NULL::int, NULL::int,
        ts_headline('english', ms.body, q.query, ${HEADLINE_OPTIONS}),
        ms.rank
      FROM matched_sources AS ms
      CROSS JOIN q
      WHERE NOT EXISTS (SELECT 1 FROM page_hits AS ph WHERE ph.source_id = ms.id)
    ),
    study_matches AS (
      SELECT v.reviewer_id, v.kind::text AS kind,
        left(v.content, ${PREFIX}) AS body,
        ts_rank_cd(v.search_tsv, q.query) AS rank
      FROM views AS v
      JOIN packs AS p ON p.reviewer_id = v.reviewer_id
      CROSS JOIN q
      WHERE v.kind IN ('locked_in', 'summary')
        AND v.search_tsv @@ q.query
      ORDER BY rank DESC, v.id
      LIMIT ${SEARCH_RESULT_LIMIT}
    ),
    study_rows AS (
      SELECT sm.kind, sm.reviewer_id, NULL::uuid AS source_id, NULL::int AS page,
        -- The fragment is a verbatim slice of the body, so the first mark's
        -- place in it locates the match. Otherwise fall back to the first
        -- occurrence of the first highlighted word, then to no offset.
        COALESCE(
          NULLIF(strpos(sm.body, NULLIF(replace(replace(h.snippet, '«', ''), '»', ''), '')), 0)
            + NULLIF(strpos(h.snippet, '«'), 0) - 2,
          NULLIF(strpos(sm.body, NULLIF(substring(h.snippet FROM '«([^»]*)»'), '')), 0) - 1
        ) AS match_offset,
        h.snippet,
        sm.rank
      FROM study_matches AS sm
      CROSS JOIN q
      CROSS JOIN LATERAL (
        SELECT ts_headline('english', sm.body, q.query, ${HEADLINE_OPTIONS}) AS snippet
      ) AS h
    ),
    card_matches AS (
      SELECT c.reviewer_id, c.front || ' ' || c.back AS body,
        ts_rank_cd(c.search_tsv, q.query) AS rank
      FROM cards AS c
      JOIN packs AS p ON p.reviewer_id = c.reviewer_id
      CROSS JOIN q
      WHERE c.archived_at IS NULL
        AND c.search_tsv @@ q.query
      ORDER BY rank DESC, c.id
      LIMIT ${SEARCH_RESULT_LIMIT}
    ),
    card_rows AS (
      SELECT 'card'::text AS kind, cm.reviewer_id, NULL::uuid AS source_id, NULL::int AS page,
        NULL::int AS match_offset,
        ts_headline('english', cm.body, q.query, ${HEADLINE_OPTIONS}) AS snippet,
        cm.rank
      FROM card_matches AS cm
      CROSS JOIN q
    ),
    hits AS (
      SELECT * FROM source_rows
      UNION ALL SELECT * FROM study_rows
      UNION ALL SELECT * FROM card_rows
    )
    SELECT hits.kind, p.topic_id, hits.reviewer_id, p.pack_name, hits.source_id,
      hits.page, hits.match_offset, hits.snippet, hits.rank
    FROM hits
    JOIN packs AS p ON p.reviewer_id = hits.reviewer_id
    ORDER BY hits.rank DESC, p.pack_name, hits.kind, hits.page NULLS FIRST
    LIMIT ${SEARCH_RESULT_LIMIT}
  `);

  const rows = result.rows as RawHit[];
  const hits: SearchHitRow[] = rows.map((row) => {
    const kind = row.kind as SearchHitKind;
    const base = {
      kind,
      topicId: String(row.topic_id),
      reviewerId: String(row.reviewer_id),
      packName: String(row.pack_name),
      snippet: row.snippet ?? "",
      rank: asNumber(row.rank) ?? 0,
    };
    if (kind === "source_page") {
      return { ...base, sourceId: String(row.source_id), page: asNumber(row.page) };
    }
    if (kind === "locked_in" || kind === "summary") {
      return { ...base, matchOffset: asNumber(row.match_offset) };
    }
    return base;
  });

  const sourceReviewers = [
    ...new Set(hits.filter((hit) => hit.kind === "source_page").map((hit) => hit.reviewerId)),
  ];
  if (sourceReviewers.length > 0) {
    const indexOf = await sourceIndexes(sourceReviewers);
    for (const hit of hits) {
      if (hit.kind === "source_page" && hit.sourceId) {
        hit.sourceIndex = indexOf(hit.reviewerId, hit.sourceId);
      }
    }
  }
  return hits;
}

/**
 * S<n> lookup for packs whose ownership the search already proved: the
 * Locked In citation sources when present, else Ready order by `created_at`.
 */
async function sourceIndexes(
  reviewerIds: string[],
): Promise<(reviewerId: string, sourceId: string) => number | null> {
  const lockedIn = await db
    .select({ reviewerId: views.reviewerId, contentJson: views.contentJson })
    .from(views)
    .where(and(inArray(views.reviewerId, reviewerIds), eq(views.kind, "locked_in")));
  const cited = new Map<string, Map<string, number>>();
  for (const row of lockedIn) {
    const refs = readStudyDocumentMeta(row.contentJson)?.citationSources ?? [];
    if (refs.length > 0) {
      cited.set(row.reviewerId, new Map(refs.map((ref) => [ref.sourceId, ref.index])));
    }
  }

  const fallbackIds = reviewerIds.filter((id) => !cited.has(id));
  const ordered = new Map<string, Map<string, number>>();
  if (fallbackIds.length > 0) {
    const ready = await db
      .select({ id: sources.id, reviewerId: sources.reviewerId })
      .from(sources)
      .where(and(
        inArray(sources.reviewerId, fallbackIds),
        eq(sources.ingestStatus, "ready"),
        isNull(sources.deletingAt),
      ))
      .orderBy(asc(sources.createdAt), asc(sources.id));
    for (const row of ready) {
      const positions = ordered.get(row.reviewerId) ?? new Map<string, number>();
      positions.set(row.id, positions.size + 1);
      ordered.set(row.reviewerId, positions);
    }
  }

  return (reviewerId, sourceId) =>
    (cited.get(reviewerId) ?? ordered.get(reviewerId))?.get(sourceId) ?? null;
}

/**
 * Markdown of the Locked In and Summary views behind study hits, keyed
 * `${reviewerId}:${kind}`, so a hit's match offset can be mapped to its
 * section heading. One owner-scoped query for the given packs only.
 */
export async function loadStudyMarkdownForHits(
  userId: string,
  hits: ReadonlyArray<Pick<SearchHitRow, "kind" | "reviewerId">>,
): Promise<Map<string, string>> {
  const reviewerIds = [
    ...new Set(
      hits.filter((hit) => hit.kind === "locked_in" || hit.kind === "summary").map((hit) => hit.reviewerId),
    ),
  ];
  const markdown = new Map<string, string>();
  if (reviewerIds.length === 0) return markdown;
  const rows = await db
    .select({ reviewerId: views.reviewerId, kind: views.kind, content: views.content })
    .from(views)
    .innerJoin(reviewers, eq(reviewers.id, views.reviewerId))
    .innerJoin(topics, eq(topics.id, reviewers.topicId))
    .where(and(
      inArray(views.reviewerId, reviewerIds),
      inArray(views.kind, ["locked_in", "summary"]),
      eq(topics.userId, userId),
      isNull(reviewers.deletingAt),
    ));
  for (const row of rows) markdown.set(`${row.reviewerId}:${row.kind}`, row.content);
  return markdown;
}
