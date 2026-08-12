import { describe, expect, it } from "vitest";

import {
  type OpeningEntry,
  type RebuttalEntry,
  filterDisagreements,
  formatOpeningsForRebuttal,
  renderOpeningRound,
  renderRebuttalRound,
  sortByBoardOrder,
} from "./transcript.ts";

const openings: OpeningEntry[] = [
  { personaId: "cmo", text: "Protect the demand engine." },
  { personaId: "cfo", text: "Margin is down 4 points. Cut spend." },
];

describe("sortByBoardOrder", () => {
  it("orders entries CFO, CMO, COO, CSO regardless of arrival order", () => {
    const sorted = sortByBoardOrder(openings);
    expect(sorted.map((entry) => entry.personaId)).toEqual(["cfo", "cmo"]);
  });
});

describe("renderOpeningRound", () => {
  it("renders one titled section per persona in board order", () => {
    const markdown = renderOpeningRound(openings);

    expect(markdown).toContain("## Opening statements");
    expect(markdown).toContain("### CFO — Chief Financial Officer");
    expect(markdown).toContain("Margin is down 4 points. Cut spend.");
    expect(markdown.indexOf("### CFO")).toBeLessThan(markdown.indexOf("### CMO"));
  });
});

describe("filterDisagreements", () => {
  const rebuttals: RebuttalEntry[] = [
    { personaId: "cfo", disagrees: true, with: ["cmo"], statement: "Payback is 14 months." },
    { personaId: "coo", disagrees: false, with: [], statement: "" },
  ];

  it("keeps only the personas that actually disagree", () => {
    expect(filterDisagreements(rebuttals).map((entry) => entry.personaId)).toEqual([
      "cfo",
    ]);
  });

  it("drops entries flagged as disagreeing but with an empty statement", () => {
    const empty: RebuttalEntry[] = [
      { personaId: "cso", disagrees: true, with: ["cfo"], statement: "   " },
    ];
    expect(filterDisagreements(empty)).toEqual([]);
  });
});

describe("renderRebuttalRound", () => {
  it("names who each persona is pushing back on", () => {
    const markdown = renderRebuttalRound([
      { personaId: "cfo", disagrees: true, with: ["cmo"], statement: "Payback is 14 months." },
    ]);

    expect(markdown).toContain("## Where the board disagrees");
    expect(markdown).toContain("**CFO → CMO**");
    expect(markdown).toContain("Payback is 14 months.");
  });

  it("says so plainly when the board agrees", () => {
    const markdown = renderRebuttalRound([
      { personaId: "cfo", disagrees: false, with: [], statement: "" },
    ]);

    expect(markdown).toContain("The board did not disagree");
  });
});

describe("formatOpeningsForRebuttal", () => {
  it("excludes the persona's own opening", () => {
    const prompt = formatOpeningsForRebuttal(openings, "cfo");

    expect(prompt).toContain("CMO");
    expect(prompt).not.toContain("Margin is down 4 points");
  });
});
