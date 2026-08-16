import { STATUS } from "./slack/design.js";
import type { Sheet } from "./report.js";

/**
 * Visual design for the spreadsheet.
 *
 * Bumped whenever the look changes; a sheet records the version it was styled
 * with, so formatting is applied once rather than on every sync — it costs API
 * calls and never changes between them.
 */
export const STYLE_VERSION = "5";

export interface Rgb {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/**
 * Sheets wants 0–1 floats, and every colour here is authored as hex.
 *
 * Note there is no alpha parameter, deliberately. Sheets ignores alpha on cell
 * backgrounds, so asking for a colour at 18% opacity silently paints it solid —
 * which, if the text is the same colour, renders it invisible. Lighter shades
 * are produced by mixing, below.
 */
function rgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return {
    red: parseInt(value.slice(0, 2), 16) / 255,
    green: parseInt(value.slice(2, 4), 16) / 255,
    blue: parseInt(value.slice(4, 6), 16) / 255,
    alpha: 1,
  };
}

/** Mixes toward white. `amount` 0 leaves it alone, 1 makes it white. */
export function tint(hex: string, amount: number): Rgb {
  const base = rgb(hex);
  return {
    red: base.red + (1 - base.red) * amount,
    green: base.green + (1 - base.green) * amount,
    blue: base.blue + (1 - base.blue) * amount,
    alpha: 1,
  };
}

/** Mixes toward black, for text that has to sit on its own tint. */
export function shade(hex: string, amount: number): Rgb {
  const base = rgb(hex);
  return {
    red: base.red * (1 - amount),
    green: base.green * (1 - amount),
    blue: base.blue * (1 - amount),
    alpha: 1,
  };
}

const INK = "#1F2D3D"; // the same near-black as the Slack app's brand colour
const PAPER = "#FFFFFF";
const MUTED = "#5B6B7C";
const RULE = "#DFE5EC";
const BAND = "#F6F8FA";

const BODY_FONT = "Roboto";
const MONO_FONT = "Roboto Mono";

/** Per-tab column widths in pixels, sized to the content each column holds. */
const WIDTHS: Record<string, number[]> = {
  Summary: [150, 240, 120],
  Tasks: [70, 120, 90, 340, 130, 140, 130, 130, 130, 130, 130, 90, 110, 150, 80, 200, 420],
  Sessions: [70, 280, 140, 110, 130, 130, 150, 90, 80, 130, 260],
  Activity: [70, 130, 140, 140, 460],
};

/** Columns holding a number, so the sheet can sum them rather than treat as text. */
const NUMERIC: Record<string, number[]> = {
  Tasks: [12], // Effort (hours)
  Sessions: [8, 9], // Hours, Adjustment (min)
  Summary: [],
  Activity: [],
};

/** Long free text: clipped rather than wrapped, so rows stay one line tall. */
const CLIPPED: Record<string, number[]> = {
  Tasks: [3, 15, 16],
  Sessions: [1, 10],
  Activity: [4],
  Summary: [],
};

const TAB_COLORS: Record<string, string> = {
  Summary: "#1F2D3D",
  Tasks: "#5B8DEF",
  Sessions: "#22B8CF",
  Activity: "#8B8D98",
};

/** Row 1 is a merged banner; row 2 the column headers; data starts at row 3. */
export const BANNER_ROWS = 1;
export const HEADER_ROW = BANNER_ROWS; // zero-indexed
export const FIRST_DATA_ROW = BANNER_ROWS + 1;

export function bannerFor(sheet: Sheet, updatedAt: Date): string {
  const stamp = updatedAt.toISOString().replace("T", " ").slice(0, 16);
  return `RELAY · ${sheet.name.toUpperCase()}      updated ${stamp} UTC`;
}

export interface TabMeta {
  sheetId: number;
  title: string;
  bandedRangeIds: number[];
  conditionalFormatCount: number;
}

/**
 * Every formatting request for one tab.
 *
 * Existing banding and conditional rules are removed first, so re-running this
 * replaces the design rather than stacking a second copy on top of it.
 */
