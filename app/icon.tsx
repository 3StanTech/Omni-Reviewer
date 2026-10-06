import { ImageResponse } from "next/og";

// Night look `--primary: oklch(0.75 0.13 180)` in app/globals.css.
export const MARK_BACKGROUND = "#24c8b1";

// Phosphor BookOpen, bold weight (@phosphor-icons/react defs/BookOpen).
const BOOK_OPEN_BOLD =
  "M232,44H160a43.86,43.86,0,0,0-32,13.85A43.86,43.86,0,0,0,96,44H24A12,12,0,0,0,12,56V200a12,12,0,0,0,12,12H96a20,20,0,0,1,20,20,12,12,0,0,0,24,0,20,20,0,0,1,20-20h72a12,12,0,0,0,12-12V56A12,12,0,0,0,232,44ZM96,188H36V68H96a20,20,0,0,1,20,20V192.81A43.79,43.79,0,0,0,96,188Zm124,0H160a43.71,43.71,0,0,0-20,4.83V88a20,20,0,0,1,20-20h60Z";

/** Full-bleed app mark; the glyph stays inside the maskable safe zone. */
export function renderMark(size: number) {
  const glyph = Math.round(size * 0.55);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: MARK_BACKGROUND,
        }}
      >
        <svg width={glyph} height={glyph} viewBox="0 0 256 256" fill="#ffffff">
          <path d={BOOK_OPEN_BOLD} />
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
}

const SIZES = [192, 512] as const;

export function generateImageMetadata() {
  return SIZES.map((px) => ({
    id: String(px),
    contentType: "image/png",
    size: { width: px, height: px },
  }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const px = Number(await id) === 192 ? 192 : 512;
  return renderMark(px);
}
