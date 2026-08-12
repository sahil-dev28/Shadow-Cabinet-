import { describe, expect, it } from "vitest";

import { parseCsv, quartersFromRows } from "./csv.ts";

const csv = `period,revenue,cogs,grossProfit,grossMarginPct,salesMarketing,rnd,ga,operatingIncome,operatingMarginPct,cash,headcount,newCustomers,churnPct,cac,ltv
2025-Q2,43500,16530,26970,62,9800,4600,3700,8870,20.4,24100,349,171,2.4,57.3,1150
2025-Q3,47900,20118,27782,58,11500,4800,3900,7582,15.8,22600,383,214,3.1,53.7,1090`;

describe("parseCsv", () => {
  it("maps each row onto the header names", () => {
    const rows = parseCsv(csv);

    expect(rows).toHaveLength(2);
    expect(rows[0].period).toBe("2025-Q2");
    expect(rows[1].revenue).toBe("47900");
  });

  it("ignores blank trailing lines", () => {
    expect(parseCsv(`${csv}\n\n`)).toHaveLength(2);
  });

  it("rejects a row whose column count does not match the header", () => {
    expect(() => parseCsv("period,revenue\n2025-Q3")).toThrow(/column/i);
  });
});

describe("quartersFromRows", () => {
  it("converts numeric columns to numbers and defaults segments to empty", () => {
    const [q2] = quartersFromRows(parseCsv(csv));

    expect(q2.period).toBe("2025-Q2");
    expect(q2.revenue).toBe(43500);
    expect(q2.grossMarginPct).toBe(62);
    expect(q2.segments).toEqual([]);
  });

  it("rejects a row missing a required column", () => {
    expect(() => quartersFromRows([{ period: "2025-Q3" }])).toThrow(/revenue/);
  });
});
