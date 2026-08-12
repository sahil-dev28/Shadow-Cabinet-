import seed from "./company-data.json" with { type: "json" };
import type { CompanyData } from "./company-data.ts";

/**
 * The single source of company figures for every tool.
 * Task 8 swaps the seed for the most recent upload in MongoDB.
 */
export async function getCompanyData(): Promise<CompanyData> {
  return seed as CompanyData;
}
