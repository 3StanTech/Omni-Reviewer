"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ChatCircleDots, WarningCircle } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { MAX_ASK_QUESTION_CHARS } from "@/lib/ask-types";
import { stripCitations, unsourcedTokenOffsets, type UnsourcedResolution } from "@/lib/citations";
import { unsourcedClaimKey } from "@/lib/grounding";
import { cn } from "@/lib/utils";

export const UNSOURCED_TAG_LABEL = "Not from your uploaded sources";
export const UNSOURCED_EXPLANATION_TITLE = "This sentence did not come from your uploaded sources.";
export const UNSOURCED_EXPLANATION_BODY =
  "The model added it. The checker searched every page of your uploads and found nothing that supports it. It may be correct general knowledge, or it may be wrong, and your professor may not test it.";
/** Used when the grounding check was truncated or its verifier failed. */
export const UNSOURCED_INCOMPLETE_CHECK_TEXT =
  "This sentence did not match your uploaded sources, and the full check could not run this time. It may still be supported. Check the cited slide before you rely on it.";

/** Why a tag without recorded missing terms was placed: the verifier rejected it (or it predates reasons). */
export const UNSOURCED_VERIFIER_REASON = "The checker could not match this sentence to its cited page.";

/** The tag's reason line: the terms the sources never mention, else the verifier's rejection. */
export function unsourcedReasonText(terms: readonly string[] | null | undefined): string {
  return terms && terms.length > 0 ? `Not found in your sources: ${terms.join(", ")}` : UNSOURCED_VERIFIER_REASON;
}

/** The recorded missing terms of the nth rendered tag of `content`, or null when none were recorded. */
export function unsourcedTagTerms(
  content: string,
  occurrence: number,
  termFlags: Readonly<Record<string, readonly string[]>>,
): readonly string[] | null {
  const offset = unsourcedTokenOffsets(content)[occurrence];
  if (offset === undefined) return null;
  const key = unsourcedClaimKey(content, offset);
  return key ? termFlags[key] ?? null : null;
}

/** Class names for the claim wrapper; `data-active` is toggled by its tag. */
export const UNSOURCED_CLAIM_CLASS =
  "study-claim rounded-[2px] underline decoration-transparent decoration-2 underline-offset-4 transition-[text-decoration-color,background-color] duration-150 data-[active]:bg-warning/12 data-[active]:decoration-warning";

type UnsourcedActions = {
  /** Resolve the nth rendered tag. Resolves true when saved. */
  resolve: (occurrence: number, action: UnsourcedResolution) => Promise<boolean>;
  disabled: boolean;
  /** From the view's grounding report: true when it was truncated or the verifier failed. */
  checkIncomplete?: boolean;
  /** From the view's grounding report (empty when none were recorded); without it no reason line shows. */
  termFlags?: Readonly<Record<string, readonly string[]>>;
  /** The Markdown the tags were rendered from, to find each tag's claim. */
  content?: string;
};

const UnsourcedActionsContext = createContext<UnsourcedActions | null>(null);
export const UnsourcedActionsProvider = UnsourcedActionsContext.Provider;

/**
 * Set by the pack's Ask provider: sends the tagged sentence to Ask as an
 * "Ask why" question. Null outside a pack, and the action stays hidden there.
 */
const AskWhyContext = createContext<((sentence: string) => void) | null>(null);
export const AskWhyProvider = AskWhyContext.Provider;

function claimBefore(root: HTMLElement | null): HTMLElement | null {
  const previous = root?.previousElementSibling;
  return previous instanceof HTMLElement && previous.classList.contains("study-claim") ? previous : null;
}

/** The tagged sentence as plain text: chips and citations removed, bounded for the Ask limit. */
function claimSentence(root: HTMLElement | null): string {
  const claim = claimBefore(root);
  if (!claim) return "";
  const copy = claim.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-study-skip]").forEach((node) => node.remove());
  return stripCitations(copy.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ASK_QUESTION_CHARS);
}

const POPOVER_MAX_WIDTH = 320;
const VIEWPORT_GUTTER = 16;

/**
 * The `[[unsourced]]` marker. The span keeps the `study-unsourced` class the
 * print stylesheet swaps for plain text, and `data-study-skip` so the
 * annotation text model never counts it.
 */
