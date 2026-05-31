import { describe, test, expect } from "bun:test";
import { intFlag, floatFlag, CliFlagError } from "../../src/cli/flags";

describe("intFlag", () => {
  test("returns the default when the flag is absent", () => {
    expect(intFlag(undefined, "--top", 8)).toBe(8);
  });

  test("parses a valid integer", () => {
    expect(intFlag("25", "--top", 8)).toBe(25);
  });

  test("rejects non-numeric input with a flag-named CliFlagError", () => {
    expect(() => intFlag("abc", "--days", 30)).toThrow(CliFlagError);
    try {
      intFlag("abc", "--days", 30);
    } catch (e) {
      expect((e as Error).message).toContain("--days");
    }
  });

  test("rejects non-integer floats", () => {
    expect(() => intFlag("3.5", "--top", 8)).toThrow(CliFlagError);
  });

  test("rejects values below min", () => {
    expect(() => intFlag("0", "--top", 8, { min: 1 })).toThrow(CliFlagError);
  });

  test("rejects partially-numeric strings (stricter than parseInt)", () => {
    // parseInt('12abc') === 12; Number('12abc') === NaN — we want the rejection.
    expect(() => intFlag("12abc", "--top", 8)).toThrow(CliFlagError);
  });
});

describe("floatFlag", () => {
  test("returns the default when absent", () => {
    expect(floatFlag(undefined, "--threshold", 0.3)).toBe(0.3);
  });

  test("parses a valid float", () => {
    expect(floatFlag("0.7", "--threshold", 0.3)).toBe(0.7);
  });

  test("rejects out-of-range values", () => {
    expect(() => floatFlag("5", "--threshold", 0.3, { min: 0, max: 1 })).toThrow(CliFlagError);
    expect(() => floatFlag("-1", "--threshold", 0.3, { min: 0, max: 1 })).toThrow(CliFlagError);
  });

  test("rejects NaN input", () => {
    expect(() => floatFlag("abc", "--threshold", 0.3)).toThrow(CliFlagError);
  });
});
