import fs from "node:fs";
import { csvParse, csvFormat, csvFormatBody } from "d3-dsv";

const BOM = "\uFEFF";

//How a file that isn't UTF-8 is reported. csvgeocode never guesses an
//encoding: the input is UTF-8 unless the encoding option says otherwise.
export class EncodingError extends Error {}

//Read and parse a CSV. Excel's "CSV UTF-8" files start with an invisible
//byte order mark, which would otherwise end up in the first column's name.
//Strip it, and remember it (rows.bom) so the output gets one too and Excel
//still reads it as UTF-8.
export async function read(filename, encoding = "utf-8") {
  const bytes = await fs.promises.readFile(filename),
        text = decode(bytes, encoding, filename),
        bom = text.startsWith(BOM),
        rows = csvParse(bom ? text.slice(1) : text);
  rows.bom = bom;
  return rows;
}

//Decode a file's bytes, refusing (rather than silently mangling into
//replacement characters) anything that isn't valid in the given encoding
function decode(bytes, encoding, filename) {

  //A UTF-16 file (e.g. a SQL Server or older PowerShell export) starts with
  //its own byte order mark; say so instead of blaming UTF-8
  if (isUtf8(encoding) && bytes.length >= 2 && ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF))) {
    throw new EncodingError(filename + " is UTF-16, not UTF-8. Convert it to UTF-8 first (e.g. iconv -f UTF-16 -t UTF-8), or pass --encoding utf-16le or --encoding utf-16be.");
  }

  //ignoreBOM keeps a leading BOM in the text so read() can see it
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });

  try {
    return decoder.decode(bytes);
  } catch (e) {
    if (isUtf8(encoding)) {
      throw new EncodingError(filename + " isn't valid UTF-8. In Excel, save it as \"CSV UTF-8\" instead of plain \"CSV\", or tell csvgeocode the file's encoding: --encoding windows-1252 (Excel on Windows) or --encoding macintosh (Excel on a Mac).");
    }
    throw new EncodingError(filename + " isn't valid " + decoder.encoding + ".");
  }

}

function isUtf8(encoding) {
  return new TextDecoder(encoding).encoding === "utf-8";
}

//Is this an encoding name Node's TextDecoder knows? Returns its canonical
//name (e.g. "latin1" is decoded as windows-1252), or null.
export function canonicalEncoding(label) {
  try {
    return new TextDecoder(label).encoding;
  } catch (e) {
    return null;
  }
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