export function UnsourcedTag({ occurrence, inert = false }: { occurrence: number | null; inert?: boolean }) {
  const actions = useContext(UnsourcedActionsContext);
  const askWhy = useContext(AskWhyContext);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const claimId = useId();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [pending, setPending] = useState(false);
  const [sentence, setSentence] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});

  useEffect(() => {
    const claim = claimBefore(rootRef.current);
    if (!claim) return;
    if (!claim.id) claim.id = claimId;
    buttonRef.current?.setAttribute("aria-describedby", claim.id);
  }, [claimId]);

  useEffect(() => {
    const claim = claimBefore(rootRef.current);
    if (!claim) return;
    if (hover || open) claim.setAttribute("data-active", "");
    else claim.removeAttribute("data-active");
  }, [hover, open]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setSentence(askWhy ? claimSentence(rootRef.current) : "");
    setReason(
      actions?.termFlags && actions.content !== undefined && occurrence !== null
        ? unsourcedReasonText(unsourcedTagTerms(actions.content, occurrence, actions.termFlags))
        : null,
    );
    const rect = rootRef.current?.getBoundingClientRect();
    const width = Math.min(POPOVER_MAX_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    if (rect) {
      // Keep the popover inside the viewport so 390px screens never scroll sideways.
      const minLeft = VIEWPORT_GUTTER - rect.left;
      const maxLeft = window.innerWidth - VIEWPORT_GUTTER - width - rect.left;
      setPopoverStyle({ width, left: Math.max(minLeft, Math.min(0, maxLeft)) });
    } else {
      setPopoverStyle({ width });
    }
    setOpen(true);
  }

  async function resolve(action: UnsourcedResolution) {
    if (!actions || occurrence === null || pending) return;
    setPending(true);
    const saved = await actions.resolve(occurrence, action);
    setPending(false);
    if (saved) setOpen(false);
  }

  const tagClass =
    "inline-flex items-center gap-1 rounded-[5px] bg-warning/18 px-1.5 align-[1px] font-sans text-[0.7rem] leading-[1.6] font-semibold whitespace-nowrap text-warning not-italic no-underline select-none";

  if (inert) {
    return (
      <span data-study-skip="" className="study-unsourced">
        <span className={cn(tagClass, "ml-1")}>
          <WarningCircle weight="bold" className="size-3" aria-hidden />
          {UNSOURCED_TAG_LABEL}
        </span>
      </span>
    );
  }

  const canAct = Boolean(actions) && occurrence !== null;
  const canAskWhy = Boolean(askWhy) && sentence.length > 0;
  const actionsDisabled = !actions || actions.disabled || pending;

  return (
    <span ref={rootRef} data-study-skip="" className="study-unsourced relative ml-1 inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={popoverId}
        className={cn(
          tagClass,
          "relative cursor-help transition-colors duration-150 outline-none hover:bg-warning/28 focus-visible:ring-3 focus-visible:ring-ring/50",
          "pointer-coarse:before:absolute pointer-coarse:before:inset-x-[-4px] pointer-coarse:before:inset-y-[-13px] pointer-coarse:before:content-['']",
        )}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
      >
        <WarningCircle weight="bold" className="size-3" aria-hidden />
        {UNSOURCED_TAG_LABEL}
      </button>
      <span
        id={popoverId}
        role="dialog"
        aria-label={UNSOURCED_TAG_LABEL}
        hidden={!open}
        style={popoverStyle}
        className="absolute top-full z-30 mt-2 block rounded-xl border border-border bg-popover p-3 text-left font-sans text-sm leading-relaxed font-normal whitespace-normal text-popover-foreground not-italic shadow-[0_10px_30px_oklch(0_0_0/40%)]"
      >
        {actions?.checkIncomplete ? (
          <>
            <span className="block">{UNSOURCED_INCOMPLETE_CHECK_TEXT}</span>
            {reason ? <span className="mt-1 block text-muted-foreground">{reason}</span> : null}
          </>
        ) : (
          <>
            <strong className="block font-semibold">{UNSOURCED_EXPLANATION_TITLE}</strong>
            {reason ? <span className="mt-1 block text-muted-foreground">{reason}</span> : null}
            <span className="mt-1 block text-muted-foreground">{UNSOURCED_EXPLANATION_BODY}</span>
          </>
        )}
        {canAct || canAskWhy ? (
          <span className="mt-3 flex flex-wrap gap-2">
            {canAct ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  disabled={actionsDisabled}
                  onClick={() => void resolve("keep")}
                >
                  Keep
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  disabled={actionsDisabled}
                  onClick={() => void resolve("delete")}
                >
                  Delete sentence
                </Button>
              </>
            ) : null}
            {canAskWhy ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-8"
                onClick={() => {
                  setOpen(false);
                  askWhy?.(sentence);
                }}
              >
                <ChatCircleDots weight="bold" aria-hidden />
                Ask why
              </Button>
            ) : null}
          </span>
        ) : null}
      </span>
    </span>
  );
}
