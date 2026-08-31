import "server-only";

import { inflateRawSync } from "node:zlib";

import { PublicError } from "@/lib/public-errors";

export type OfficeFormat = "docx" | "pptx";

export const MAX_OFFICE_ENTRIES = 2_000;
export const MAX_OFFICE_ENTRY_BYTES = 5 * 1024 * 1024;
export const MAX_OFFICE_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
export const MAX_OFFICE_COMPRESSION_RATIO = 100;
export const MAX_OFFICE_TEXT_CHARS = 1_000_000;
export const MAX_OFFICE_XML_BYTES = 3 * 1024 * 1024;
export const MAX_OFFICE_XML_NODES = 100_000;
export const MAX_OFFICE_XML_TAG_CHARS = 32_768;

export function officeFormatForKind(kind: "document" | "presentation"): OfficeFormat {
  return kind === "document" ? "docx" : "pptx";
}

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  dataStart: number;
};

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_END_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;

function officeError(message: string): PublicError {
  return new PublicError(`${message}.`);
}

function assertRange(bytes: Uint8Array, start: number, length: number): void {
  if (
    start < 0 ||
    length < 0 ||
    start > bytes.byteLength ||
    length > bytes.byteLength - start
  ) {
    throw officeError("Office archive is truncated or malformed");
  }
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function decodeFilename(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw officeError("Office archive contains an invalid filename");
  }
}

function validateEntryName(name: string): void {
  if (
    !name ||
    name.length > 512 ||
    name.includes("\u0000") ||
    name.startsWith("/") ||
    name.includes("\\")
  ) {
    throw officeError("Office archive contains an unsafe path");
  }
  const segments = name.split("/");
  const pathSegments = name.endsWith("/") ? segments.slice(0, -1) : segments;
  if (
    pathSegments.length === 0 ||
    pathSegments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw officeError("Office archive contains an unsafe path");
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.byteLength < ZIP_END_MIN_BYTES) {
    throw officeError("Office archive is too small");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = Math.max(0, bytes.byteLength - ZIP_END_MIN_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = bytes.byteLength - ZIP_END_MIN_BYTES; offset >= first; offset -= 1) {
    if (readU32(view, offset) !== ZIP_END_SIGNATURE) continue;
    const commentLength = readU16(view, offset + 20);
    if (offset + ZIP_END_MIN_BYTES + commentLength > bytes.byteLength) continue;
    return offset;
  }
  throw officeError("Office archive has no valid directory");
}

function parseEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  const disk = readU16(view, endOffset + 4);
  const centralDisk = readU16(view, endOffset + 6);
  const entriesOnDisk = readU16(view, endOffset + 8);
  const entryCount = readU16(view, endOffset + 10);
  const centralSize = readU32(view, endOffset + 12);
  const centralOffset = readU32(view, endOffset + 16);

  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entryCount > MAX_OFFICE_ENTRIES
  ) {
    throw officeError("Office archive uses unsupported ZIP features");
  }
  assertRange(bytes, centralOffset, centralSize);
  if (centralOffset + centralSize > endOffset) {
    throw officeError("Office archive directory is outside the archive");
  }

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, offset, 46);
    if (readU32(view, offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw officeError("Office archive directory is malformed");
    }
    const flags = readU16(view, offset + 8);
    const method = readU16(view, offset + 10);
    const compressedSize = readU32(view, offset + 20);
    const uncompressedSize = readU32(view, offset + 24);
    const filenameLength = readU16(view, offset + 28);
    const extraLength = readU16(view, offset + 30);
    const commentLength = readU16(view, offset + 32);
    const diskNumber = readU16(view, offset + 34);
    const externalAttributes = readU32(view, offset + 38);
    const localOffset = readU32(view, offset + 42);
    const recordLength = 46 + filenameLength + extraLength + commentLength;
    assertRange(bytes, offset, recordLength);

    if (
      flags & 0x1 ||
      diskNumber !== 0 ||
      method !== 0 && method !== 8 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw officeError("Office archive contains unsupported or unsafe entries");
    }
    const name = decodeFilename(bytes.slice(offset + 46, offset + 46 + filenameLength));
    validateEntryName(name);
    if (names.has(name)) throw officeError("Office archive contains duplicate entries");
    names.add(name);

    const unixMode = (externalAttributes >>> 16) & 0xf000;
    if (unixMode === 0xa000) throw officeError("Office archive contains a symbolic link");
    if (uncompressedSize > MAX_OFFICE_ENTRY_BYTES) {
      throw officeError("Office archive entry exceeds the safe size limit");
    }
    if (
      (compressedSize === 0 && uncompressedSize > 0) ||
      uncompressedSize > compressedSize * MAX_OFFICE_COMPRESSION_RATIO
    ) {
      throw officeError("Office archive has an unsafe compression ratio");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_OFFICE_UNCOMPRESSED_BYTES) {
      throw officeError("Office archive exceeds the safe expansion limit");
    }

    assertRange(bytes, localOffset, 30);
    if (readU32(view, localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw officeError("Office archive local entry is malformed");
    }
    const localFilenameLength = readU16(view, localOffset + 26);
    const localExtraLength = readU16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localFilenameLength + localExtraLength;
    assertRange(bytes, dataStart, compressedSize);
    const localName = decodeFilename(bytes.slice(localOffset + 30, dataStart - localExtraLength));
    if (localName !== name || readU16(view, localOffset + 8) !== method) {
      throw officeError("Office archive local entry does not match its directory");
    }

    entries.push({ name, method, compressedSize, uncompressedSize, dataStart });
    offset += recordLength;
  }
  return entries;
}

function readEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const compressed = bytes.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
  let output: Uint8Array;
  try {
    output = entry.method === 0
      ? compressed
      : new Uint8Array(
          inflateRawSync(Buffer.from(compressed), {
            maxOutputLength: MAX_OFFICE_ENTRY_BYTES,
          }),
        );
  } catch {
    throw officeError("Office archive contains invalid compressed data");
  }
  if (output.byteLength !== entry.uncompressedSize) {
    throw officeError("Office archive entry size does not match its directory");
  }
  return output;
}

function decodeXmlText(raw: string): string {
  const decodeCodePoint = (value: string, radix: number): string => {
    const codePoint = Number.parseInt(value, radix);
    return Number.isSafeInteger(codePoint) &&
      codePoint >= 0 &&
      codePoint <= 0x10ffff &&
      !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : "";
  };
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const textStart = cursor;
    while (cursor < raw.length && raw[cursor] !== "&") {
      cursor += 1;
    }
    if (cursor > textStart) parts.push(raw.slice(textStart, cursor));
    if (cursor >= raw.length) break;

    const entityStart = cursor + 1;
    let semicolon = entityStart;
    while (semicolon < raw.length && raw[semicolon] !== ";") {
      semicolon += 1;
    }
    if (semicolon >= raw.length) {
      // There cannot be a valid entity after an unterminated ampersand, so
      // preserve the remainder in one operation and finish the scan. This is
      // the important linear-time path for documents full of bare '&'.
      parts.push(raw.slice(cursor));
      break;
    }
    const entity = raw.slice(entityStart, semicolon);
    let decoded: string | undefined;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      decoded = decodeCodePoint(entity.slice(2), 16);
    } else if (entity.startsWith("#")) {
      decoded = decodeCodePoint(entity.slice(1), 10);
    } else {
      decoded = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      }[entity];
    }
    parts.push(decoded ?? raw.slice(cursor, semicolon + 1));
    cursor = semicolon + 1;
  }
  return parts.join("");
}

function stripXmlControls(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    output += character;
  }
  return output;
}

function collapseWhitespace(value: string): string {
  let output = "";
  let pendingSpace = false;
  for (const character of value) {
    if (isXmlWhitespace(character)) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) output += " ";
    output += character;
    pendingSpace = false;
  }
  return output.trim();
}

function isXmlWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t";
}

function isXmlNameStart(value: string | undefined): boolean {
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === "_" ||
    value === ":";
}

function isXmlNameCharacter(value: string | undefined): boolean {
  if (isXmlNameStart(value)) return true;
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return (code >= 48 && code <= 57) || value === "." || value === "-";
}

