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
import {
  ArrowsIn,
  ArrowsOut,
  CaretLeft,
  CaretRight,
  CircleNotch,
  FileText,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Presentation,
} from "@phosphor-icons/react";

import { WaddleDee } from "@/components/kirby-art";
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
import { readLocalStorage, removeLocalStorage, writeLocalStorage } from "@/lib/safe-storage";
import { cn } from "@/lib/utils";

/** The loading mark: a spinner, or in Dream Land Waddle Dee holding up a page. */
function LoadingHelper() {
  return (
    <>
      <CircleNotch className="size-4 animate-spin dreamland:hidden" />
      <WaddleDee holding="page" className="hidden w-12 print-hide dreamland:block" />
    </>
  );
}

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

/** Per-device memory of the full-screen layout; "1" when on. */
const FULL_SCREEN_KEY = "omni-source-fullscreen";
/** Zoom steps relative to Fit (1 = the page width fits the view). */
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3];
/** iOS Safari's canvas area limit, in backing pixels. */
const CANVAS_AREA_LIMIT = 16_777_216;

function readFullScreen(): boolean {
  return readLocalStorage(FULL_SCREEN_KEY) === "1";
}

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
  // Open is separate from the target so the closing animation keeps showing the page.
  const [open, setOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const [documents] = useState(() => new Map<string, Promise<PdfDocument>>());
  const available = Boolean(citationSources && citationSources.length > 0);

  const openSource = useCallback((args: OpenSourceArgs) => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    setFullScreen(readFullScreen());
    setOpen(true);
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
      setFullScreen(readFullScreen());
      setOpen(true);
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

  const toggleFullScreen = useCallback((next: boolean) => {
    setFullScreen(next);
    if (next) writeLocalStorage(FULL_SCREEN_KEY, "1");
    else removeLocalStorage(FULL_SCREEN_KEY);
  }, []);

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
      <Dialog
        open={open}
        onOpenChange={(next, details) => {
          if (next) return;
          // Esc leaves full screen first; a second Esc closes.
          if (details.reason === "escape-key" && fullScreen) {
            details.cancel();
            toggleFullScreen(false);
            return;
          }
          setOpen(false);
        }}
        onOpenChangeComplete={(next) => {
          if (!next) setTarget(null);
        }}
      >
        <DialogContent
          finalFocus={openerRef}
          className={
            fullScreen
              ? "inset-0 top-0 left-0 h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-none border-0 pt-[max(env(safe-area-inset-top),0.75rem)] pr-[max(env(safe-area-inset-right),0.75rem)] pb-[max(env(safe-area-inset-bottom),0.75rem)] pl-[max(env(safe-area-inset-left),0.75rem)] sm:max-w-none"
              : "max-h-[calc(100dvh-2rem)] grid-cols-1 overflow-y-auto sm:max-w-3xl"
          }
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
              fullScreen={fullScreen}
              onFullScreen={toggleFullScreen}
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
  fullScreen,
  onFullScreen,
}: {
  reviewerId: string;
  refEntry: CitationSourceRef;
  initialPage: number | null;
  pageEnd: number | null;
  claim: string | null;
  documents: Map<string, Promise<PdfDocument>>;
  fullScreen: boolean;
  onFullScreen: (next: boolean) => void;
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
  // Zoom is relative to Fit, kept while paging and reset per open (this body remounts per target).
  const [zoom, setZoom] = useState(1);
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
  const stepZoom = (direction: 1 | -1) => {
    setZoom((current) => {
      const index = ZOOM_STEPS.indexOf(current);
      const nextIndex = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
      return ZOOM_STEPS[nextIndex];
    });
  };
  // Paging works for rendered PDF pages and for page-marked text alike.
  const navPage = refEntry.hasPages ? page : null;
  const Icon = refEntry.hasPages ? Presentation : FileText;
  const pageLabel = page === null
    ? "Cited as the whole source"
    : pageTotal
      ? `Page ${page} of ${pageTotal}`
      : `Page ${page}`;
  const showZoom = fullScreen && pdfPage !== null;
  const showToolbar = fullScreen && (showZoom || navPage !== null);
  // In full screen the page area fills the last grid row and scrolls; without a toolbar it takes that row too.
  const areaClassName = fullScreen ? cn("min-h-0", !showToolbar && "row-span-2") : undefined;
  const toolbarButtonClass = "min-h-11 sm:min-h-8";
  const zoomMin = ZOOM_STEPS[0];
  const zoomMax = ZOOM_STEPS[ZOOM_STEPS.length - 1];

  const prevButton = navPage !== null ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={toolbarButtonClass}
      disabled={resolving || navPage <= 1}
      onClick={() => changePage((current) => (current && current > 1 ? current - 1 : current))}
    >
      <CaretLeft />
      {navPage > 1 ? `Page ${navPage - 1}` : "Previous"}
    </Button>
  ) : null;
  const nextButton = navPage !== null ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={toolbarButtonClass}
      disabled={resolving || pageTotal === null || navPage >= pageTotal}
      onClick={() => changePage((current) => (current && pageTotal && current < pageTotal ? current + 1 : current))}
    >
      {pageTotal !== null && navPage < pageTotal ? `Page ${navPage + 1}` : "Next"}
      <CaretRight />
    </Button>
  ) : null;

  return (
    <>
      <DialogHeader className="pr-24 sm:pr-20">
        <DialogTitle className="flex min-w-0 items-center gap-2">
          <Icon className="size-5 shrink-0 text-primary" />
          <span className="truncate">{refEntry.filename}</span>
        </DialogTitle>
        <DialogDescription className={showToolbar && navPage !== null ? "sr-only" : undefined}>
          {pageLabel}
          {tinted ? <span className="sr-only"> Supporting passage highlighted</span> : null}
        </DialogDescription>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-2.5 right-12 min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          aria-label={fullScreen ? "Exit full screen" : "Full screen"}
          aria-pressed={fullScreen}
          onClick={() => onFullScreen(!fullScreen)}
        >
          {fullScreen ? <ArrowsIn weight="bold" /> : <ArrowsOut weight="bold" />}
        </Button>
      </DialogHeader>
      {showToolbar ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          {showZoom ? (
            <div className="flex items-center gap-1" role="group" aria-label="Zoom">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                aria-label="Zoom out"
                disabled={resolving || zoom <= zoomMin}
                onClick={() => stepZoom(-1)}
              >
                <MagnifyingGlassMinus />
              </Button>
              <span className="min-w-12 text-center text-sm tabular-nums text-muted-foreground" aria-live="polite">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                aria-label="Zoom in"
                disabled={resolving || zoom >= zoomMax}
                onClick={() => stepZoom(1)}
              >
                <MagnifyingGlassPlus />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={toolbarButtonClass}
                disabled={resolving || zoom === zoomMin}
                onClick={() => setZoom(zoomMin)}
              >
                Fit
              </Button>
            </div>
          ) : null}
          {navPage !== null ? (
            <div className="flex flex-wrap items-center gap-2">
              {prevButton}
              {nextButton}
              <span className="text-sm text-muted-foreground" aria-hidden="true">{pageLabel}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {resolving ? (
        <div className={cn("flex min-h-40 items-center justify-center gap-2 rounded-lg border border-border bg-muted/30 text-sm text-muted-foreground", areaClassName)} role="status">
          <LoadingHelper />
          Loading page
        </div>
      ) : pdfPage !== null ? (
        <PdfPage
          fileHref={fileHref}
          sourceId={refEntry.sourceId}
          page={pdfPage}
          claim={tintClaim}
          documents={documents}
          zoom={fullScreen ? zoom : 1}
          fullScreen={fullScreen}
          className={areaClassName}
          onPageCount={setPageTotal}
          onTint={setTinted}
        />
      ) : (
        <SourceText
          fileHref={fileHref}
          filename={refEntry.filename}
          page={page}
          claim={tintClaim}
          fullScreen={fullScreen}
          className={areaClassName}
          onPageCount={setPageTotal}
          onTint={setTinted}
        />
      )}
      {!fullScreen && navPage !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {prevButton}
          {nextButton}
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
  fullScreen,
  className,
  onPageCount,
  onTint,
}: {
  fileHref: string;
  filename: string;
  page: number | null;
  claim: string | null;
  fullScreen: boolean;
  className?: string;
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
      <div className={cn("flex min-h-40 items-center justify-center gap-2 rounded-lg border border-border bg-muted/30 text-sm text-muted-foreground", className)} role="status">
        <LoadingHelper />
        Loading text
      </div>
    );
  }
  const payload = current.payload;
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border border-border bg-muted/30 px-4 py-4",
        // Full screen: the page area scrolls and the text reads as a wider, larger column.
        fullScreen ? "overflow-y-auto text-base leading-relaxed" : "text-sm leading-relaxed",
        className,
      )}
    >
      <div className={fullScreen ? "mx-auto w-full max-w-3xl" : undefined}>
        {payload?.text ? (
          <p className={cn("whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]", !fullScreen && "max-h-[60dvh] overflow-y-auto")}>
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
            {payload ? `Page ${page} has no text in this source.` : "Could not load the text of this source."}
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
  zoom,
  fullScreen,
  className,
  onPageCount,
  onTint,
}: {
  fileHref: string;
  sourceId: string;
  page: number;
  claim: string | null;
  documents: Map<string, Promise<PdfDocument>>;
  /** Relative to Fit: 1 renders the page at the frame's width. */
  zoom: number;
  fullScreen: boolean;
  className?: string;
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
  // The frame keeps its measured width; zoom widens the render inside it, and the frame scrolls in full screen.
  const renderWidth = Math.floor(width * zoom);
  const renderKey = `${sourceId}:${page}:${width}:${zoom}`;
  const boxes = claim && tint?.key === renderKey ? tint.boxes : null;

  useEffect(() => {
    if (!boxes?.length) return;
    onTint(true);
    // Scroll once per open; a width or zoom change only redraws the boxes.
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
    if (!canvas || renderWidth <= 0) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      try {
        const pdf = await loadDocument(documents, sourceId, fileHref);
        if (cancelled) return;
        onPageCount(pdf.numPages);
        if (page < 1 || page > pdf.numPages) {
          setStatus({ key: renderKey, state: "error", message: `This file has ${pdf.numPages} pages, so page ${page} is not in it.` });
          return;
        }
        const pdfPage = await pdf.getPage(page);
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: renderWidth / base.width });
        // Cap the backing store under iOS Safari's canvas area limit: softer above it, never blank.
        const cssArea = Math.max(1, viewport.width * viewport.height);
        const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(CANVAS_AREA_LIMIT / cssArea));
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
          // No tint: the page still shows as it does without a claim.
        }
      } catch {
        if (!cancelled) setStatus({ key: renderKey, state: "error", message: "Could not show this page. Open the file instead." });
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [claim, documents, fileHref, onPageCount, page, renderKey, renderWidth, sourceId]);

  const current = status?.key === renderKey ? status : null;
  return (
    <div
      ref={frameRef}
      className={cn(
        "relative w-full rounded-lg border border-border",
        fullScreen ? "overflow-auto bg-muted/30 [scrollbar-gutter:stable]" : "overflow-hidden bg-white",
        className,
      )}
    >
      {/* Sized to the render so the tint boxes stay on their text while the frame scrolls. */}
      <div className={cn("relative w-fit bg-white", fullScreen && "mx-auto")}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Page ${page}`}
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
      </div>
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
          <LoadingHelper />
          Loading page
        </div>
      ) : null}
    </div>
  );
}
