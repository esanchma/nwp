import { describe, expect, test } from "bun:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { openApiDocument, openApiJson } from "../src/openapi.ts";

const expectedOperations = [
  "acknowledgeDocumentReview", "cancelDocumentExtraction", "createPage", "defineTag", "deleteAttachment", "deletePage", "downloadAttachment", "exportPage", "exportWiki",
  "downloadDocument", "getAttachment", "getDeletedPage", "getDocument", "getDocumentContent", "getOpenApiDocument", "getPage", "getPageTree", "getRevision", "getSemanticStatus",
  "getRevisionDiff", "importDocument", "importPage", "listAttachments", "listDocuments", "listDocumentVersions", "listPages", "listRevisions", "listTagDefinitions", "listTrash", "replaceDocument",
  "purgePage", "restoreDeletedPage", "retryDocumentExtraction", "restoreRevision", "searchPages", "updatePage", "uploadAttachment",
];

describe("OpenAPI contract", () => {
  test("is a valid OpenAPI 3.1 document", async () => {
    const validated = await SwaggerParser.validate(structuredClone(openApiDocument) as never) as unknown as { openapi: string; info: { version: string } };
    expect(validated.openapi).toBe("3.1.0");
    expect(validated.info.version).toBe("0.10.0");
  });

  test("documents every JSON API operation with unique operation IDs", () => {
    const operations: string[] = [];
    for (const pathItem of Object.values(openApiDocument.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (["get", "post", "put", "delete", "patch"].includes(method) && "operationId" in operation) operations.push(operation.operationId);
      }
    }
    expect(operations.sort()).toEqual(expectedOperations.sort());
    expect(new Set(operations).size).toBe(operations.length);
  });

  test("serializes deterministic JSON", () => {
    const parsed = JSON.parse(openApiJson()) as { openapi: string; paths: object };
    expect(parsed.openapi).toBe("3.1.0");
    expect(Object.keys(parsed.paths)).toHaveLength(28);
    expect(openApiJson().endsWith("\n")).toBe(true);
  });
});
