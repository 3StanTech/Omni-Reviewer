import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const TUTOR_COMPONENTS = [
  "components/ask-panel.tsx",
  "components/ask-message.tsx",
  "components/search-dialog.tsx",
] as const;

describe("tutor components", () => {
  it("marks the Ask panel root so other key handlers can ignore it", () => {
    expect(read("components/ask-panel.tsx")).toContain("data-ask-panel");
  });

  it("closes on Escape and hands focus back to the pill", () => {
    const panel = read("components/ask-panel.tsx");
    expect(panel).toMatch(/event\.key\s*!==\s*"Escape"/);
    expect(panel).toContain("onOpenChange(false)");
    expect(panel).toMatch(/pill\.current\?\.focus\(\)/);
  });

  it("sends on Enter, keeps Shift+Enter as a newline, and bounds the question", () => {
    const panel = read("components/ask-panel.tsx");
    expect(panel).toMatch(/event\.key\s*!==\s*"Enter"\s*\|\|\s*event\.shiftKey/);
    expect(panel).toContain("MAX_ASK_QUESTION_CHARS");
    expect(panel).toContain("aria-live=\"polite\"");
    expect(panel).toContain("Reading your slides");
  });

  it("keeps UI copy free of em dashes", () => {
    for (const file of TUTOR_COMPONENTS) expect(read(file), file).not.toContain("—");
  });

  it("imports icons from Phosphor only", () => {
    const iconLibraries = /from\s+["'](lucide-react|react-icons[^"']*|@heroicons[^"']*|@radix-ui\/react-icons|@tabler\/icons[^"']*)["']/;
    for (const file of TUTOR_COMPONENTS) {
      const source = read(file);
      expect(source, file).not.toMatch(iconLibraries);
    }
    for (const file of TUTOR_COMPONENTS) {
      expect(read(file), file).toContain("@phosphor-icons/react");
    }
  });

  it("does not retype the unsourced tag wording", () => {
    for (const file of TUTOR_COMPONENTS) {
      expect(read(file), file).not.toContain("Not from your uploaded sources");
    }
  });

  it("renders search snippets as text nodes with mark elements", () => {
    const dialog = read("components/search-dialog.tsx");
    expect(dialog).not.toContain("dangerouslySetInnerHTML");
    expect(dialog).toContain("<mark");
    expect(dialog).toContain("segment.mark");
    for (const file of TUTOR_COMPONENTS) expect(read(file), file).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders answers through the sanitized study Markdown with per-message sources", () => {
    const message = read("components/ask-message.tsx");
    expect(message).toContain("MarkdownBody");
    expect(message).toContain("SourceViewerProvider");
    expect(message).toContain("citationSources={message.citationSources}");
    // Chat answers are not editable documents: the tag stays informational.
    expect(message).toContain("UnsourcedActionsProvider value={null}");
  });

  it("shows the fixed refusal copy and no card or notes actions when refused", () => {
    const message = read("components/ask-message.tsx");
    expect(message).toContain("Not in your slides");
    expect(message).toContain(
      "Your lecture does not cover this. I will not answer from outside knowledge here. Check your reference or ask your professor.",
    );
    expect(message).toMatch(/message\.refused \? null : \(/);
  });

  it("bounds card text with the shared learning limits", () => {
    const message = read("components/ask-message.tsx");
    expect(message).toContain("MAX_CARD_FRONT_CHARS");
    expect(message).toContain("MAX_CARD_BACK_CHARS");
    expect(message).toContain("Already a card");
    expect(message).toContain("Card added");
    expect(message).toContain("Saved to Notes");
  });

  it("navigates search results with the arrow keys, Enter and Escape", () => {
    const dialog = read("components/search-dialog.tsx");
    expect(dialog).toContain("ArrowDown");
    expect(dialog).toContain("ArrowUp");
    expect(dialog).toContain("\"Enter\"");
    expect(dialog).toContain("router.push(href)");
    // Escape is the dialog primitive's: it reports open=false through onOpenChange.
    expect(dialog).toContain("onOpenChange={onOpenChange}");
    expect(dialog).toContain("Search packs");
  });
});

describe("tutor wiring", () => {
  it("mounts one Ask provider for the whole pack, not per mode", () => {
    const workspace = read("components/reviewer-workspace.tsx");
    expect(workspace.match(/<AskProvider\b/g)?.length).toBe(1);
    expect(workspace).toContain("sections={sectionMastery}");
    expect(workspace).toContain("onCardCreated={refreshCards}");
    // The panel is rendered by the provider; the mode views never mount their own.
    const provider = read("components/ask-provider.tsx");
    expect(provider.match(/<AskPanel\b/g)?.length).toBe(1);
    for (const file of [
      "components/view-tabs.tsx",
      "components/locked-in-view.tsx",
      "components/summary-view.tsx",
      "components/test-me-view.tsx",
      "components/carded-view.tsx",
    ]) {
      expect(read(file), file).not.toContain("<AskPanel");
      expect(read(file), file).not.toContain("<AskProvider");
    }
  });

  it("keys the provider by pack so a thread never crosses packs", () => {
    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain("key={props.reviewerId}");
  });

  it("makes no request until the panel opens", () => {
    const provider = read("components/ask-provider.tsx");
    // The only GET is inside load(), reached from open(), ask() and ensureLoaded().
    expect(provider.match(/requestJson\(askUrl\)/g)?.length).toBe(1);
    const mount = provider.slice(provider.indexOf("function AskProviderInner"));
    expect(mount).not.toMatch(/useEffect\(\(\) => \{\s*(?:void )?load\(\)/);
    expect(mount).not.toMatch(/useEffect\(\(\) => \{\s*(?:void )?ensureLoaded\(\)/);
    expect(provider).toContain("if (loadRef.current) return loadRef.current;");
  });

  it("opens on the A key only when the user is not typing and no dialog is open", () => {
    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain('event.key.toLowerCase() !== "a"');
    expect(provider).toContain("event.metaKey || event.ctrlKey || event.altKey || event.shiftKey");
    expect(provider).toContain("input, textarea, select, [contenteditable='true'], [data-ask-panel]");
    // Closed popovers keep role=dialog with the hidden attribute, so hidden ones must not block the key.
    expect(provider).toContain("[role='dialog']:not([hidden])");
    expect(provider).toContain("dialog[open]");
  });

  it("keeps Carded and Test Me keys out of the Ask panel", () => {
    expect(read("components/carded-view.tsx")).toContain("[contenteditable='true'], [data-ask-panel]");
    expect(read("components/test-me-view.tsx")).toContain("[contenteditable='true'], [data-ask-panel]");
  });

  it("offers Explain this on missed Test Me items, timed misses and flipped durable cards", () => {
    const untimed = read("components/test-me-view.tsx");
    expect(untimed).toContain("ExplainThisButton");
    expect(untimed).toMatch(/type:\s*"test_item",\s*itemId:\s*item\.id/);
    expect(untimed).toContain("{correct ? null : <ExplainThisButton");

    const timed = read("components/timed-test-me.tsx");
    expect(timed).toContain("ExplainThisButton");
    expect(timed).toMatch(/type:\s*"test_item",\s*itemId:\s*item\.id/);
    expect(timed).toContain("{results[item.id] ? null : <ExplainThisButton");

    const carded = read("components/carded-view.tsx");
    expect(carded).toContain("isDurableCard(card) && flipped");
    expect(carded).toMatch(/type:\s*"card",\s*cardId:\s*card\.id/);

    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain("Lightbulb");
    expect(provider).toContain("Explain this");
    // Outside a pack there is no panel, so the button renders nothing.
    expect(provider).toMatch(/const ask = useOptionalAsk\(\);\s*if \(!ask\) return null;/);
  });

  it("wires Ask why on the unsourced tag through the provider context", () => {
    const tag = read("components/unsourced-tag.tsx");
    expect(tag).toContain("Ask why");
    expect(tag).toContain("AskWhyProvider");
    expect(tag).toContain("stripCitations");
    expect(tag).toContain("MAX_ASK_QUESTION_CHARS");
    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain("<AskWhyProvider value={askWhy}>");
    expect(provider).toContain('ask({ kind: "ask_why", sentence })');
  });

  it("shows saved answers under Notes and removes them through the provider", () => {
    const panel = read("components/study-side-panel.tsx");
    expect(panel).toContain("From Ask");
    expect(panel).toContain("Remove from Notes");
    expect(panel).toContain("removeSaved");
    // Saved answers are informational: the document's Keep/Delete must not reach them.
    expect(panel).toContain("UnsourcedActionsProvider value={null}");
    expect(panel).toContain("citationSources={answer.citationSources}");
    // The provider turns Remove into PATCH saved:false.
    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain('method: "PATCH"');
    expect(provider).toContain("removeSaved = useCallback((messageId: string) => toggleSaved(messageId, false)");
  });

  it("uses the route contract paths", () => {
    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain("/api/reviewers/${encodeURIComponent(reviewerId)}/ask");
    expect(provider).toContain("${askUrl}/${encodeURIComponent(messageId)}/card");
    expect(provider).toContain('method: "DELETE"');
  });

  it("clears the draft on send and restores it when the send fails", () => {
    const provider = read("components/ask-provider.tsx");
    expect(provider).toMatch(/setDraft\(""\);\s*const ok = await ask\(\{ kind: "ask", question \}\);\s*if \(!ok\) setDraft/);
  });

  it("shows a loading state for the first load and the question while an answer is pending", () => {
    const panel = read("components/ask-panel.tsx");
    expect(panel).toContain("Loading this pack&apos;s chat");
    // The intro and starter chips wait for the load, and give way while an answer is pending.
    expect(panel).toContain("empty && !loading && !pending");
    expect(panel).toContain("pending && pendingQuestion");
    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain('loading={savedStatus === "idle" || savedStatus === "loading"}');
    expect(provider).toContain('request.kind === "explain" ? "Explain this" : "Ask why"');
    // The optimistic bubble is cleared in finally, so success swaps in the server pair and failure removes it.
    expect(provider).toMatch(/setPending\(false\);\s*setPendingQuestion\(null\);/);
  });

  it("counts saved answers in the Notes label without a request on pack load", () => {
    const page = read("app/topics/[topicId]/reviewers/[reviewerId]/page.tsx");
    expect(page).toContain("countSavedAnswers(reviewerId, userId)");
    expect(page).toContain("savedAnswerCount={savedAnswerCount}");
    expect(read("components/reviewer-workspace.tsx")).toContain("initialSavedCount={savedAnswerCount}");
    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain('savedStatus === "ready" ? saved.length : initialSavedCount');
    const panel = read("components/study-side-panel.tsx");
    expect(panel).toContain("Notes ({active.length + savedAnswerCount})");
    const queries = read("lib/tutor-queries.ts");
    const count = queries.slice(queries.indexOf("export async function countSavedAnswers"));
    expect(count.slice(0, count.indexOf("\n}\n"))).toContain("ownedReviewer(reviewerId, userId)");
    expect(count.slice(0, count.indexOf("\n}\n"))).toContain("isNotNull(packChatMessages.savedAt)");
  });

  it("scrolls to an existing answer when the server reuses one", () => {
    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain("if (data.reused)");
    expect(provider).toContain("setScrollToMessageId(target?.id ?? null)");
    expect(provider).toContain("setScrollToMessageId(null)");
  });

  it("starts the desktop panel below the app header so header controls stay usable", () => {
    const panel = read("components/ask-panel.tsx");
    expect(panel).toContain("top-[calc(3.5rem+1px)]");
    expect(panel).not.toContain("inset-y-0");
    // The header's inner bar is h-14 with a 1px border; the sheet on phones is bottom anchored.
    expect(read("components/app-shell.tsx")).toContain("h-14");
    expect(panel).toContain("max-[640px]:top-auto");
  });

  it("pads the study column on desktop while the panel is open", () => {
    const provider = read("components/ask-provider.tsx");
    expect(provider).toContain("min-[641px]:data-[ask-open=true]:pr-[min(420px,40vw)]");
  });

  it("puts Search packs in the shared app shell with a debounced, abortable fetch", () => {
    const shell = read("components/app-shell.tsx");
    expect(shell).toContain("<SearchPacks />");
    const search = read("components/search-packs.tsx");
    expect(search).toContain("SearchPacksButton");
    expect(search).toContain("SearchDialog");
    expect(search).toContain("/api/search?q=");
    expect(search).toContain("SEARCH_DEBOUNCE_MS = 250");
    expect(search).toContain("AbortController");
    expect(search).toContain("controller.abort()");
    expect(search).toContain("parseSearchQuery");
    expect(search).not.toContain("—");
  });

  it("opens a search link by upload id, falls back to the citation index, then drops the params", () => {
    const tabs = read("components/view-tabs.tsx");
    expect(tabs).toContain("<SourceDeepLink />");
    expect(tabs).toContain('params.get("sourceId")');
    expect(tabs).toContain("openSourceById({ sourceId, page })");
    expect(tabs).toContain("UUID_PATTERN.test(sourceId)");
    // The index is only the fallback when there is no (known) sourceId.
    expect(tabs).toMatch(/if \(!opened && Number\.isInteger\(source\) && source >= 1\) openSource\(\{ source, page \}\)/);
    for (const param of ["sourceId", "source", "page"]) expect(tabs).toContain(`params.delete("${param}")`);
    expect(tabs).toContain("window.history.replaceState(null");
    expect(tabs).toContain("window.location.hash");
    // useSearchParams must sit under Suspense.
    expect(tabs).toMatch(/<Suspense fallback=\{null\}>\s*<SourceDeepLink \/>/);
    // The pack's uploads reach the viewer from the workspace.
    expect(tabs).toContain("packSources={packSources}");
    expect(read("components/reviewer-workspace.tsx")).toContain("packSources={packSources}");
  });

  it("resolves an upload id from the pack's sources without touching citation chips", () => {
    const modal = read("components/source-modal.tsx");
    expect(modal).toContain("openSourceById");
    expect(modal).toContain("packSources?.some((entry) => entry.id === args.sourceId)");
    // Chips still resolve S<n> through the view's own list, so legacy documents keep the unavailable message.
    expect(modal).toContain("citationSources?.find((entry) => entry.index === target.source)");
    expect(modal).toContain("const available = Boolean(citationSources && citationSources.length > 0);");
  });

  it("keeps the new wiring free of em dashes and non-Phosphor icons", () => {
    for (const file of ["components/ask-provider.tsx", "components/search-packs.tsx"]) {
      expect(read(file), file).not.toContain("—");
    }
    expect(read("components/ask-provider.tsx")).toContain("@phosphor-icons/react");
    expect(read("components/unsourced-tag.tsx")).not.toContain("—");
  });
});
