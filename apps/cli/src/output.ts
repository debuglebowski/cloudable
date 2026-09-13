// ---------------------------------------------------------------------------
// Printing. Two shapes for every read command: a padded table for a person,
// `--json` for a script. The JSON is the API's own response, unreshaped, so
// nothing is lost in translation and a field the API gains shows up without
// a CLI change.
// ---------------------------------------------------------------------------

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Nothing to show, in the one place a reader will look for it. */
export const NONE = "—";

export function dash(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return NONE;
  const text = String(value);
  return text === "" ? NONE : text;
}

/** `2026-09-13 13:26` in UTC. Minutes are as precise as a table needs. */
export function shortTime(value: string | null | undefined): string {
  if (!value) return NONE;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return dash(value);
  return date.toISOString().replace("T", " ").slice(0, 16);
}

export function printTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): void {
  if (rows.length === 0) return;
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  // The last column is never padded — trailing spaces are invisible noise
  // that only show up when someone copies a line out of their terminal.
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  console.log(line(headers.map((h) => h.toUpperCase())));
  for (const row of rows) console.log(line(row));
}

/** A detail view: labels in one column, values in the next. */
export function printFields(fields: ReadonlyArray<readonly [string, string]>): void {
  const width = Math.max(...fields.map(([label]) => label.length));
  for (const [label, value] of fields) {
    console.log(`${`${label}:`.padEnd(width + 1)}  ${value}`);
  }
}

/** For a list that came back empty. Not an error, so it goes to stdout. */
export function printEmpty(what: string): void {
  console.log(`No ${what}.`);
}
