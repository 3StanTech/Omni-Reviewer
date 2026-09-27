import { deflateRawSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  extractOfficeText,
  MAX_OFFICE_COMPRESSION_RATIO,
  MAX_OFFICE_ENTRY_BYTES,
  MAX_OFFICE_TEXT_CHARS,
  MAX_OFFICE_XML_BYTES,
} from "@/lib/office";
import { hasPageMarkers, pageMarkerOverhead, splitPages } from "@/lib/source-markers";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function zip(entries: Array<{ name: string; text: string; method?: 0 | 8; uncompressedSize?: number }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const plain = new TextEncoder().encode(entry.text);
    const method = entry.method ?? 8;
    const data = method === 8 ? new Uint8Array(deflateRawSync(plain)) : plain;
    const local = new Uint8Array(30 + name.length + data.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 8, method);
    writeU32(local, 14, crc32(plain));
    writeU32(local, 18, data.length);
    writeU32(local, 22, entry.uncompressedSize ?? plain.length);
    writeU16(local, 26, name.length);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const record = new Uint8Array(46 + name.length);
    writeU32(record, 0, 0x02014b50);
    writeU16(record, 4, 20);
    writeU16(record, 6, 20);
    writeU16(record, 10, method);
    writeU32(record, 16, crc32(plain));
    writeU32(record, 20, data.length);
    writeU32(record, 24, entry.uncompressedSize ?? plain.length);
    writeU16(record, 28, name.length);
    writeU32(record, 42, offset);
    record.set(name, 46);
    central.push(record);
    offset += local.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const local of locals) {
    output.set(local, cursor);
    cursor += local.length;
  }
  const centralOffset = cursor;
  for (const record of central) {
    output.set(record, cursor);
    cursor += record.length;
  }
  writeU32(output, cursor, 0x06054b50);
  writeU16(output, cursor + 8, entries.length);
  writeU16(output, cursor + 10, entries.length);
  writeU32(output, cursor + 12, centralSize);
  writeU32(output, cursor + 16, centralOffset);
  return output;
}

