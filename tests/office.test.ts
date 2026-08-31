import { deflateRawSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  extractOfficeText,
  MAX_OFFICE_COMPRESSION_RATIO,
  MAX_OFFICE_ENTRY_BYTES,
  MAX_OFFICE_XML_BYTES,
} from "@/lib/office";

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
    expect(extractOfficeText(bytes, "pptx")).toBe("Two\n\nTen");
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
