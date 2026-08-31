import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Client-safe filename sanitizer for blob path segments. */
export function safeClientFilename(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() || "file";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  const sliced = cleaned.slice(0, 180);
  return sliced.length > 0 ? sliced : "file";
}

export function buildClientBlobPathname(
  userId: string,
  reviewerId: string,
  filename: string,
): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `users/${userId}/reviewers/${reviewerId}/${id}-${safeClientFilename(filename)}`;
}

const SAFE_MARKDOWN_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Return a link target that is safe to place in rendered Markdown, or null
 * when the target uses an executable or otherwise unsupported protocol.
 * Relative links are retained for in-app references; external links are
 * limited to HTTP(S) and mailto.
 */
export function sanitizeMarkdownUrl(value: string): string | null {
  const target = value.trim();
  if (!target) return null;

  // Fragment and path links do not need URL parsing and cannot execute script.
  if (
    target.startsWith("#") ||
    target.startsWith("/") ||
    target.startsWith("./") ||
    target.startsWith("../")
  ) {
    return target;
  }

  try {
    const parsed = new URL(target, "https://omni-reviewer.invalid");
    if (!SAFE_MARKDOWN_PROTOCOLS.has(parsed.protocol)) return null;
    return target;
  } catch {
    return null;
  }
}

export function isSafeMarkdownUrl(value: string): boolean {
  return sanitizeMarkdownUrl(value) !== null;
}

export async function readApiError(res: Response): Promise<string> {
  try {
    const data: unknown = await res.json();
    if (
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
    ) {
      return (data as { error: string }).error;
    }
  } catch {
    // ignore
  }
  return res.statusText || "Request failed";
}
