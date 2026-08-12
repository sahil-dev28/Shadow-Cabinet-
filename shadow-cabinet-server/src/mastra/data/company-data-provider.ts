import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import seed from "./company-data.json" with { type: "json" };
import type { CompanyData } from "./company-data.ts";

/**
 * Uploads land in a file, not Mastra storage: the adapter exposes no key-value
 * domain, and a file survives a restart without a schema for one document.
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
    // No upload yet, or an unreadable one: a missing file must not break
    // grounding.
  }

  cached = seed as CompanyData;
  return cached;
}
