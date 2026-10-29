import { describe, expect, it } from "vitest";
import { layoutColumns, type ColumnSizing } from "./table-layout";

const sizing = (min: number, compactMin: number, ideal: number, grow = 1): ColumnSizing => ({ min, compactMin, ideal, grow });
const columns = [
  sizing(164, 96, 340, 4),
  sizing(100, 56, 150, 2),
  sizing(94, 88, 152, .4),
  sizing(60, 44, 68, 0),
];
const total = (widths: number[]) => widths.reduce((sum, width) => sum + width, 0);

describe("table column sizing", () => {
  it("proportionally fits the full table before using compact floors", () => {
    const widths = layoutColumns(columns, [], 450);

    expect(total(widths)).toBe(450);
    expect(widths.every((width, index) => width >= columns[index].compactMin && width <= columns[index].ideal)).toBe(true);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[3]);
  });

  it("keeps every compact floor and only scrolls when the viewport is narrower", () => {
    const widths = layoutColumns(columns, [], 200);

    expect(widths).toEqual(columns.map((column) => column.compactMin));
    expect(total(widths)).toBeGreaterThan(200);
  });

  it("never reflows the user-adjusted column when the window changes", () => {
    const preferred = [400, undefined, undefined, undefined];
    const narrow = layoutColumns(columns, preferred, 500);
    const wide = layoutColumns(columns, preferred, 900);

    expect(narrow[0]).toBe(400);
    expect(wide[0]).toBe(400);
    expect(total(narrow)).toBeGreaterThan(500);
    expect(total(wide)).toBe(900);
  });

  it("scales a fully user-sized layout as one system when the viewport changes", () => {
    const preferred = [300, 150, 100, 50];
    const widths = layoutColumns(columns, preferred, 900);

    expect(total(widths)).toBe(900);
    expect(widths.every((width, index) => width > preferred[index])).toBe(true);
    expect(widths[0] / widths[3]).toBeCloseTo(preferred[0] / preferred[3], 1);
  });

  it("keeps the dragged edge fixed while the columns to its right absorb movement", () => {
    const widths = layoutColumns(columns, [200, 150], 500, 1);

    expect(widths[0]).toBe(200);
    expect(widths[1]).toBe(150);
    expect(total(widths)).toBe(500);
  });
});
