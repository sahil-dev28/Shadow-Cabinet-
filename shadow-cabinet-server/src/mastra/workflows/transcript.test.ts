import { describe, expect, it } from "vitest";

import {
  type OpeningEntry,
  type RebuttalEntry,
  type ReplyEntry,
  filterDisagreements,
  formatObjectionsForReply,
  formatOpeningsForRebuttal,
  objectionsAimedAt,
  personasNamedIn,
  renderOpeningRound,
  renderRebuttalRound,
  renderReplyRound,
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

const objections: RebuttalEntry[] = [
  { personaId: "cmo", disagrees: true, with: ["cfo"], statement: "Cutting spend forfeits pipeline." },
  { personaId: "coo", disagrees: true, with: ["cfo", "cso"], statement: "Neither plan can be staffed." },
  { personaId: "cso", disagrees: false, with: [], statement: "" },
];

describe("personasNamedIn", () => {
  it("lists every persona objected to, in board order, once each", () => {
    expect(personasNamedIn(objections)).toEqual(["cfo", "cso"]);
  });

  it("ignores entries that did not really disagree", () => {
    expect(
      personasNamedIn([
        { personaId: "cmo", disagrees: true, with: ["cfo"], statement: "   " },
        { personaId: "coo", disagrees: false, with: ["cso"], statement: "" },
      ]),
    ).toEqual([]);
  });
});

describe("objectionsAimedAt", () => {
  it("returns only the objections naming that persona", () => {
    const aimed = objectionsAimedAt(objections, "cso");
    expect(aimed.map((entry) => entry.personaId)).toEqual(["coo"]);
  });
});

describe("formatObjectionsForReply", () => {
  it("shows the persona only what was aimed at it", () => {
    const prompt = formatObjectionsForReply(objections, "cfo");

    expect(prompt).toContain("CMO");
    expect(prompt).toContain("Cutting spend forfeits pipeline.");
    // The COO objected to the CFO and the CSO at once, so the CFO sees it too.
    expect(prompt).toContain("Neither plan can be staffed.");
  });
});

describe("renderReplyRound", () => {
  it("renders one titled reply per persona in board order", () => {
    const markdown = renderReplyRound([
      { personaId: "cso", text: "Conceded on staffing." },
      { personaId: "cfo", text: "Payback still does not clear twelve months." },
    ]);

    expect(markdown).toContain("## Replies");
    expect(markdown).toContain("**CFO replies**");
    expect(markdown.indexOf("**CFO")).toBeLessThan(markdown.indexOf("**CSO"));
  });

  it("says so plainly when nobody had to reply", () => {
    expect(renderReplyRound([])).toContain("No replies were needed");
  });
});
