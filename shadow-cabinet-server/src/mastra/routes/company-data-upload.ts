import { registerApiRoute } from "@mastra/core/server";

import type { CompanyData } from "../data/company-data.ts";
import { setCompanyData } from "../data/company-data-provider.ts";
import { parseCsv, quartersFromRows } from "../data/csv.ts";

export const companyDataUploadRoute = registerApiRoute("/company-data", {
  method: "POST",
  handler: async (c) => {
    const body = await c.req.json();

    try {
      if (body.format === "json") {
        await setCompanyData(body.data as CompanyData);
      } else if (body.format === "csv") {
        const data: CompanyData = {
          company: body.company ?? "Uploaded Company",
          currency: "USD",
          unit: "thousands",
          quarters: quartersFromRows(parseCsv(body.csv as string)),
        };
        await setCompanyData(data);
      } else {
        return c.json({ error: 'format must be "json" or "csv".' }, 400);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }

    return c.json({ ok: true });
  },
});
