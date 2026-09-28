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

export const SOURCE_LIST_UNAVAILABLE =
  "Source list unavailable for this version. Redo to refresh citations.";

type OpenSourceArgs = { source: number; page: number | null };

type SourceViewerValue = {
  openSource: (args: OpenSourceArgs) => void;
  /** True when the pack stores which upload each citation points to. */
  available: boolean;
};

const SourceViewerContext = createContext<SourceViewerValue>({
  openSource: () => undefined,
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

export function SourceViewerProvider({
  reviewerId,
  citationSources,
  children,
}: {
  reviewerId: string;
  citationSources: CitationSourceRef[] | null;
  children?: ReactNode;
}) {
  const [target, setTarget] = useState<OpenSourceArgs | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [documents] = useState(() => new Map<string, Promise<PdfDocument>>());
  const available = Boolean(citationSources && citationSources.length > 0);

  const openSource = useCallback((args: OpenSourceArgs) => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    setTarget({ source: args.source, page: args.page && args.page > 0 ? args.page : null });
  }, []);

  const value = useMemo(() => ({ openSource, available }), [available, openSource]);
  const ref = target ? citationSources?.find((entry) => entry.index === target.source) ?? null : null;

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
              key={`${ref.sourceId}:${target.page ?? 0}`}
              reviewerId={reviewerId}
              refEntry={ref}
              initialPage={target.page}
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
  documents,
}: {
  reviewerId: string;
  refEntry: CitationSourceRef;
  initialPage: number | null;
  documents: Map<string, Promise<PdfDocument>>;
}) {
  const [page, setPage] = useState(initialPage);
  const [pageTotal, setPageTotal] = useState<number | null>(null);
  const fileHref = `/api/reviewers/${reviewerId}/sources/${refEntry.sourceId}`;
  const pdfPage = isPdf(refEntry) && refEntry.hasPages ? page : null;
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
        <DialogDescription>{pageLabel}</DialogDescription>
      </DialogHeader>
      {pdfPage !== null ? (
        <PdfPage
          fileHref={fileHref}
          sourceId={refEntry.sourceId}
          page={pdfPage}
          documents={documents}
          onPageCount={setPageTotal}
        />
      ) : (
        <SourceText
          fileHref={fileHref}
          filename={refEntry.filename}
          page={page}
          onPageCount={setPageTotal}
        />
      )}
      {navPage !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={navPage <= 1}
            onClick={() => setPage((current) => (current && current > 1 ? current - 1 : current))}
          >
            <CaretLeft />
            {navPage > 1 ? `Slide ${navPage - 1}` : "Previous"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={pageTotal === null || navPage >= pageTotal}
            onClick={() => setPage((current) => (current && pageTotal && current < pageTotal ? current + 1 : current))}
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
  onPageCount,
}: {
  fileHref: string;
  filename: string;
  page: number | null;
  onPageCount: (count: number) => void;
}) {
  const textHref = `${fileHref}?view=text${page === null ? "" : `&page=${page}`}`;
  const [result, setResult] = useState<{ href: string; payload: SourceTextPayload | null } | null>(null);

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
        <p className="max-h-[60dvh] overflow-y-auto whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">{payload.text}</p>
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

function PdfPage({
  fileHref,
  sourceId,
  page,
  documents,
  onPageCount,
}: {
  fileHref: string;
  sourceId: string;
  page: number;
  documents: Map<string, Promise<PdfDocument>>;
  onPageCount: (count: number) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [status, setStatus] = useState<{ key: string; state: "ready" | "error"; message?: string } | null>(null);
  const renderKey = `${sourceId}:${page}:${width}`;

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
        if (!cancelled) setStatus({ key: renderKey, state: "ready" });
      } catch {
        if (!cancelled) setStatus({ key: renderKey, state: "error", message: "Could not show this slide. Open the file instead." });
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [documents, fileHref, onPageCount, page, renderKey, sourceId, width]);

  const current = status?.key === renderKey ? status : null;
  return (
    <div ref={frameRef} className="relative w-full overflow-hidden rounded-lg border border-border bg-white">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Slide ${page}`}
        className={current?.state === "ready" ? "block" : "block opacity-0"}
      />
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