function parseXmlName(value: string, start: number): { name: string; end: number } {
  if (!isXmlNameStart(value[start])) {
    throw officeError("Office XML is malformed");
  }
  let end = start + 1;
  while (isXmlNameCharacter(value[end])) end += 1;
  return { name: value.slice(start, end), end };
}

function skipXmlWhitespace(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && isXmlWhitespace(value[cursor])) cursor += 1;
  return cursor;
}

function validateXmlTagBody(body: string, closing: boolean): string {
  let cursor = skipXmlWhitespace(body, 0);
  if (closing) {
    const parsed = parseXmlName(body, cursor);
    cursor = skipXmlWhitespace(body, parsed.end);
    if (cursor !== body.length) throw officeError("Office XML is malformed");
    return parsed.name;
  }

  const parsed = parseXmlName(body, cursor);
  cursor = parsed.end;
  while (cursor < body.length) {
    cursor = skipXmlWhitespace(body, cursor);
    if (cursor >= body.length) break;
    if (body[cursor] === "/") {
      cursor = skipXmlWhitespace(body, cursor + 1);
      if (cursor !== body.length) throw officeError("Office XML is malformed");
      break;
    }
    const attribute = parseXmlName(body, cursor);
    cursor = skipXmlWhitespace(body, attribute.end);
    if (body[cursor] !== "=") throw officeError("Office XML is malformed");
    cursor = skipXmlWhitespace(body, cursor + 1);
    const quote = body[cursor];
    if (quote !== '"' && quote !== "'") throw officeError("Office XML is malformed");
    const valueEnd = body.indexOf(quote, cursor + 1);
    if (valueEnd === -1) throw officeError("Office XML is malformed");
    cursor = valueEnd + 1;
  }
  return parsed.name;
}

/**
 * Small bounded XML scanner for the text-bearing Office tags. It validates
 * element nesting and attributes while never materializing a regex capture for
 * the whole XML document.
 */
