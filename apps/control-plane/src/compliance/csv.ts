/** A single CSV cell value; `null`/`undefined` render as an empty field. */
export type CsvCell = string | number | boolean | null | undefined;

// Neutralize CSV/formula injection: a field beginning with one of these
// characters is interpreted as a formula by Excel/Sheets when the exported
// file is opened there. Values here come from free-text fields (machine
// name, finding detail) that a user can set — prefixing a single quote
// forces spreadsheet apps to treat the cell as plain text without changing
// the value for any other consumer (CSV itself has no such convention).
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

const escapeField = (value: string): string => {
  const guarded = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
};

/**
 * Renders a header row plus data rows as RFC 4180-ish CSV (CRLF line
 * endings, double-quote escaping for fields containing a comma, quote, or
 * newline). No external dependency — the shape here is small and stable
 * enough not to warrant one.
 */
export const toCsv = (header: readonly string[], rows: readonly (readonly CsvCell[])[]): string => {
  const renderRow = (row: readonly CsvCell[]): string =>
    row
      .map((cell) => escapeField(cell === null || cell === undefined ? "" : String(cell)))
      .join(",");

  return [renderRow(header), ...rows.map(renderRow)].map((line) => `${line}\r\n`).join("");
};
