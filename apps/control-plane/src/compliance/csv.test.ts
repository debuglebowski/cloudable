import { describe, expect, test } from "bun:test";
import { toCsv } from "./csv";

describe("toCsv", () => {
  test("renders a header and rows with CRLF line endings", () => {
    const csv = toCsv(["a", "b"], [["1", "2"]]);
    expect(csv).toBe("a,b\r\n1,2\r\n");
  });

  test("quotes fields containing a comma, quote, or newline", () => {
    const csv = toCsv(["a"], [["has,comma"], ['has"quote'], ["has\nnewline"]]);
    expect(csv).toBe('a\r\n"has,comma"\r\n"has""quote"\r\n"has\nnewline"\r\n');
  });

  test("renders null/undefined cells as empty fields", () => {
    const csv = toCsv(["a", "b"], [[null, undefined]]);
    expect(csv).toBe("a,b\r\n,\r\n");
  });

  test("stringifies numbers and booleans", () => {
    const csv = toCsv(["a", "b"], [[1, true]]);
    expect(csv).toBe("a,b\r\n1,true\r\n");
  });

  test("guards fields starting with a formula-trigger character", () => {
    const csv = toCsv(["a"], [["=SUM(A1)"], ["+1+1"], ["-1"], ["@SUM(A1)"]]);
    expect(csv).toBe("a\r\n'=SUM(A1)\r\n'+1+1\r\n'-1\r\n'@SUM(A1)\r\n");
  });

  test("still quotes a formula-guarded field that also contains a comma", () => {
    const csv = toCsv(["a"], [["=A1,B1"]]);
    expect(csv).toBe('a\r\n"\'=A1,B1"\r\n');
  });
});
