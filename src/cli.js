import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import geocode from "./csvgeocode.js";
import { stringifyRow, canonicalEncoding } from "./csv.js";
import * as misc from "./misc.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));

const usage = `Usage: csvgeocode [options] [input CSV] [output CSV]

With no output CSV, results are written to stdout.

Options:
  --url             [REQUIRED] A URL template to use, with column names from your input CSV surrounded by {{}}. Example: http://mygeocoder.com/?address={{STREET_ADDRESS}}&apiKey=123ABC
  --handler         What API handler to use. Built-in options are 'google', 'mapbox', 'osm' and 'tamu'. Default: 'google'
  --encoding        The input file's text encoding, if it isn't UTF-8: e.g. 'windows-1252' (plain CSV from Excel on Windows) or 'macintosh' (Excel on a Mac). Output is always UTF-8. Default: 'utf-8'
  --lat             Latitude column name. Default: automatic detection
  --lng             Longitude column name. Default: automatic detection
  --delay           Milliseconds to wait between API calls. Default: 250
  --timeout         Milliseconds to wait for each API response before giving up on that row. Default: 30000
  --retries         Times to retry a request that failed with a temporary error (network, timeout, rate limit, server error), waiting 2s, 10s, then 30s. Default: 3
  --precision       Decimal places to round lat/lng to. Default: 6
  --status-columns  Add geocode_status, geocode_location_type and geocode_partial_match columns: why a row failed, and how precise each match is (Google)
  --save-every      Save progress to the output file every N rows, so an interrupted run can be resumed. 0 disables. Default: 100
  --resume          Continue an interrupted run: rows already geocoded in the output file are kept and skipped
  --overwrite       Replace the output file if it already exists
  --force           Re-geocode every row, even input rows that already have a lat/lng. (To replace an existing output file, use --overwrite.) Can't be resumed
  --verbose         Show a status line for every row while csvgeocode is running (the summary at the end is always shown)
  --version         Show the installed version number
  --help            Show this message`;

//Print a problem with the arguments and exit
function fail(message) {
  console.error(message);
  console.error("Run csvgeocode --help for usage.");
  process.exit(1);
}

let args, files;

try {
  ({ values: args, positionals: files } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      handler: { type: "string" },
      encoding: { type: "string" },
      lat: { type: "string" },
      lng: { type: "string" },
      delay: { type: "string" },
      timeout: { type: "string" },
      retries: { type: "string" },
      precision: { type: "string" },
      "save-every": { type: "string" },
      "status-columns": { type: "boolean" },
      resume: { type: "boolean" },
      overwrite: { type: "boolean" },
      force: { type: "boolean" },
      verbose: { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  }));
} catch (e) {
  fail(e.message);
}

if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}

if (args.help || !files.length) {
  console.log(usage);
  process.exit(0);
}

if (args.url === undefined) {
  fail("Missing required option: --url");
}

if ("delay" in args && isNaN(Number(args.delay))) {
  fail("--delay requires a numeric value in milliseconds.");
}

if ("timeout" in args && !(/^\d+$/.test(args.timeout) && Number(args.timeout) > 0)) {
  fail("--timeout requires a whole number of milliseconds, greater than 0.");
}

if ("retries" in args && !/^\d+$/.test(args.retries)) {
  fail("--retries requires a whole number.");
}

if ("precision" in args && !/^\d+$/.test(args.precision)) {
  fail("--precision requires a whole number of decimal places.");
}

if (args.resume && files.length < 2) {
  fail("--resume requires an output file.");
}

if (args.resume && args.force) {
  fail("--resume and --force can't be used together: a --force run re-geocodes every row, so there's no way to tell which rows in the output are already done.");
}

if (args.resume && args.overwrite) {
  fail("--resume and --overwrite can't be used together.");
}

if (files.length > 1) {

  if (path.resolve(files[0]) === path.resolve(files[1])) {
    fail("The output file can't be the same as the input file.");
  }

  //Don't clobber a previous (possibly partial) run by accident
  if (fs.existsSync(files[1]) && !args.resume && !args.overwrite) {
    fail(files[1] + " already exists. Add --resume to continue that run, or --overwrite to replace it.");
  }

}

if ("save-every" in args && !/^\d+$/.test(args["save-every"])) {
  fail("--save-every requires a whole number of rows.");
}

if ("encoding" in args && !canonicalEncoding(args.encoding)) {
  fail("--encoding: \"" + args.encoding + "\" isn't an encoding Node knows. Try utf-8, windows-1252, macintosh, utf-16le or another WHATWG encoding name.");
}

