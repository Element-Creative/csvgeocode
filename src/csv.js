import fs from "node:fs";
import { csvParse, csvFormat, csvFormatBody } from "d3-dsv";

export async function read(filename) {
  return csvParse(await fs.promises.readFile(filename, "utf8"));
}

//Write to a temp file and rename it into place, so a crash or kill
//mid-write never leaves a truncated output file behind
export async function write(filename, rows) {
  const tmp = filename + ".tmp";
  await fs.promises.writeFile(tmp, csvFormat(rows));
  await fs.promises.rename(tmp, filename);
}

export function writeSync(filename, rows) {
  const tmp = filename + ".tmp";
  fs.writeFileSync(tmp, csvFormat(rows));
  fs.renameSync(tmp, filename);
}

export { csvFormat as stringify };

//One row as a CSV line, without the header
export function stringifyRow(row) {
  return csvFormatBody([row]);
}