function extractXmlText(xml: string): string {
  if (Buffer.byteLength(xml, "utf8") > MAX_OFFICE_XML_BYTES) {
    throw officeError("Office XML exceeds the safe byte limit");
  }
  const chunks: string[] = [];
  const stack: string[] = [];
  let capture: { depth: number; rawChunks: string[] } | null = null;
  let capturedChars = 0;
  let nodes = 0;
  let cursor = 0;
  let sawRoot = false;
  let closedRoot = false;

  const appendText = (raw: string) => {
    if (!capture) return;
    capture.rawChunks.push(raw);
    capturedChars += raw.length;
    if (capturedChars > MAX_OFFICE_TEXT_CHARS) {
      throw officeError("Office XML text exceeds the safe character limit");
    }
  };

  while (cursor < xml.length) {
    if (xml[cursor] !== "<") {
      const nextTag = xml.indexOf("<", cursor);
      const end = nextTag === -1 ? xml.length : nextTag;
      appendText(xml.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (xml.startsWith("<!--", cursor)) {
      const end = xml.indexOf("-->", cursor + 4);
      if (end === -1) throw officeError("Office XML is malformed");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", cursor)) {
      const end = xml.indexOf("]]>", cursor + 9);
      if (end === -1) throw officeError("Office XML is malformed");
      appendText(xml.slice(cursor + 9, end));
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", cursor)) {
      const end = xml.indexOf("?>", cursor + 2);
      if (end === -1) throw officeError("Office XML is malformed");
      cursor = end + 2;
      continue;
    }
    const declarationName = xml.slice(cursor, cursor + 9).toLowerCase();
    if (
      declarationName === "<!doctype" &&
      (isXmlWhitespace(xml[cursor + 9]) || xml[cursor + 9] === ">" || xml[cursor + 9] === "[")
    ) {
      throw officeError("Office XML contains an unsupported declaration");
    }
    if (xml.startsWith("<!", cursor)) {
      throw officeError("Office XML contains an unsupported declaration");
    }

    let tagEnd = cursor + 1;
    let quote: string | null = null;
    while (tagEnd < xml.length) {
      const character = xml[tagEnd];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
      tagEnd += 1;
    }
    if (tagEnd >= xml.length || quote) throw officeError("Office XML is malformed");
    const body = xml.slice(cursor + 1, tagEnd);
    if (body.length > MAX_OFFICE_XML_TAG_CHARS) {
      throw officeError("Office XML tag exceeds the safe size limit");
    }
    const closing = body.startsWith("/");
    const name = validateXmlTagBody(closing ? body.slice(1) : body, closing).toLowerCase();
    let selfClosing = false;
    if (!closing) {
      let bodyEnd = body.length - 1;
      while (bodyEnd >= 0 && isXmlWhitespace(body[bodyEnd])) bodyEnd -= 1;
      selfClosing = body[bodyEnd] === "/";
    }
    nodes += 1;
    if (nodes > MAX_OFFICE_XML_NODES) throw officeError("Office XML exceeds the safe node limit");

    if (closing) {
      if (stack.length === 0 || stack[stack.length - 1] !== name) {
        throw officeError("Office XML is malformed");
      }
      if (capture && capture.depth === stack.length) {
        const text = decodeXmlText(capture.rawChunks.join(""));
        const cleaned = stripXmlControls(text).trim();
        if (cleaned) chunks.push(cleaned);
        capture = null;
      }
      stack.pop();
    } else if (!selfClosing) {
      if (closedRoot || stack.length === 0 && sawRoot) {
        throw officeError("Office XML is malformed");
      }
      if (stack.length === 0) sawRoot = true;
      stack.push(name);
      if ((name === "w:t" || name === "a:t") && capture === null) {
        capture = { depth: stack.length, rawChunks: [] };
      } else if ((name === "w:t" || name === "a:t") && capture !== null) {
        throw officeError("Office XML is malformed");
      }
    } else if (stack.length === 0) {
      if (closedRoot || sawRoot) throw officeError("Office XML is malformed");
      sawRoot = true;
      closedRoot = true;
    }
    if (closing && stack.length === 0) closedRoot = true;
    cursor = tagEnd + 1;
  }
  if (!sawRoot || stack.length !== 0 || capture !== null || !closedRoot) {
    throw officeError("Office XML is malformed");
  }
  return collapseWhitespace(chunks.join(" "));
}

function isSelectedEntry(name: string, format: OfficeFormat): boolean {
  if (format === "docx") {
    return /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(name);
  }
  return /^ppt\/slides\/slide\d+\.xml$/i.test(name);
}

function sortSelectedEntries(entries: ZipEntry[], format: OfficeFormat): ZipEntry[] {
  return entries
    .filter((entry) => isSelectedEntry(entry.name, format))
    .sort((a, b) => {
      if (format === "docx") return a.name.localeCompare(b.name);
      const number = (name: string) => Number(name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
      return number(a.name) - number(b.name);
    });
}

export function extractOfficeText(bytes: Uint8Array, format: OfficeFormat): string {
  const entries = sortSelectedEntries(parseEntries(bytes), format);
  if (entries.length === 0) {
    throw officeError(`${format.toUpperCase()} contains no supported content`);
  }
  const sections: string[] = [];
  let totalTextChars = 0;
  for (const entry of entries) {
    const xmlBytes = readEntry(bytes, entry);
    if (xmlBytes.byteLength > MAX_OFFICE_XML_BYTES) {
      throw officeError("Office XML exceeds the safe byte limit");
    }
    const section = extractXmlText(new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes));
    if (!section) continue;
    totalTextChars += section.length;
    if (totalTextChars > MAX_OFFICE_TEXT_CHARS) {
      throw officeError(`${format.toUpperCase()} extracted text exceeds the safe character limit`);
    }
    sections.push(section);
  }
  const text = sections.join("\n\n").trim();
  if (text.length > MAX_OFFICE_TEXT_CHARS) {
    throw officeError(`${format.toUpperCase()} extracted text exceeds the safe character limit`);
  }
  if (!text) {
    throw officeError(`${format.toUpperCase()} contains no extractable text`);
  }
  return text;
}
