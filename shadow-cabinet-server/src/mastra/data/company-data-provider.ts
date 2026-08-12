import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import seed from "./company-data.json" with { type: "json" };
import type { CompanyData } from "./company-data.ts";

/**
 * Uploads land in a JSON file beside the seed rather than in Mastra storage:
 * the storage adapter exposes no key-value domain (`getStore` covers memory,
 * workflows, blobs and friends), and a file keeps the upload surviving a
 * restart without inventing a schema for one document.
 */
const UPLOAD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "company-data.uploaded.json",
);

let cached: CompanyData | null = null;

export async function setCompanyData(data: CompanyData): Promise<void> {
  await writeFile(UPLOAD_PATH, JSON.stringify(data, null, 2), "utf8");
  cached = data;
}

export async function getCompanyData(): Promise<CompanyData> {
  if (cached) return cached;

  try {
    const raw = await readFile(UPLOAD_PATH, "utf8");
    cached = JSON.parse(raw) as CompanyData;
    return cached;
  } catch {
    // No upload yet, or an unreadable one. A missing file must not break
    // grounding, so fall through to the seed.
  }

  cached = seed as CompanyData;
  return cached;
}
