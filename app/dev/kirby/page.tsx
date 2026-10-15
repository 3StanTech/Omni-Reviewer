import { notFound } from "next/navigation";

import { KirbySheet } from "./kirby-sheet";

export const metadata = { title: "Kirby art sheet" };

/** Dev-only preview of every Kirby piece, pose and reaction (404 in production builds). */
export default function KirbySheetPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <KirbySheet />;
}
