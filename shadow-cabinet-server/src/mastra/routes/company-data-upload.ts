import { registerApiRoute } from "@mastra/core/server";

import { companyDataSchema } from "../data/company-data.ts";
import { setCompanyData } from "../data/company-data-provider.ts";
import { parseCsv, quartersFromRows } from "../data/csv.ts";

/** Zod's issue list, flattened into something a person can act on. */
function describe(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export const companyDataUploadRoute = registerApiRoute("/company-data", {
  method: "POST",
  handler: async (c) => {
    const body = await c.req.json();

    try {
      const candidate =
        body.format === "json"
          ? body.data
          : body.format === "csv"
            ? {
                company: body.company ?? "Uploaded Company",
                currency: "USD",
                unit: "thousands",
                quarters: quartersFromRows(parseCsv(body.csv as string)),
              }
            : null;

      if (candidate === null) {
        return c.json({ error: 'format must be "json" or "csv".' }, 400);
      }

      // Validated before it is written, so a bad upload fails here rather than
      // inside a grounding tool mid-debate.
      const parsed = companyDataSchema.safeParse(candidate);
      if (!parsed.success) {
        return c.json(
          { error: `Company data is malformed — ${describe(parsed.error)}` },
          400,
        );
      }

      await setCompanyData(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }

    return c.json({ ok: true });
  },
});