export function styleRequests(sheet: Sheet, meta: TabMeta): unknown[] {
  const sheetId = meta.sheetId;
  const columns = sheet.header.length;
  const widths = WIDTHS[sheet.name] ?? [];
  const requests: unknown[] = [];

  // ---- clear anything a previous version applied ----------------------------
  for (const id of meta.bandedRangeIds) {
    requests.push({ deleteBanding: { bandedRangeId: id } });
  }
  // Rules shift down as they're deleted, so index 0 repeatedly clears them all.
  for (let i = 0; i < meta.conditionalFormatCount; i++) {
    requests.push({ deleteConditionalFormatRule: { sheetId, index: 0 } });
  }

  // ---- frozen rows + tab colour --------------------------------------------
  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount: FIRST_DATA_ROW },
        tabColor: rgb(TAB_COLORS[sheet.name] ?? INK),
      },
      fields: "gridProperties.frozenRowCount,tabColor",
    },
  });

  // ---- banner --------------------------------------------------------------
  requests.push({
    mergeCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columns },
      mergeType: "MERGE_ALL",
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columns },
      cell: {
        userEnteredFormat: {
          backgroundColor: rgb(INK),
          verticalAlignment: "MIDDLE",
          padding: { left: 14, right: 14, top: 6, bottom: 6 },
          textFormat: {
            fontFamily: BODY_FONT,
            fontSize: 13,
            bold: true,
            foregroundColor: rgb(PAPER),
          },
        },
      },
      fields: "userEnteredFormat",
    },
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 40 },
      fields: "pixelSize",
    },
  });

  // ---- column headers ------------------------------------------------------
  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: HEADER_ROW,
        endRowIndex: HEADER_ROW + 1,
        startColumnIndex: 0,
        endColumnIndex: columns,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: rgb(PAPER),
          verticalAlignment: "MIDDLE",
          padding: { left: 10, right: 10 },
          textFormat: {
            fontFamily: BODY_FONT,
            fontSize: 10,
            bold: true,
            foregroundColor: rgb(MUTED),
          },
        },
      },
      fields: "userEnteredFormat",
    },
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: "ROWS", startIndex: HEADER_ROW, endIndex: HEADER_ROW + 1 },
      properties: { pixelSize: 32 },
      fields: "pixelSize",
    },
  });

  // A single rule under the header carries the whole structure — heavy gridlines
  // make a sheet look busier without making it easier to read.
  requests.push({
    updateBorders: {
      range: {
        sheetId,
        startRowIndex: HEADER_ROW,
        endRowIndex: HEADER_ROW + 1,
        startColumnIndex: 0,
        endColumnIndex: columns,
      },
      bottom: { style: "SOLID_MEDIUM", width: 2, color: rgb(INK) },
    },
  });

  // ---- body ----------------------------------------------------------------
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: FIRST_DATA_ROW, startColumnIndex: 0, endColumnIndex: columns },
      cell: {
        userEnteredFormat: {
          verticalAlignment: "MIDDLE",
          padding: { left: 10, right: 10 },
          textFormat: { fontFamily: BODY_FONT, fontSize: 10, foregroundColor: rgb(INK) },
        },
      },
      fields:
        "userEnteredFormat.verticalAlignment,userEnteredFormat.padding,userEnteredFormat.textFormat",
    },
  });

  // The reference column reads as an identifier, so it gets a monospace face.
  if (sheet.name !== "Summary") {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: FIRST_DATA_ROW, startColumnIndex: 0, endColumnIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { fontFamily: MONO_FONT, fontSize: 10, bold: true, foregroundColor: rgb(MUTED) },
          },
        },
        fields: "userEnteredFormat.textFormat",
      },
    });
  }

  for (const column of CLIPPED[sheet.name] ?? []) {
    if (column >= columns) continue;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: FIRST_DATA_ROW, startColumnIndex: column, endColumnIndex: column + 1 },
        cell: { userEnteredFormat: { wrapStrategy: "CLIP" } },
        fields: "userEnteredFormat.wrapStrategy",
      },
    });
  }

  for (const column of NUMERIC[sheet.name] ?? []) {
    if (column >= columns) continue;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: FIRST_DATA_ROW, startColumnIndex: column, endColumnIndex: column + 1 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "NUMBER", pattern: "0.00" },
            horizontalAlignment: "RIGHT",
          },
        },
        fields: "userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment",
      },
    });
  }

  // ---- column widths -------------------------------------------------------
  widths.forEach((pixelSize, index) => {
    if (index >= columns) return;
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    });
  });

  // ---- zebra striping ------------------------------------------------------
  requests.push({
    addBanding: {
      bandedRange: {
        range: { sheetId, startRowIndex: FIRST_DATA_ROW, startColumnIndex: 0, endColumnIndex: columns },
        rowProperties: { firstBandColor: rgb(PAPER), secondBandColor: rgb(BAND) },
      },
    },
  });

  // ---- status colours ------------------------------------------------------
  // Deliberately the same palette as the Slack card stripes, so a status looks
  // the same wherever someone meets it.
  const statusColumn = sheet.name === "Tasks" ? 1 : -1;
  if (statusColumn >= 0) {
    for (const meta_ of Object.values(STATUS)) {
      requests.push({
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: FIRST_DATA_ROW,
                startColumnIndex: statusColumn,
                endColumnIndex: statusColumn + 1,
              },
            ],
            booleanRule: {
              condition: { type: "TEXT_EQ", values: [{ userEnteredValue: meta_.label }] },
              // A pale wash of the status colour, with a darkened version of the
              // same colour for the text. Both are computed rather than relying
              // on opacity, which Sheets discards.
              // 0.45 rather than something lighter because amber is a pale hue
              // to begin with — a gentler shade drops it below readable contrast
              // on its own fill, while the darker hues have room to spare.
              format: {
                backgroundColor: tint(meta_.color, 0.88),
                textFormat: { bold: true, foregroundColor: shade(meta_.color, 0.45) },
              },
            },
          },
        },
      });
    }
  }

  // ---- sortable headers ----------------------------------------------------
  requests.push({
    setBasicFilter: {
      filter: {
        range: {
          sheetId,
          startRowIndex: HEADER_ROW,
          startColumnIndex: 0,
          endColumnIndex: columns,
        },
      },
    },
  });

  return requests;
}

/** Light horizontal rules between rows, applied after data is written. */
export function ruleRequests(sheet: Sheet, meta: TabMeta, rowCount: number): unknown[] {
  if (rowCount === 0) return [];
  return [
    {
      updateBorders: {
        range: {
          sheetId: meta.sheetId,
          startRowIndex: FIRST_DATA_ROW,
          endRowIndex: FIRST_DATA_ROW + rowCount,
          startColumnIndex: 0,
          endColumnIndex: sheet.header.length,
        },
        innerHorizontal: { style: "SOLID", width: 1, color: rgb(RULE) },
      },
    },
  ];
}
