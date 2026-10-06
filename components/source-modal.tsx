"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CaretLeft, CaretRight, CircleNotch, FileText, Presentation } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CitationSourceRef } from "@/lib/citations";
import { locatePassage } from "@/lib/passage-locate";
import {
  PASSAGE_TINT_CLASS,
  bestScoredPage,
  itemsInSpan,
  joinTextItems,
  rangeTintPages,
  textItemBox,
  type TintBox,
  type TintTextItem,
} from "@/lib/passage-tint";

export const SOURCE_LIST_UNAVAILABLE =
  "Source list unavailable for this version. Redo to refresh citations.";

/** `claim` is the cited sentence; when set, the viewer tints the passage that best supports it. */
type OpenSourceArgs = { source: number; page: number | null; pageEnd?: number | null; claim?: string | null };

/** An upload of this pack, for opening a page by id when no citation list applies (search links). */
export type PackSourceRef = { id: string; filename: string; hasPageMarkers?: boolean | null };

type SourceViewerValue = {
  openSource: (args: OpenSourceArgs) => void;
  /**
   * Open a page of one of the pack's uploads by id, independent of any view's
   * citation list. Returns false when the pack has no such upload.
   */
  openSourceById: (args: { sourceId: string; page: number | null }) => boolean;
  /** True when the pack stores which upload each citation points to. */
  available: boolean;
};

const SourceViewerContext = createContext<SourceViewerValue>({
  openSource: () => undefined,
  openSourceById: () => false,
  available: false,
});

export function useSourceViewer(): SourceViewerValue {
  return useContext(SourceViewerContext);
}

// PDF.js documents stay parsed for the session so paging and reopening are instant.
type PdfDocument = Awaited<ReturnType<typeof import("unpdf")["getDocumentProxy"]>>;

function isPdf(ref: CitationSourceRef): boolean {
  return /\.pdf$/i.test(ref.filename);
}

type ViewerTarget = {
  source: number | null;
  sourceId: string | null;
  page: number | null;
  pageEnd: number | null;
  claim: string | null;
};

function scrollTintIntoView(element: HTMLElement) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
}

export function SourceViewerProvider({
  reviewerId,
  citationSources,
  packSources,
  children,
}: {
  reviewerId: string;
  citationSources: CitationSourceRef[] | null;
  /** The pack's uploads. Only `openSourceById` reads it; citation chips still resolve through `citationSources`. */
  packSources?: PackSourceRef[];
  children?: ReactNode;
}) {
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [documents] = useState(() => new Map<string, Promise<PdfDocument>>());
  const available = Boolean(citationSources && citationSources.length > 0);

  const openSource = useCallback((args: OpenSourceArgs) => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    setTarget({
      source: args.source,
      sourceId: null,
      page: args.page && args.page > 0 ? args.page : null,
      pageEnd: args.pageEnd ?? null,
      claim: args.claim?.trim() || null,
    });
  }, []);

  const openSourceById = useCallback(
    (args: { sourceId: string; page: number | null }) => {
      if (!packSources?.some((entry) => entry.id === args.sourceId)) return false;
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
      setTarget({
        source: null,
        sourceId: args.sourceId,
        page: args.page && args.page > 0 ? args.page : null,
        pageEnd: null,
        claim: null,
      });
      return true;
    },
    [packSources],
  );

  const value = useMemo(
    () => ({ openSource, openSourceById, available }),
    [available, openSource, openSourceById],
  );
  let ref: CitationSourceRef | null = null;
  if (target?.sourceId) {
    const entry = packSources?.find((candidate) => candidate.id === target.sourceId);
    // Unknown page marker state counts as paged: the viewer falls back to text when a page is missing.
    if (entry) ref = { index: 0, sourceId: entry.id, filename: entry.filename, hasPages: entry.hasPageMarkers !== false };
  } else if (target) {
    ref = citationSources?.find((entry) => entry.index === target.source) ?? null;
  }

  return (
    <SourceViewerContext.Provider value={value}>
      {children}
      <Dialog open={target !== null} onOpenChange={(open) => { if (!open) setTarget(null); }}>
        <DialogContent
          finalFocus={openerRef}
          className="max-h-[calc(100dvh-2rem)] grid-cols-1 overflow-y-auto sm:max-w-3xl"
        >
          {target && ref ? (
            <SourceBody
              key={`${ref.sourceId}:${target.page ?? 0}:${target.pageEnd ?? 0}:${target.claim ?? ""}`}
              reviewerId={reviewerId}
              refEntry={ref}
              initialPage={target.page}
              pageEnd={target.pageEnd}
              claim={target.claim}
              documents={documents}
            />
          ) : (
            <DialogHeader>
              <DialogTitle>Source</DialogTitle>
              <DialogDescription>{SOURCE_LIST_UNAVAILABLE}</DialogDescription>
            </DialogHeader>
          )}
        </DialogContent>
      </Dialog>
    </SourceViewerContext.Provider>
  );
}

