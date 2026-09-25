import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, posix } from "node:path";
import { unzipSync, type Unzipped } from "fflate";
import { XMLParser } from "fast-xml-parser";
import pdfWorkerSource from "pdfjs-dist/legacy/build/pdf.worker.mjs" with { type: "text" };
import type { DocumentRagConfig } from "./config.ts";
import type { PageStore } from "./database.ts";
import { AppError, type DocumentFormat, type DocumentLocator, type DocumentSectionKind } from "./domain.ts";

export const DOCUMENT_PARSER_VERSION = "nwp-documents/1";

export interface ExtractedDocumentSection {
  kind: DocumentSectionKind;
  title: string | null;
  locator: DocumentLocator;
  text: string;
  hidden: boolean;
  needsOcr: boolean;
}

export interface ExtractedDocument {
  title: string | null;
  metadata: Record<string, string | number | boolean | null>;
  sections: ExtractedDocumentSection[];
  warnings: string[];
  needsOcr: boolean;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true, parseTagValue: false, trimValues: false, processEntities: false });
const decoder = new TextDecoder();
let pdfJsPromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;

export function documentFormat(filename: string, mimeType: string): DocumentFormat {
  const extension = extname(filename).toLowerCase();
  if (extension === ".docx") return "docx";
  if (extension === ".xlsx") return "xlsx";
  if (extension === ".pptx") return "pptx";
  if (extension === ".pdf" || mimeType === "application/pdf") return "pdf";
  if (extension === ".md" || extension === ".markdown" || mimeType === "text/markdown") return "markdown";
  if (extension === ".txt" || mimeType.startsWith("text/plain")) return "text";
  throw new AppError("unsupported_document", "supported document formats are DOCX, XLSX, PPTX, PDF, Markdown, and TXT", 415);
}

export function canonicalDocumentMime(format: DocumentFormat): string {
  return {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf",
    markdown: "text/markdown",
    text: "text/plain",
  }[format];
}

export async function extractDocument(filename: string, mimeType: string, bytes: Uint8Array, config: DocumentRagConfig): Promise<ExtractedDocument> {
  if (bytes.byteLength > config.maxFileBytes) throw new AppError("document_too_large", `document exceeds the technical ${config.maxFileBytes} byte guard`, 413);
  const format = documentFormat(filename, mimeType);
  if (format === "pdf") return extractPdf(bytes, config);
  if (format === "markdown") return extractMarkdown(decodeText(bytes));
  if (format === "text") return extractText(decodeText(bytes));
  const archive = openOfficeArchive(bytes, config);
  if (format === "docx") return extractDocx(archive);
  if (format === "xlsx") return extractXlsx(archive, config);
  return extractPptx(archive);
}

export class DocumentWorker {
  readonly owner = `document-${process.pid}-${randomUUID()}`;

  constructor(private readonly store: PageStore, private readonly config: DocumentRagConfig) {}

  async runOne(): Promise<boolean> {
    const task = this.store.claimDocumentTask(this.owner);
    if (!task) return false;
    const heartbeat = setInterval(() => this.store.renewDocumentLease(task), 30_000);
    try {
      const source = this.store.documentVersionPath(task.versionId);
      const bytes = new Uint8Array(readFileSync(source.path));
      const extraction = await extractDocument(source.document.filename, source.document.mimeType, bytes, this.config);
      this.store.completeDocumentTask(task, extraction, DOCUMENT_PARSER_VERSION);
    } catch (error) {
      this.store.failDocumentTask(task, error instanceof Error ? error.message : String(error), !(error instanceof AppError && error.status < 500));
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  async runUntilIdle(): Promise<number> {
    let processed = 0;
    while (await this.runOne()) processed += 1;
    return processed;
  }

  async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!await this.runOne()) await Bun.sleep(1000);
    }
  }
}

function openOfficeArchive(bytes: Uint8Array, config: DocumentRagConfig): Unzipped {
  let entries = 0;
  let expanded = 0;
  try {
    return unzipSync(bytes, { filter: (file) => {
      entries += 1;
      expanded += file.originalSize;
      if (entries > config.maxArchiveEntries) throw new Error(`archive exceeds ${config.maxArchiveEntries} entries`);
      if (expanded > config.maxExpandedBytes) throw new Error(`archive expands beyond ${config.maxExpandedBytes} bytes`);
      if (file.originalSize > 0 && file.originalSize / Math.max(1, file.size) > config.maxCompressionRatio) throw new Error(`archive entry '${file.name}' exceeds the compression-ratio guard`);
      if (file.name.startsWith("/") || file.name.split("/").includes("..") || file.name.includes("\\")) throw new Error("archive contains an unsafe path");
      return isRelevantOfficeEntry(file.name);
    } });
  } catch (error) {
    throw new AppError("invalid_office_document", error instanceof Error ? error.message : "invalid Office archive", 422);
  }
}

