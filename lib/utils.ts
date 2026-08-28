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
