import fs from "node:fs";
import { csvParse, csvFormat, csvFormatBody } from "d3-dsv";

const BOM = "\uFEFF";

//Excel's "CSV UTF-8" files start with an invisible byte order mark, which
//would otherwise end up in the first column's name. Strip it, and remember
//it (rows.bom) so the output gets one too and Excel still reads it as UTF-8.
export async function read(filename) {
  const text = await fs.promises.readFile(filename, "utf8"),
        bom = text.startsWith(BOM),
        rows = csvParse(bom ? text.slice(1) : text);
  rows.bom = bom;
  return rows;
}

//columns, if given, fixes the header (and its order) even when rows is
//empty or a row is missing some of them; otherwise d3 infers it from the
//rows, which means a header-only input (no data rows) writes no header at
//all
function format(rows, columns) {
  return (rows.bom ? BOM : "") + csvFormat(rows, columns);
}

//Write to a temp file and rename it into place, so a crash or kill
//mid-write never leaves a truncated output file behind
export async function write(filename, rows, columns) {
  const tmp = filename + ".tmp";
  await fs.promises.writeFile(tmp, format(rows, columns));
  await fs.promises.rename(tmp, filename);
}

export function writeSync(filename, rows, columns) {
  const tmp = filename + ".tmp";
  fs.writeFileSync(tmp, format(rows, columns));
  fs.renameSync(tmp, filename);
}

export function stringify(rows, columns) {
  return csvFormat(rows, columns);
}

//One row as a CSV line, without the header
export function stringifyRow(row) {
  return csvFormatBody([row]);
}
