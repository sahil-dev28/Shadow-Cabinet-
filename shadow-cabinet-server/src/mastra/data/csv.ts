import { METRIC_NAMES, type Quarter } from "./company-data.ts";

/**
 * Deliberately minimal: no quoted fields, no embedded commas. Mock P&L data
 * does not justify a parser dependency.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    throw new Error("CSV must have a header row and at least one data row.");
  }

  const header = lines[0].split(",").map((cell) => cell.trim());

  return lines.slice(1).map((line, index) => {
    const cells = line.split(",").map((cell) => cell.trim());

    if (cells.length !== header.length) {
      throw new Error(
        `Row ${index + 1} has ${cells.length} columns but the header has ${header.length}.`,
      );
    }

    return Object.fromEntries(header.map((name, i) => [name, cells[i]]));
  });
}

export function quartersFromRows(rows: Record<string, string>[]): Quarter[] {
  return rows.map((row) => {
    if (!row.period) {
      throw new Error("Every row needs a period column.");
    }

    const quarter: Record<string, unknown> = {
      period: row.period,
      segments: [],
    };

    for (const metric of METRIC_NAMES) {
      const raw = row[metric];
      if (raw === undefined || raw === "") {
        throw new Error(`Row "${row.period}" is missing the ${metric} column.`);
      }

      const value = Number(raw);
      if (Number.isNaN(value)) {
        throw new Error(`Row "${row.period}" has a non-numeric ${metric}: "${raw}".`);
      }

      quarter[metric] = value;
    }

    return quarter as unknown as Quarter;
  });
}
