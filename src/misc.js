//Round to a fixed number of decimal places, dropping trailing zeros
export function round(number, places) {
  return Number(Number(number).toFixed(places));
}

//Is it numeric and between -limit and +limit? (90 for latitude, 180 for longitude)
export function isNumeric(number, limit = 180) {
  return !Array.isArray(number) && (number - parseFloat(number) + 1) >= 0 && number >= -limit && number <= limit;
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
