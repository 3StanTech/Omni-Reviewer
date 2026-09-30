import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  cleanSnippet,
  parseSearchQuery,
  searchKindLabel,
  searchResultHref,
  sectionAnchorFor,
  type SnippetSegment,
} from "@/lib/search";
import { loadStudyMarkdownForHits, searchPacks } from "@/lib/search-queries";

export const dynamic = "force-dynamic";

type SearchResult = {
  key: string;
  packName: string;
  kindLabel: string;
  href: string;
  snippet: SnippetSegment[];
};

/**
 * Full-text search over the signed-in user's packs. A missing, too short or
 * too long query is not an error: it returns no results, so a typing client
 * never sees a failure.
 */
export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const query = parseSearchQuery(new URL(request.url).searchParams.get("q"));
  if (!query) return NextResponse.json({ results: [] });

  const hits = await searchPacks(userId, query);
  const markdown = await loadStudyMarkdownForHits(userId, hits);
  const results: SearchResult[] = hits.map((hit, i) => {
    const body = markdown.get(`${hit.reviewerId}:${hit.kind}`);
    const headingId = body && hit.matchOffset != null ? sectionAnchorFor(body, hit.matchOffset) : null;
    return {
      key: [hit.kind, hit.reviewerId, hit.sourceId ?? "", hit.page ?? "", i].join(":"),
      packName: hit.packName,
      kindLabel: searchKindLabel(hit),
      href: searchResultHref({
        kind: hit.kind,
        topicId: hit.topicId,
        reviewerId: hit.reviewerId,
        sourceId: hit.sourceId,
        sourceIndex: hit.sourceIndex,
        page: hit.page,
        headingId,
      }),
      snippet: cleanSnippet(hit.snippet),
    };
  });
  return NextResponse.json({ results });
}
