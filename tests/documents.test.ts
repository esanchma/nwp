import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import type { DocumentRagConfig } from "../src/config.ts";
import { PageStore } from "../src/database.ts";
import { canonicalDocumentMime, documentFormat, DocumentWorker, extractDocument } from "../src/documents.ts";

const config: DocumentRagConfig = { enabled: true, maxFileBytes: 10_000_000, maxExpandedBytes: 50_000_000, maxArchiveEntries: 10_000, maxCompressionRatio: 1000, maxPdfPages: 10_000, maxSpreadsheetCells: 5_000_000 };
let dir = "";
let store: PageStore | null = null;

afterEach(async () => {
  store?.close();
  store = null;
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<PageStore> {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "documents-test-"));
  store = new PageStore(join(dir, "nwp.db"));
  return store;
}

describe("document extraction", () => {
  test("extracts Markdown and text with stable locators", async () => {
    const markdown = await extractDocument("guide.md", "text/markdown", strToU8("# Guide\n\nIntro.\n\n## Install\n\nRun nwp."), config);
    expect(markdown.title).toBe("Guide");
    expect(markdown.sections.map(({ locator }) => locator.label)).toEqual(["Heading: Guide", "Heading: Install"]);
    const text = await extractDocument("notes.txt", "text/plain", strToU8("plain notes"), config);
    expect(text.sections[0]).toMatchObject({ kind: "text", text: "plain notes", locator: { label: "Part 1" } });
  });

  test("extracts DOCX paragraphs, tables, headers, and pending images", async () => {
    const bytes = officeZip({
      "word/document.xml": `<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
      "word/header1.xml": `<w:hdr xmlns:w="w"><w:p><w:r><w:t>Confidential</w:t></w:r></w:p></w:hdr>`,
      "word/media/image1.png": "image",
      "docProps/core.xml": `<cp:coreProperties xmlns:cp="cp" xmlns:dc="dc"><dc:title>Annual report</dc:title><dc:creator>Ada</dc:creator></cp:coreProperties>`,
    });
    const result = await extractDocument("report.docx", canonicalDocumentMime("docx"), bytes, config);
    expect(result.sections.some(({ kind, text }) => kind === "heading" && text === "Overview")).toBe(true);
    expect(result.sections.some(({ kind, text }) => kind === "table" && text.includes("Name | Value"))).toBe(true);
    expect(result.sections.some(({ text }) => text.includes("Confidential"))).toBe(true);
    expect(result.needsOcr).toBe(true);
    expect(result.metadata).toMatchObject({ title: "Annual report", creator: "Ada" });
  });

  test("extracts XLSX blocks with formulas, ranges, and hidden state", async () => {
    const bytes = officeZip({
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Sales" state="hidden" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Amount</t></si><si><t>North</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>10</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>SUM(B1:B1)</f><v>10</v></c></row></sheetData></worksheet>`,
    });
    const result = await extractDocument("sales.xlsx", canonicalDocumentMime("xlsx"), bytes, config);
    expect(result.sections[0]).toMatchObject({ kind: "sheet", hidden: true, locator: { sheet: "Sales", range: "A1:B2" } });
    expect(result.sections[0]!.text).toContain("=SUM(B1:B1) => 10");
  });

  test("extracts PPTX slides and speaker notes", async () => {
    const bytes = officeZip({
      "ppt/presentation.xml": `<p:presentation xmlns:p="p"/>`,
      "ppt/slides/slide1.xml": `<p:sld xmlns:p="p" xmlns:a="a" show="0"><p:cSld><a:t>Quarterly plan</a:t></p:cSld></p:sld>`,
      "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="p" xmlns:a="a"><a:t>Explain the forecast</a:t></p:notes>`,
    });
    const result = await extractDocument("plan.pptx", canonicalDocumentMime("pptx"), bytes, config);
    expect(result.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "slide", text: "Quarterly plan", hidden: true }),
      expect.objectContaining({ kind: "notes", text: "Explain the forecast", hidden: true }),
    ]));
  });

  test("rejects unsupported files and unsafe Office archives", async () => {
    await expect(extractDocument("legacy.doc", "application/msword", strToU8("legacy"), config)).rejects.toThrow("supported document formats");
    const unsafe = officeZip({ "word/document.xml": `<!DOCTYPE x [<!ENTITY e "bad">]><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&e;</w:t></w:r></w:p></w:body></w:document>` });
    await expect(extractDocument("unsafe.docx", canonicalDocumentMime("docx"), unsafe, config)).rejects.toThrow("forbidden XML");
    const compressed = officeZip({ "word/document.xml": `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${"repeat ".repeat(1000)}</w:t></w:r></w:p></w:body></w:document>` });
    await expect(extractDocument("bomb.docx", canonicalDocumentMime("docx"), compressed, { ...config, maxCompressionRatio: 2 })).rejects.toThrow("compression-ratio guard");
  });

  test("extracts PDF text by page", async () => {
    const result = await extractDocument("sample.pdf", "application/pdf", minimalPdf("Hello PDF document"), config);
    expect(result.sections[0]).toMatchObject({ kind: "page", locator: { page: 1, label: "Page 1" } });
    expect(result.sections[0]!.text).toContain("Hello PDF document");
  });
});

describe("document storage and jobs", () => {
  test("creates a linked page, extracts durable sections, and replaces explicitly", async () => {
    const db = await setup();
    const first = strToU8("first document body");
    const document = db.createDocument("notes.txt", "text/plain", documentFormat("notes.txt", "text/plain"), first, "cli", config.maxFileBytes);
    expect(document).toMatchObject({ status: "queued", format: "text", currentVersion: { version: 1 } });
    expect(db.getById(document.pageId).tags).toContain("type:document");
    expect(await new DocumentWorker(db, config).runUntilIdle()).toBe(1);
    expect(db.getDocument(document.id).status).toBe("ready");
    expect(db.documentSections(document.id)[0]!.text).toBe("first document body");

    db.update(document.pageId, { body: "Human-maintained summary" }, "web");
    db.replaceDocument(document.id, "notes-v2.txt", "text/plain", "text", strToU8("second version"), config.maxFileBytes);
    expect(await new DocumentWorker(db, config).runUntilIdle()).toBe(1);
    expect(db.getDocument(document.id)).toMatchObject({ needsReview: true, currentVersion: { version: 2 } });
    expect(db.getById(document.pageId).body).toBe("Human-maintained summary");
    expect(db.listDocumentVersions(document.id)).toHaveLength(2);
    expect(db.documentSections(document.id)[0]!.text).toBe("second version");

    const superseded = db.createDocument("draft.txt", "text/plain", "text", strToU8("old queued"), "cli", config.maxFileBytes);
    db.replaceDocument(superseded.id, "draft-new.txt", "text/plain", "text", strToU8("new queued"), config.maxFileBytes);
    const retained = db.listDocumentVersions(superseded.id);
    expect(retained.map(({ status }) => status)).toEqual(["queued", "superseded"]);
    db.deletePage(superseded.pageId);
    db.purgeDeleted(superseded.pageId);
    for (const version of retained) expect(await Bun.file(db.attachmentFilePath(version.sha256)).exists()).toBe(false);
  });
});

function officeZip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
}

function minimalPdf(text: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length + 35} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(value);
}