const [input, output] = files,
      options = { url: args.url };

for (const key of ["handler", "encoding", "lat", "lng"]) {
  if (key in args) options[key] = args[key];
}

for (const key of ["resume", "force"]) {
  if (args[key]) options[key] = true;
}

if (args["status-columns"]) options.statusColumns = true;

if ("delay" in args) options.delay = Number(args.delay);
if ("timeout" in args) options.timeout = Number(args.timeout);
if ("retries" in args) options.retries = Number(args.retries);
if ("precision" in args) options.precision = Number(args.precision);
if ("save-every" in args) options.saveEvery = Number(args["save-every"]);

const geocoder = output ? geocode(input, output, options) : geocode(input, options);

//A one-line progress indicator, rewritten in place with \r, for an
//interactive terminal that isn't already getting a line per row from
//--verbose
const showProgress = Boolean(output) && process.stderr.isTTY && !args.verbose;
let progressShown = false, //A progress line is currently on the screen, so the next thing printed needs a fresh line first
    rowsDone = 0;

//Exit codes matching the conventional 128 + signal number
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

function endProgress() {
  if (progressShown) {
    process.stderr.write("\n");
    progressShown = false;
  }
}

geocoder.on("error", function(err) {
  endProgress();
  console.error(err.message);
  //The run was stopped partway; progress was saved
  if (err.progress) {
    console.error("Saved " + err.progress.done + " of " + err.progress.total + " rows to " + output + ". Once the problem is fixed, rerun with --resume to continue.");
  }
  process.exit(1);
});

geocoder.on("resume", function(progress) {
  if (progress.found) {
    //Start the progress line from the rows a previous run already did
    rowsDone = progress.done + (progress.failed || 0);
    console.warn("Resuming: " + progress.done + " of " + progress.total + " rows already geocoded in " + output +
      (progress.failed ? ", and skipping " + progress.failed + " that failed permanently (see geocode_status)" : ""));
  } else {
    console.warn("Nothing to resume: " + output + " doesn't exist yet. Starting from the beginning.");
  }
});

//On Ctrl-C or kill, save whatever has been geocoded so far before exiting
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, function() {
    const progress = geocoder.saveProgress({ quiet: true }),
          newline = progressShown ? "" : "\n"; //Move past the echoed ^C, unless endProgress already did
    endProgress();
    if (progress) {
      console.warn(newline + "Interrupted. Saved " + progress.done + " of " + progress.total + " rows to " + output);
    }
    process.exit(SIGNAL_EXIT_CODES[signal]);
  });
}

if (showProgress) {
  geocoder.on("row", function() {
    rowsDone++;
    process.stderr.write("\r" + misc.progressLine(rowsDone, geocoder.total || rowsDone));
    progressShown = true;
  }).on("complete", endProgress);
}

if (args.verbose) {

  geocoder.on("row", function(err, row, details) {
      console.warn(rowStatus(err, details) + " | " + stringifyRow(row));
    })
    .on("retry", function(retry, row) {
      console.warn("Retrying in " + (retry.wait / 1000) + " seconds after " + retry.error + " | " + stringifyRow(row));
    })
    .on("progress", function(progress) {
      console.warn("Saved progress: " + progress.done + " of " + progress.total + " rows");
    });

}

//The end-of-run summary always goes to stderr, so it never mixes with CSV
//output on stdout. A blank line first separates it from --verbose's row lines.
geocoder.on("complete", function(summary) {
  const lines = ["Rows geocoded: " + summary.geocoded, "Rows failed: " + summary.failures];
  if (summary.skipped > 0) {
    lines.push("Rows skipped (already had a lat/lng, or done in a previous run): " + summary.skipped);
  }
  lines.push("Time elapsed: " + (Math.round(summary.time / 100) / 10) + " seconds");
  console.warn((args.verbose ? "\n" : "") + lines.join("\n"));
});

//The status at the start of a --verbose row line: "SUCCESS" for an exact
//match, "SUCCESS (APPROXIMATE, partial match)" for a less precise one,
//"TEMPORARY ERROR: ..." for a failure that might work on another try
function rowStatus(err, details = {}) {

  if (err) {
    return (details.temporary ? "TEMPORARY ERROR: " : "") + err;
  }

  const notes = [];

  if (details.locationType && details.locationType !== "ROOFTOP") {
    notes.push(details.locationType);
  }

  if (details.partialMatch) {
    notes.push("partial match");
  }

  return "SUCCESS" + (notes.length ? " (" + notes.join(", ") + ")" : "");

}