function isRelevantOfficeEntry(name: string): boolean {
  return name.endsWith(".xml") || name.endsWith(".rels") || /^(word|ppt)\/media\//.test(name);
}

function extractDocx(archive: Unzipped): ExtractedDocument {
  const document = requiredXml(archive, "word/document.xml", "DOCX");
  const parsed = parseXml(document, "word/document.xml");
  const body = parsed?.document?.body ?? {};
  const sections: ExtractedDocumentSection[] = [];
  let ordinal = 1;
  for (const paragraph of asArray<Record<string, any>>(body.p)) {
    const text = officeText(paragraph);
    if (!text) continue;
    const style = findScalarByKey(paragraph.pPr, "val") ?? "";
    const heading = /^Heading/i.test(style) || /^T[ií]tulo/i.test(style);
    sections.push(section(heading ? "heading" : "paragraph", heading ? text : null, { label: heading ? `Heading: ${text}` : `Paragraph ${ordinal}`, heading: heading ? text : undefined, part: "document" }, text));
    ordinal += 1;
  }
  for (const table of asArray<Record<string, any>>(body.tbl)) {
    const rows = asArray<Record<string, any>>(table.tr).map((row) => asArray<Record<string, any>>(row.tc).map(officeText).filter(Boolean).join(" | ")).filter(Boolean);
    if (rows.length) sections.push(section("table", `Table ${ordinal}`, { label: `Table ${ordinal}`, part: "document" }, rows.join("\n")));
    ordinal += 1;
  }
  for (const [name, data] of Object.entries(archive).filter(([name]) => /^word\/(header|footer|footnotes|endnotes).*\.xml$/.test(name)).sort()) {
    const text = textFromXml(decodeXml(data, name));
    if (text) sections.push(section("paragraph", basename(name, ".xml"), { label: basename(name, ".xml"), part: name }, text));
  }
  const mediaCount = Object.keys(archive).filter((name) => name.startsWith("word/media/")).length;
  const warnings = mediaCount ? [`${mediaCount} embedded image(s) await OCR`] : [];
  const metadata = coreMetadata(archive);
  return finish(typeof metadata.title === "string" ? metadata.title : null, sections, warnings, mediaCount > 0, metadata);
}

