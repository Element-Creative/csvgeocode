//Round to a fixed number of decimal places, dropping trailing zeros
export function round(number, places) {
  return Number(Number(number).toFixed(places));
}

//A plain decimal number, optionally signed, optionally with a fraction
//and/or an exponent (e.g. "-96.683712", "45", "1e2"). Deliberately doesn't
//match things JS's own Number() accepts but a spreadsheet wouldn't consider
//a number, like "0x10" (hex) or "Infinity".
const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

//Is it numeric and between -limit and +limit? (90 for latitude, 180 for longitude)
export function isNumeric(value, limit = 180) {

  let number;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return false;
    }
    number = value;
  } else if (typeof value === "string" && NUMERIC_STRING.test(value.trim())) {
    number = Number(value.trim());
  } else {
    return false;
  }

  return number >= -limit && number <= limit;

}

//Try to auto-discover missing column names
export function discoverOptions(options, row) {

  for (const key in row) {
    if (options.lat === null && key.trim().match(/^lat(itude)?$/i)) {
      options.lat = key;
      continue;
    }
    if (options.lng === null && key.trim().match(/^lo?ng(itude)?$/i)) {
      options.lng = key;
      continue;
    }
  }

  if (options.lat === null) {
    options.lat = "lat";
  }

  if (options.lng === null) {
    options.lng = "lng";
  }

  return options;

}

//The CLI's non-verbose progress line, rewritten in place with \r.
//A small exported function so it can be unit-tested without a real TTY.
export function progressLine(done, total) {
  return "Processed " + done.toLocaleString("en-US") + " of " + total.toLocaleString("en-US") + " rows";
}