describe("bounded office extraction", () => {
  it("extracts supported DOCX XML text in document order", () => {
    const bytes = zip([
      {
        name: "word/document.xml",
        text: "<w:document><w:body><w:p><w:r><w:t>First &amp; foremost</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>",
      },
    ]);
    expect(extractOfficeText(bytes, "docx")).toBe("First & foremost Second");
  });

  it("extracts PPTX slides in numeric order and ignores unrelated XML", () => {
    const bytes = zip([
      { name: "ppt/slides/slide10.xml", text: "<p:sld><a:t>Ten</a:t></p:sld>" },
      { name: "ppt/slides/slide2.xml", text: "<p:sld><a:t>Two</a:t></p:sld>" },
      { name: "ppt/presentation.xml", text: "<a:t>Ignored</a:t>" },
    ]);
    expect(extractOfficeText(bytes, "pptx")).toBe("<<<page 1>>>\n\nTwo\n\n<<<page 2>>>\n\nTen");
  });

  function presentation(relationshipIds: string[]): string {
    return `<p:presentation xmlns:r="r"><p:sldIdLst>${relationshipIds
      .map((id, index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`;
  }

  function relationships(targets: Record<string, string>): string {
    return `<Relationships>${Object.entries(targets)
      .map(([id, target]) => `<Relationship Id="${id}" Type="slide" Target="${target}"/>`)
      .join("")}<Relationship Id="rIdM" Type="slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>`;
  }

  const slide = (text: string) => `<p:sld><a:t>${text}</a:t></p:sld>`;

  it("orders PPTX pages by the presentation slide list, not file numbers", () => {
    const bytes = zip([
      { name: "ppt/slides/slide1.xml", text: slide("File one") },
      { name: "ppt/slides/slide2.xml", text: slide("File two") },
      { name: "ppt/slides/slide4.xml", text: slide("File four") },
      { name: "ppt/presentation.xml", text: presentation(["rId3", "rId1", "rId2"]) },
      {
        name: "ppt/_rels/presentation.xml.rels",
        text: relationships({
          rId1: "slides/slide1.xml",
          rId2: "/ppt/slides/slide2.xml",
          rId3: "./slides/../slides/slide4.xml",
        }),
      },
    ]);
    expect(splitPages(extractOfficeText(bytes, "pptx"))).toEqual([
      { page: 1, text: "File four" },
      { page: 2, text: "File one" },
      { page: 3, text: "File two" },
    ]);
  });

  it("falls back to slide file order when the presentation order is unreadable", () => {
    const slides = [
      { name: "ppt/slides/slide2.xml", text: slide("Two") },
      { name: "ppt/slides/slide1.xml", text: slide("One") },
    ];
    const expected = [
      { page: 1, text: "One" },
      { page: 2, text: "Two" },
    ];
    const rels = {
      name: "ppt/_rels/presentation.xml.rels",
      text: relationships({ rId1: "slides/slide1.xml", rId2: "slides/slide2.xml" }),
    };
    // Missing presentation.xml.
    expect(splitPages(extractOfficeText(zip([...slides, rels]), "pptx"))).toEqual(expected);
    // Malformed presentation.xml.
    expect(splitPages(extractOfficeText(zip([
      ...slides,
      rels,
      { name: "ppt/presentation.xml", text: "<p:presentation><p:sldIdLst>" },
    ]), "pptx"))).toEqual(expected);
    // A slide id pointing at a missing relationship.
    expect(splitPages(extractOfficeText(zip([
      ...slides,
      rels,
      { name: "ppt/presentation.xml", text: presentation(["rId2", "rId9"]) },
    ]), "pptx"))).toEqual(expected);
  });

  it("keeps slide text limits when ordering by the presentation", () => {
    const half = MAX_OFFICE_TEXT_CHARS / 2;
    const bytes = zip([
      { name: "ppt/slides/slide1.xml", text: slide("x".repeat(half)), method: 0 },
      { name: "ppt/slides/slide2.xml", text: slide("y".repeat(half)), method: 0 },
      { name: "ppt/presentation.xml", text: presentation(["rId2", "rId1"]) },
      {
        name: "ppt/_rels/presentation.xml.rels",
        text: relationships({ rId1: "slides/slide1.xml", rId2: "slides/slide2.xml" }),
      },
    ]);
    expect(() => extractOfficeText(bytes, "pptx")).toThrow("safe character limit");
  });

  it("keeps a page marker for empty slides so slide numbers match the deck", () => {
    const bytes = zip([
      { name: "ppt/slides/slide1.xml", text: "<p:sld><a:t>Intro</a:t></p:sld>" },
      { name: "ppt/slides/slide2.xml", text: "<p:sld><p:pic/></p:sld>" },
      { name: "ppt/slides/slide3.xml", text: "<p:sld><a:t>Summary</a:t></p:sld>" },
    ]);
    expect(splitPages(extractOfficeText(bytes, "pptx"))).toEqual([
      { page: 1, text: "Intro" },
      { page: 2, text: "" },
      { page: 3, text: "Summary" },
    ]);
  });

  it("rejects a PPTX whose slides are all empty", () => {
    const bytes = zip([{ name: "ppt/slides/slide1.xml", text: "<p:sld><p:pic/></p:sld>" }]);
    expect(() => extractOfficeText(bytes, "pptx")).toThrow("no extractable text");
  });

  it("counts slide markers toward the PPTX character limit", () => {
    const overhead = pageMarkerOverhead(1, true) + pageMarkerOverhead(2, false);
    const slideXml = (chars: number) => `<p:sld><a:t>${"x".repeat(chars)}</a:t></p:sld>`;
    // The text alone fits the limit; the two markers push it over.
    const half = (MAX_OFFICE_TEXT_CHARS - overhead) / 2 + 1;
    const over = zip([
      { name: "ppt/slides/slide1.xml", text: slideXml(Math.ceil(half)), method: 0 },
      { name: "ppt/slides/slide2.xml", text: slideXml(Math.floor(half)), method: 0 },
    ]);
    expect(() => extractOfficeText(over, "pptx")).toThrow("safe character limit");

    const fits = zip([
      { name: "ppt/slides/slide1.xml", text: slideXml(Math.floor(half) - 1), method: 0 },
      { name: "ppt/slides/slide2.xml", text: slideXml(Math.floor(half) - 1), method: 0 },
    ]);
    const text = extractOfficeText(fits, "pptx");
    expect(text.length).toBeLessThanOrEqual(MAX_OFFICE_TEXT_CHARS);
    expect(hasPageMarkers(text)).toBe(true);
  });

  it("leaves DOCX text unmarked", () => {
    const bytes = zip([{ name: "word/document.xml", text: "<w:document><w:t>Body</w:t></w:document>" }]);
    expect(hasPageMarkers(extractOfficeText(bytes, "docx"))).toBe(false);
  });

  it("rejects traversal paths before reading selected content", () => {
    const bytes = zip([{ name: "../word/document.xml", text: "<w:t>unsafe</w:t>" }]);
    expect(() => extractOfficeText(bytes, "docx")).toThrow("unsafe path");
  });

  it("rejects expansion-ratio and declared-entry-size abuse", () => {
    const repeated = "A".repeat(50_000);
    expect(() => extractOfficeText(zip([{ name: "word/document.xml", text: repeated }] ), "docx"))
      .toThrow("compression ratio");
    expect(() => extractOfficeText(
      zip([{ name: "word/document.xml", text: "safe", method: 0, uncompressedSize: MAX_OFFICE_ENTRY_BYTES + 1 }]),
      "docx",
    )).toThrow("safe size limit");
    expect(MAX_OFFICE_COMPRESSION_RATIO).toBe(100);
  });

  it("rejects malformed large XML without lazy-regex backtracking", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>${"x".repeat(600_000)}`;
    const start = performance.now();
    expect(() => extractOfficeText(
      zip([{ name: "word/document.xml", text: xml, method: 0 }]),
      "docx",
    )).toThrow(/malformed/i);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("rejects Office XML above the worker byte budget", () => {
    const xml = `<w:document>${"x".repeat(MAX_OFFICE_XML_BYTES)}</w:document>`;
    expect(() => extractOfficeText(
      zip([{ name: "word/document.xml", text: xml, method: 0 }]),
      "docx",
    )).toThrow(/XML.*byte limit/i);
  });

  it("decodes 500k and 800k bare ampersands in one bounded pass", () => {
    for (const size of [500_000, 800_000]) {
      const xml = `<w:document><w:body><w:p><w:r><w:t>${"&".repeat(size)}</w:t></w:r></w:p></w:body></w:document>`;
      const start = performance.now();
      const extracted = extractOfficeText(
        zip([{ name: "word/document.xml", text: xml, method: 0 }]),
        "docx",
      );
      expect(extracted).toHaveLength(size);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });
});