function extractPptx(archive: Unzipped): ExtractedDocument {
  requiredXml(archive, "ppt/presentation.xml", "PPTX");
  const sections: ExtractedDocumentSection[] = [];
  const slides = Object.keys(archive).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(numericPathSort);
  for (const [index, name] of slides.entries()) {
    const slideNumber = index + 1;
    const xml = decodeXml(archive[name]!, name);
    const text = presentationText(xml, false);
    const hidden = /<(?:p:)?sld\b[^>]*\bshow=["'](?:0|false)["']/.test(xml);
    if (text) sections.push(section("slide", firstLine(text), { label: `Slide ${slideNumber}`, slide: slideNumber, part: hidden ? "hidden slide" : "slide" }, text, hidden));
    const relationshipName = `ppt/slides/_rels/${basename(name)}.rels`;
    const relationshipXml = archive[relationshipName] ? decodeXml(archive[relationshipName]!, relationshipName) : null;
    const notesTarget = relationshipXml ? relationshipTarget(relationshipXml, "notesSlide") : null;
    const notesName = notesTarget ? posix.normalize(posix.join(posix.dirname(name), notesTarget)) : `ppt/notesSlides/notesSlide${slideNumber}.xml`;
    if (archive[notesName]) {
      const notes = presentationText(decodeXml(archive[notesName]!, notesName), true);
      if (notes) sections.push(section("notes", `Notes for slide ${slideNumber}`, { label: `Slide ${slideNumber}, speaker notes`, slide: slideNumber, part: "speaker notes" }, notes, hidden));
    }
  }
  const mediaCount = Object.keys(archive).filter((name) => name.startsWith("ppt/media/")).length;
  const warnings = mediaCount ? [`${mediaCount} embedded image(s) await OCR`] : [];
  const metadata: Record<string, string | number | boolean | null> = { ...coreMetadata(archive), slides: slides.length };
  return finish(typeof metadata.title === "string" ? metadata.title : null, sections, warnings, mediaCount > 0, metadata);
}

function extractXlsx(archive: Unzipped, config: DocumentRagConfig): ExtractedDocument {
  const workbookXml = requiredXml(archive, "xl/workbook.xml", "XLSX");
  const workbook = parseXml(workbookXml, "xl/workbook.xml");
  const relationships = archive["xl/_rels/workbook.xml.rels"] ? parseRelationships(decodeXml(archive["xl/_rels/workbook.xml.rels"]!, "xl/_rels/workbook.xml.rels")) : new Map<string, string>();
  const shared = archive["xl/sharedStrings.xml"] ? sharedStrings(decodeXml(archive["xl/sharedStrings.xml"]!, "xl/sharedStrings.xml")) : [];
  const sheets = findObjects(workbook, "sheet");
  const sections: ExtractedDocumentSection[] = [];
  let cellCount = 0;
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const name = String(sheet.name ?? `Sheet ${sheetIndex + 1}`);
    const hidden = sheet.state === "hidden" || sheet.state === "veryHidden";
    const relationshipId = String(sheet.id ?? "");
    const target = relationships.get(relationshipId) ?? `worksheets/sheet${sheetIndex + 1}.xml`;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`.replace("xl/xl/", "xl/");
    if (!archive[path]) continue;
    const parsed = parseXml(decodeXml(archive[path]!, path), path);
    const rows = findObjects(parsed, "row");
    for (let offset = 0; offset < rows.length; offset += 50) {
      const block = rows.slice(offset, offset + 50);
      const lines: string[] = [];
      let firstCell = "";
      let lastCell = "";
      for (const row of block) {
        const cells = asArray(row.c);
        cellCount += cells.length;
        if (cellCount > config.maxSpreadsheetCells) throw new AppError("spreadsheet_too_large", `spreadsheet exceeds the technical ${config.maxSpreadsheetCells} cell guard`, 422);
        const values = cells.map((cell) => {
          const reference = String(cell.r ?? "");
          if (reference) { if (!firstCell) firstCell = reference; lastCell = reference; }
          const raw = scalar(cell.v);
          const value = cell.t === "s" ? shared[Number(raw)] ?? raw : cell.t === "inlineStr" ? allText(cell.is) : raw;
          const formula = scalar(cell.f);
          return formula ? `=${formula}${value ? ` => ${value}` : ""}` : value;
        });
        if (values.some(Boolean)) lines.push(values.join("\t"));
      }
      if (!lines.length) continue;
      const range = firstCell && lastCell ? `${firstCell}:${lastCell}` : `rows ${offset + 1}-${offset + block.length}`;
      sections.push(section("sheet", name, { label: `${name}!${range}`, sheet: name, range, part: hidden ? "hidden sheet" : "sheet" }, lines.join("\n"), hidden));
    }
  }
  const metadata: Record<string, string | number | boolean | null> = { ...coreMetadata(archive), sheets: sheets.length };
  return finish(typeof metadata.title === "string" ? metadata.title : null, sections, [], false, metadata);
}

async function extractPdf(bytes: Uint8Array, config: DocumentRagConfig): Promise<ExtractedDocument> {
  if (!startsWithAscii(bytes, "%PDF-")) throw new AppError("invalid_pdf", "file does not have a PDF signature", 422);
  try {
    const { getDocument, GlobalWorkerOptions } = await loadPdfJs();
    GlobalWorkerOptions.workerSrc = `data:text/javascript;base64,${Buffer.from(pdfWorkerSource).toString("base64")}`;
    const task = getDocument({ data: bytes.slice(), useSystemFonts: true, useWorkerFetch: false });
    const pdf = await task.promise;
    if (pdf.numPages > config.maxPdfPages) {
      await task.destroy();
      throw new AppError("pdf_too_large", `PDF exceeds the technical ${config.maxPdfPages} page guard`, 422);
    }
    const sections: ExtractedDocumentSection[] = [];
    let needsOcr = false;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
      const pageNeedsOcr = text.length < 20;
      needsOcr ||= pageNeedsOcr;
      sections.push(section("page", `Page ${pageNumber}`, { label: `Page ${pageNumber}`, page: pageNumber }, text, false, pageNeedsOcr));
      page.cleanup();
    }
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = metadata?.info as Record<string, unknown> | undefined;
    const title = typeof info?.Title === "string" ? info.Title : null;
    const extractedMetadata: Record<string, string | number | boolean | null> = { pages: pdf.numPages };
    for (const [source, target] of [["Title", "title"], ["Author", "author"], ["Subject", "subject"], ["Keywords", "keywords"], ["CreationDate", "created"], ["ModDate", "modified"]] as const) if (typeof info?.[source] === "string") extractedMetadata[target] = info[source] as string;
    await task.destroy();
    return finish(title, sections, needsOcr ? ["one or more pages await OCR"] : [], needsOcr, extractedMetadata);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_pdf", error instanceof Error ? error.message : "PDF extraction failed", 422);
  }
}

function loadPdfJs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = (async () => {
    const originalWarn = console.warn;
    const filteredWarn = (...values: unknown[]) => {
      const message = String(values[0] ?? "");
      if (!message.includes("@napi-rs/canvas") && !message.includes("Cannot polyfill `DOMMatrix`") && !message.includes("Cannot polyfill `Path2D`")) originalWarn(...values);
    };
    console.warn = filteredWarn;
    try { return await import("pdfjs-dist/legacy/build/pdf.mjs"); }
    finally { if (console.warn === filteredWarn) console.warn = originalWarn; }
  })();
  return pdfJsPromise;
}

function extractMarkdown(text: string): ExtractedDocument {
  const matches = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  if (!matches.length) return finish(null, splitPlainText(text, "text"), [], false);
  const sections: ExtractedDocumentSection[] = [];
  if (matches[0]!.index! > 0) sections.push(section("text", null, { label: "Preamble" }, text.slice(0, matches[0]!.index).trim()));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const heading = match[2]!.trim();
    const end = matches[index + 1]?.index ?? text.length;
    sections.push(section("heading", heading, { label: `Heading: ${heading}`, heading }, text.slice(match.index!, end).trim()));
  }
  return finish(matches[0]?.[2]?.trim() ?? null, sections, [], false);
}

function extractText(text: string): ExtractedDocument {
  return finish(null, splitPlainText(text, "text"), [], false);
}

function splitPlainText(text: string, kind: DocumentSectionKind): ExtractedDocumentSection[] {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  const sections: ExtractedDocumentSection[] = [];
  for (let start = 0, part = 1; start < clean.length; part += 1) {
    let end = Math.min(clean.length, start + 20_000);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf("\n\n", end);
      if (boundary > start + 10_000) end = boundary;
    }
    sections.push(section(kind, null, { label: `Part ${part}`, part: `part ${part}` }, clean.slice(start, end).trim()));
    start = end;
  }
  return sections;
}

function section(kind: DocumentSectionKind, title: string | null, locator: DocumentLocator, text: string, hidden = false, needsOcr = false): ExtractedDocumentSection {
  return { kind, title, locator, text: text.trim(), hidden, needsOcr };
}

function finish(title: string | null, sections: ExtractedDocumentSection[], warnings: string[], needsOcr: boolean, metadata: Record<string, string | number | boolean | null> = {}): ExtractedDocument {
  const usable = sections.filter((item) => item.text || item.needsOcr).flatMap((item) => {
    if (item.text.length <= 50_000) return [item];
    const parts: ExtractedDocumentSection[] = [];
    for (let start = 0, part = 1; start < item.text.length; part += 1) {
      const text = item.text.slice(start, start + 50_000);
      parts.push({ ...item, locator: { ...item.locator, label: `${item.locator.label} (part ${part})` }, text });
      start += 50_000;
    }
    return parts;
  });
  if (!usable.length && !needsOcr) warnings.push("no extractable text was found");
  const normalizedTitle = title?.trim() || null;
  return { title: normalizedTitle, metadata: normalizedTitle ? { ...metadata, title: normalizedTitle } : metadata, sections: usable, warnings, needsOcr };
}

function requiredXml(archive: Unzipped, path: string, label: string): string {
  const data = archive[path];
  if (!data) throw new AppError("invalid_office_document", `${label} archive is missing ${path}`, 422);
  return decodeXml(data, path);
}

function decodeXml(data: Uint8Array, name: string): string {
  const text = decoder.decode(data);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new AppError("unsafe_xml", `${name} contains a forbidden XML declaration`, 422);
  return text;
}

function parseXml(xml: string, name: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new AppError("unsafe_xml", `${name} contains a forbidden XML declaration`, 422);
  let depth = 0;
  for (const match of xml.matchAll(/<\/?[^!?][^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith("</")) depth -= 1;
    else if (!tag.endsWith("/>")) depth += 1;
    if (depth > 256) throw new AppError("unsafe_xml", `${name} exceeds the XML depth guard`, 422);
    if (depth < 0) throw new AppError("invalid_office_document", `${name} has unbalanced XML`, 422);
  }
  try { return xmlParser.parse(xml); }
  catch (error) { throw new AppError("invalid_office_document", `${name}: ${error instanceof Error ? error.message : "invalid XML"}`, 422); }
}

function textFromXml(xml: string): string {
  return officeText(parseXml(xml, "Office XML"));
}

function presentationText(xml: string, notesOnly: boolean): string {
  const parsed = parseXml(xml, "Presentation XML");
  const shapes = findObjects(parsed, "sp");
  const texts = shapes.filter((shape) => {
    const placeholder = findScalarByKey(shape?.nvSpPr?.nvPr?.ph, "type");
    return notesOnly ? placeholder === "body" : !["dt", "ftr", "sldNum"].includes(placeholder ?? "");
  }).map(officeText).filter(Boolean);
  return (texts.length ? texts : notesOnly && shapes.length ? [] : [officeText(parsed)]).join(" ").replace(/\s+/g, " ").trim();
}

function officeText(value: unknown): string {
  const values: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === "t") {
        const text = scalar(child) || allText(child);
        if (text) values.push(text);
      } else visit(child);
    }
  };
  visit(value);
  return values.join(" ").replace(/\s+/g, " ").trim();
}

function allText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(allText).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  if (object.t !== undefined) return allText(object.t);
  return Object.entries(object).filter(([key]) => !["r", "id", "name", "state", "val"].includes(key)).map(([, item]) => allText(item)).filter(Boolean).join(" ");
}

function findObjects(value: unknown, key: string): Array<Record<string, any>> {
  const result: Array<Record<string, any>> = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
      if (name === key) {
        for (const item of asArray(child)) if (item && typeof item === "object") result.push(item as Record<string, any>);
      } else visit(child);
    }
  };
  visit(value);
  return result;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) return String((value as Record<string, unknown>)["#text"] ?? "");
  return "";
}

function sharedStrings(xml: string): string[] {
  const parsed = parseXml(xml, "xl/sharedStrings.xml");
  return findObjects(parsed, "si").map(allText);
}

function relationshipTarget(xml: string, typeSuffix: string): string | null {
  const parsed = parseXml(xml, "relationships");
  const relationship = findObjects(parsed, "Relationship").find((item) => String(item.Type ?? "").endsWith(`/${typeSuffix}`));
  return relationship?.Target ? String(relationship.Target) : null;
}

function parseRelationships(xml: string): Map<string, string> {
  const parsed = parseXml(xml, "relationships");
  const map = new Map<string, string>();
  for (const relationship of findObjects(parsed, "Relationship")) if (relationship.Id && relationship.Target) map.set(String(relationship.Id), String(relationship.Target));
  return map;
}

function coreMetadata(archive: Unzipped): Record<string, string | number | boolean | null> {
  const data = archive["docProps/core.xml"];
  if (!data) return {};
  const parsed = parseXml(decodeXml(data, "docProps/core.xml"), "docProps/core.xml");
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of ["title", "subject", "creator", "description", "keywords", "lastModifiedBy", "created", "modified"] as const) {
    const value = findScalarByKey(parsed, key);
    if (value) metadata[key] = value;
  }
  return metadata;
}

function findScalarByKey(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) for (const item of value) { const found = findScalarByKey(item, key); if (found) return found; }
  else for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (name === key) return scalar(item) || allText(item) || null;
    const found = findScalarByKey(item, key); if (found) return found;
  }
  return null;
}

function decodeText(bytes: Uint8Array): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.slice(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = bytes.slice(2);
      for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1]!, swapped[index]!];
      return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.slice(3) : bytes);
  } catch { throw new AppError("invalid_text_encoding", "text documents must use UTF-8, UTF-16LE, or UTF-16BE", 422); }
}

function firstLine(text: string): string | null {
  return text.split(/\s{2,}|\n/, 1)[0]?.slice(0, 200) || null;
}

function numericPathSort(left: string, right: string): number {
  return Number(/(\d+)\.xml$/.exec(left)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(right)?.[1] ?? 0);
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  return decoder.decode(bytes.slice(0, value.length)) === value;
}

export function documentContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