function SourceBody({
  reviewerId,
  refEntry,
  initialPage,
  pageEnd,
  claim,
  documents,
}: {
  reviewerId: string;
  refEntry: CitationSourceRef;
  initialPage: number | null;
  pageEnd: number | null;
  claim: string | null;
  documents: Map<string, Promise<PdfDocument>>;
}) {
  const fileHref = `/api/reviewers/${reviewerId}/sources/${refEntry.sourceId}`;
  const pdfSource = isPdf(refEntry);
  // A range citation opens the page in it that best supports the claim.
  const scoresRange = Boolean(claim && initialPage !== null && refEntry.hasPages && pageEnd !== null && pageEnd > initialPage);
  const [page, setPage] = useState(initialPage);
  const [resolving, setResolving] = useState(scoresRange);
  // The claim applies to the opened page only; paging clears it.
  const [tintClaim, setTintClaim] = useState(claim);
  const [tinted, setTinted] = useState(false);
  const [pageTotal, setPageTotal] = useState<number | null>(null);
  const pdfPage = pdfSource && refEntry.hasPages ? page : null;

  useEffect(() => {
    if (!scoresRange || !claim || initialPage === null) return;
    let cancelled = false;
    const scorePage = async (candidate: number): Promise<number | null> => {
      try {
        if (pdfSource) {
          const pdf = await loadDocument(documents, refEntry.sourceId, fileHref);
          if (candidate > pdf.numPages) return null;
          const { text } = await pdfPageText(pdf, candidate);
          return locatePassage(claim, text)?.score ?? null;
        }
        const response = await fetch(`${fileHref}?view=text&page=${candidate}`);
        const payload = response.ok ? ((await response.json()) as SourceTextPayload) : null;
        return payload?.text ? locatePassage(claim, payload.text)?.score ?? null : null;
      } catch {
        return null;
      }
    };
    void (async () => {
      const pages = rangeTintPages(initialPage, pageEnd);
      const scores = await Promise.all(pages.map(async (candidate) => ({ page: candidate, score: await scorePage(candidate) })));
      if (cancelled) return;
      const best = bestScoredPage(scores);
      if (best !== null) setPage(best);
      setResolving(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [claim, documents, fileHref, initialPage, pageEnd, pdfSource, refEntry.sourceId, scoresRange]);

  const changePage = (next: (current: number | null) => number | null) => {
    setTintClaim(null);
    setTinted(false);
    setPage(next);
  };
  // Paging works for rendered PDF pages and for page-marked text alike.
  const navPage = refEntry.hasPages ? page : null;
  const Icon = refEntry.hasPages ? Presentation : FileText;
  const pageLabel = page === null
    ? "Cited as the whole source"
    : pageTotal
      ? `Slide ${page} of ${pageTotal}`
      : `Slide ${page}`;

  return (
    <>
      <DialogHeader className="pr-10">
        <DialogTitle className="flex min-w-0 items-center gap-2">
          <Icon className="size-5 shrink-0 text-primary" />
          <span className="truncate">{refEntry.filename}</span>
        </DialogTitle>
        <DialogDescription>
          {pageLabel}
          {tinted ? <span className="sr-only"> Supporting passage highlighted</span> : null}
        </DialogDescription>
      </DialogHeader>
      {resolving ? (
        <div className="flex min-h-40 items-center justify-center gap-2 rounded-lg border border-border bg-muted/30 text-sm text-muted-foreground" role="status">
          <CircleNotch className="size-4 animate-spin" />
          Loading slide
        </div>
      ) : pdfPage !== null ? (
        <PdfPage
          fileHref={fileHref}
          sourceId={refEntry.sourceId}
          page={pdfPage}
          claim={tintClaim}
          documents={documents}
          onPageCount={setPageTotal}
          onTint={setTinted}
        />
      ) : (
        <SourceText
          fileHref={fileHref}
          filename={refEntry.filename}
          page={page}
          claim={tintClaim}
          onPageCount={setPageTotal}
          onTint={setTinted}
        />
      )}
      {navPage !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={resolving || navPage <= 1}
            onClick={() => changePage((current) => (current && current > 1 ? current - 1 : current))}
          >
            <CaretLeft />
            {navPage > 1 ? `Slide ${navPage - 1}` : "Previous"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={resolving || pageTotal === null || navPage >= pageTotal}
            onClick={() => changePage((current) => (current && pageTotal && current < pageTotal ? current + 1 : current))}
          >
            {pageTotal !== null && navPage < pageTotal ? `Slide ${navPage + 1}` : "Next"}
            <CaretRight />
          </Button>
        </div>
      ) : null}
    </>
  );
}

type SourceTextPayload = { page: number | null; pageCount: number; text: string | null; hasFile: boolean };

/** Extracted text of the cited page, for sources without a PDF page to draw. */
function SourceText({
  fileHref,
  filename,
  page,
  claim,
  onPageCount,
  onTint,
}: {
  fileHref: string;
  filename: string;
  page: number | null;
  claim: string | null;
  onPageCount: (count: number) => void;
  onTint: (tinted: boolean) => void;
}) {
  const textHref = `${fileHref}?view=text${page === null ? "" : `&page=${page}`}`;
  const [result, setResult] = useState<{ href: string; payload: SourceTextPayload | null } | null>(null);
  const markRef = useRef<HTMLElement>(null);
  const text = result?.href === textHref ? result.payload?.text ?? null : null;
  const span = useMemo(() => (claim && text ? locatePassage(claim, text) : null), [claim, text]);

  useEffect(() => {
    if (!span) return;
    onTint(true);
    if (markRef.current) scrollTintIntoView(markRef.current);
  }, [onTint, span]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(textHref);
        const payload = response.ok ? ((await response.json()) as SourceTextPayload) : null;
        if (cancelled) return;
        if (payload && payload.pageCount > 0) onPageCount(payload.pageCount);
        setResult({ href: textHref, payload });
      } catch {
        if (!cancelled) setResult({ href: textHref, payload: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onPageCount, textHref]);

  const current = result?.href === textHref ? result : null;
  if (!current) {
    return (
      <div className="flex min-h-40 items-center justify-center gap-2 rounded-lg border border-border bg-muted/30 text-sm text-muted-foreground" role="status">
        <CircleNotch className="size-4 animate-spin" />
        Loading text
      </div>
    );
  }
  const payload = current.payload;
  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted/30 px-4 py-4 text-sm leading-relaxed">
      {payload?.text ? (
        <p className="max-h-[60dvh] overflow-y-auto whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
          {span ? (
            <>
              {payload.text.slice(0, span.start)}
              <mark ref={markRef} className={PASSAGE_TINT_CLASS.textMark}>{payload.text.slice(span.start, span.end)}</mark>
              {payload.text.slice(span.end)}
            </>
          ) : (
            payload.text
          )}
        </p>
      ) : (
        <p role="alert" className="text-muted-foreground">
          {payload ? `Slide ${page} has no text in this source.` : "Could not load the text of this source."}
        </p>
      )}
      {payload?.hasFile ? (
        <a
          href={fileHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          Open {filename}
        </a>
      ) : null}
    </div>
  );
}

function loadDocument(
  documents: Map<string, Promise<PdfDocument>>,
  sourceId: string,
  fileHref: string,
): Promise<PdfDocument> {
  const cached = documents.get(sourceId);
  if (cached) return cached;
  const loading = (async () => {
    const response = await fetch(fileHref);
    if (!response.ok) throw new Error("Source file unavailable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const { getDocumentProxy } = await import("unpdf");
    return getDocumentProxy(bytes);
  })();
  documents.set(sourceId, loading);
  loading.catch(() => documents.delete(sourceId));
  return loading;
}

type PdfPageProxy = Awaited<ReturnType<PdfDocument["getPage"]>>;

/** A page's text items joined into one string, as `locatePassage` scores it. */
async function pdfPageText(pdf: PdfDocument, page: number, loaded?: PdfPageProxy) {
  const pdfPage = loaded ?? (await pdf.getPage(page));
  const content = await pdfPage.getTextContent();
  const items: TintTextItem[] = content.items.flatMap((item) => ("str" in item ? [item] : []));
  return { items, ...joinTextItems(items) };
}

function PdfPage({
  fileHref,
  sourceId,
  page,
  claim,
  documents,
  onPageCount,
  onTint,
}: {
  fileHref: string;
  sourceId: string;
  page: number;
  claim: string | null;
  documents: Map<string, Promise<PdfDocument>>;
  onPageCount: (count: number) => void;
  onTint: (tinted: boolean) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const firstBoxRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  const [width, setWidth] = useState(0);
  const [status, setStatus] = useState<{ key: string; state: "ready" | "error"; message?: string } | null>(null);
  const [tint, setTint] = useState<{ key: string; boxes: TintBox[] } | null>(null);
  const renderKey = `${sourceId}:${page}:${width}`;
  const boxes = claim && tint?.key === renderKey ? tint.boxes : null;

  useEffect(() => {
    if (!boxes?.length) return;
    onTint(true);
    // Scroll once per open; a width change only redraws the boxes.
    if (scrolledRef.current || !firstBoxRef.current) return;
    scrolledRef.current = true;
    scrollTintIntoView(firstBoxRef.current);
  }, [boxes, onTint]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      try {
        const pdf = await loadDocument(documents, sourceId, fileHref);
        if (cancelled) return;
        onPageCount(pdf.numPages);
        if (page < 1 || page > pdf.numPages) {
          setStatus({ key: renderKey, state: "error", message: `This file has ${pdf.numPages} slides, so slide ${page} is not in it.` });
          return;
        }
        const pdfPage = await pdf.getPage(page);
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: width / base.width });
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        task = pdfPage.render({
          canvas,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        await task.promise;
        if (cancelled) return;
        setStatus({ key: renderKey, state: "ready" });
        if (!claim) return;
        try {
          const { items, text, ranges } = await pdfPageText(pdf, page, pdfPage);
          const span = locatePassage(claim, text);
          if (cancelled || !span) return;
          const tintBoxes = itemsInSpan(ranges, span)
            .map((index) => textItemBox(viewport.transform, viewport.scale, items[index]))
            .filter((box): box is TintBox => box !== null);
          setTint({ key: renderKey, boxes: tintBoxes });
        } catch {
          // No tint: the slide still shows as it does without a claim.
        }
      } catch {
        if (!cancelled) setStatus({ key: renderKey, state: "error", message: "Could not show this slide. Open the file instead." });
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [claim, documents, fileHref, onPageCount, page, renderKey, sourceId, width]);

  const current = status?.key === renderKey ? status : null;
  return (
    <div ref={frameRef} className="relative w-full overflow-hidden rounded-lg border border-border bg-white">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Slide ${page}`}
        className={current?.state === "ready" ? "block" : "block opacity-0"}
      />
      {boxes?.length && current?.state === "ready" ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {boxes.map((box, index) => (
            <div
              key={index}
              ref={index === 0 ? firstBoxRef : undefined}
              className={PASSAGE_TINT_CLASS.canvasBox}
              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            />
          ))}
        </div>
      ) : null}
      {current?.state === "error" ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {current.message}{" "}
          <a href={fileHref} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
            Open the file
          </a>
        </p>
      ) : null}
      {!current ? (
        <div className="absolute inset-0 flex min-h-40 items-center justify-center gap-2 text-sm text-neutral-600" role="status">
          <CircleNotch className="size-4 animate-spin" />
          Loading slide
        </div>
      ) : null}
    </div>
  );
}
