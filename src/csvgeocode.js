import fs from "node:fs";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import * as misc from "./misc.js";
import * as csv from "./csv.js";
import defaults from "./defaults.js";
import handlers from "./handlers.js";

//Identify csvgeocode to the API it's talking to, e.g. so Nominatim's usage
//policy (which requires an identifying User-Agent) is satisfied
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))),
      USER_AGENT = "csvgeocode/" + pkg.version + " (+https://github.com/Element-Creative/csvgeocode)";

//geocode(input, [output], options)
export default function generate(input, output, options) {

  //No output file: geocode(input, options) streams to stdout
  if (arguments.length === 2 && typeof output !== "string") {
    options = output;
    output = null;
  }

  //Extend default options
  options = { ...defaults, ...options };

  if (typeof options.handler === "string") {
    options.handler = options.handler.toLowerCase();
    if (handlers[options.handler]) {
      options.handler = handlers[options.handler];
    } else {
      throw new Error("Invalid value for 'handler' option.  Must be the name of a built-in handler or a custom handler.");
    }
  } else if (typeof options.handler !== "function") {
    throw new TypeError("Invalid value for 'handler' option.  Must be the name of a built-in handler or a custom handler.");
  }

  if (output && typeof output !== "string") {
    throw new TypeError("Invalid value for output.  Needs to be a string filename.");
  }

  if (typeof options.url !== "string") {
    throw new Error("'url' parameter is required.");
  }

  if (typeof options.encoding !== "string" || !csv.canonicalEncoding(options.encoding)) {
    throw new Error("Invalid value for 'encoding' option: " + JSON.stringify(options.encoding) + ". Must be an encoding name like utf-8, windows-1252 or macintosh.");
  }

  return new Geocoder().run(input, output || null, options);

}

//A {{column}} tag in the URL template
const TEMPLATE_TAG = /\{\{\s*([^{}]+?)\s*\}\}/g;

//Extra output columns with the statusColumns option
const STATUS = "geocode_status",
      LOCATION_TYPE = "geocode_location_type",
      PARTIAL_MATCH = "geocode_partial_match",
      STATUS_COLUMNS = [STATUS, LOCATION_TYPE, PARTIAL_MATCH];

//Status prefix for failures that are worth trying again later
const TEMPORARY = "TEMPORARY ERROR: ";

//An error that ends the whole run (after saving progress)
class StopError extends Error {}

class Geocoder extends EventEmitter {

  run(input, output, options) {

    const cache = {}, //Outcomes by URL: results and permanent failures
          resumed = new Set(), //Rows already done in a previous run's output
          time = Date.now(),
          _this = this;

    let rows = null, //All parsed rows, filled in as they're geocoded
        outputColumns = null, //Column order for the output file (input columns, plus lat/lng and status columns)
        done = 0, //Number of rows processed so far
        unsaved = 0, //Number of rows geocoded since the last save
        failedInARow = 0, //Consecutive rows that failed with temporary errors
        skippedRows = new Set(); //Rows that needed no geocoding: already had coordinates, or were resumed

    this.options = options;
    this.saveProgress = saveProgress;

    start().catch(err => _this.emit("error", err));

    return this;

    async function start() {

      //The output file (read for --resume) is always UTF-8, since csvgeocode
      //wrote it; only the input can be in another encoding
      const parsed = await csv.read(input, options.encoding);
      let previous = null;

      checkTemplate(parsed.columns);

      //Pick up where a previous run left off, if its output exists
      if (options.resume && typeof output === "string") {
        if (fs.existsSync(output)) {
          previous = await csv.read(output);
        } else {
          _this.emit("resume", { found: false, done: 0, total: parsed.length });
        }
      }

      //If there are unset column names,
      //try to discover them on the first data row
      if (options.lat === null || options.lng === null) {
        options = misc.discoverOptions(options, parsed[0]);
      }

      rows = parsed;
      _this.total = rows.length;

      if (previous) {

        //Keep the status columns going if the previous run had them
        if (previous.columns.includes(STATUS)) {
          options.statusColumns = true;
        }

        const failed = resumeFrom(previous);
        _this.emit("resume", { found: true, done: resumed.size - failed, failed: failed, total: parsed.length });

      }

      outputColumns = buildOutputColumns(parsed.columns);

      try {

        for (const row of rows) {
          const skipped = needsNoGeocoding(row);
          if (skipped) {
            skippedRows.add(row);
          }
          const requested = await codeRow(row);
          done++;
          if (!skipped && options.saveEvery > 0 && ++unsaved >= options.saveEvery && done < rows.length) {
            saveProgress();
          }
          //Every row lately failed with a temporary error: the network or
          //the API is probably down, so stop rather than fail every row
          if (options.maxFailedInARow > 0 && failedInARow >= options.maxFailedInARow) {
            throw new StopError("Stopping: the last " + failedInARow + " rows all failed with temporary errors, even after retrying. Check your network connection and the API's status.");
          }
          //Pace the requests. This comes after done++ so a Ctrl-C during the
          //wait reports the row that was just finished as done.
          if (requested && done < rows.length) {
            await sleep(options.delay);
          }
        }

      } catch (e) {
        //Save what's done so the run can be resumed
        if (e instanceof StopError) {
          e.progress = saveProgress({ quiet: true });
        }
        throw e;
      }

      await complete(rows);

    }

    //The output file's columns, in order: the input's columns, then lat/lng
    //(unless already one of the input columns), then status columns if enabled.
    //Passed explicitly to d3-dsv so a header-only input (no data rows) still
    //writes its header, instead of an empty file.
    function buildOutputColumns(columns) {

      const result = columns.slice();

      for (const column of [options.lat, options.lng]) {
        if (!result.includes(column)) {
          result.push(column);
        }
      }

      if (options.statusColumns) {
        for (const column of STATUS_COLUMNS) {
          if (!result.includes(column)) {
            result.push(column);
          }
        }
      }

      return result;

    }

    //Geocode one row. Resolves to true if it made a request to the API (so
    //the caller should wait the delay before the next row).
    async function codeRow(row) {

      //Doesn't need geocoding
      if (needsNoGeocoding(row)) {
        //Rows finished in a previous run aren't reported again
        if (!resumed.has(row)) {
          _this.emit("row", null, row);
        }
        return false;
      }

      //Every {{column}} the URL template uses is empty: don't bother making
      //a request for an address that isn't there
      if (isBlankAddress(row)) {
        record(row, { message: "NO ADDRESS" });
        return false;
      }

      const url = fillTemplate(options.url, row);

      //Same address as an earlier row: reuse its result or permanent failure
      const cached = cache[url],
            outcome = cached || await request(url, row);

      record(row, outcome);

      return !cached;

    }

    //True if every {{column}} the URL template uses is empty or whitespace
    //for this row (and there's at least one such column)
    function isBlankAddress(row) {
      const columns = templateColumns(options.url);
      return columns.length > 0 && columns.every(column => !String(row[column] ?? "").trim());
    }

    //Request a URL, retrying temporary problems. Stops the run on a fatal one.
    async function request(url, row) {

      let outcome = await attempt(url);

      //Temporary problem: wait and try again
      for (let retry = 0; outcome.retry && retry < options.retries; retry++) {
        const wait = retryWait(retry);
        _this.emit("retry", { error: outcome.message, wait: wait, retry: retry + 1, retries: options.retries }, row);
        await sleep(wait);
        outcome = await attempt(url);
      }

      //A problem with the API key or account: every row would fail
      if (outcome.fatal) {
        throw new StopError("Stopping: " + outcome.message);
      }

      //Temporary failures aren't cached, so a later row with the same
      //address tries again
      if (!outcome.retry) {
        cache[url] = outcome;
      }

      failedInARow = outcome.retry ? failedInARow + 1 : 0;

      return outcome;

    }

    //Fill in a row's lat/lng (and status columns) from an outcome
    function record(row, outcome) {

      const result = outcome.result;

      row[options.lat] = result ? result.lat : "";
      row[options.lng] = result ? result.lng : "";

      if (options.statusColumns) {
        row[STATUS] = result ? "SUCCESS" : (outcome.retry ? TEMPORARY : "") + outcome.message;
        row[LOCATION_TYPE] = result && result.locationType ? result.locationType : "";
        row[PARTIAL_MATCH] = result && typeof result.partialMatch === "boolean" ? String(result.partialMatch) : "";
      }

      //Third argument: how precise a match is, or whether a failure is temporary
      const details = result ?
        { locationType: result.locationType, partialMatch: result.partialMatch } :
        { temporary: Boolean(outcome.retry) };

      _this.emit("row", result ? null : outcome.message, row, details);

    }

    //Request one URL. Resolves to { result: {lat, lng, ...} } on success, or
    //{ message } for a failed row, plus retry: true if it's worth trying
    //again or fatal: true if the whole run should stop.
    async function attempt(url) {

      let response, body, result;

      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(options.timeout),
          headers: { "User-Agent": USER_AGENT }
        });
        body = await response.text();
      } catch (e) {
        return { message: describeError(e), retry: true };
      }

      if (response.status !== 200) {
        const message = "HTTP Status " + response.status;
        //Bad key or no access
        if (response.status === 401 || response.status === 403) {
          return { message: message, fatal: true };
        }
        //Rate limited or server trouble
        if (response.status === 429 || response.status >= 500) {
          return { message: message, retry: true };
        }
        return { message: message };
      }

      //A body the handler can't read (e.g. a Wi-Fi login page) isn't the
      //address's fault
      try {
        result = options.handler(body);
      } catch (e) {
        return { message: "Parsing error: " + e.toString(), retry: true };
      }

      //Error code
      if (typeof result === "string") {
        return { message: result };
      }

      //Handlers can flag errors as temporary or fatal
      if (result && typeof result.retry === "string") {
        return { message: result.retry, retry: true };
      }

      if (result && typeof result.fatal === "string") {
        return { message: result.fatal, fatal: true };
      }

      //Success: lat/lng have to be real, in-range coordinates, not e.g. NaN
      //from a Google response with an empty geometry.location
      if (result && misc.isNumeric(result.lat, 90) && misc.isNumeric(result.lng, 180)) {

        //Round off floating-point noise (e.g. -96.68371259999999)
        const round = options.precision !== null && options.precision !== false;

        return {
          result: {
            lat: round ? misc.round(result.lat, options.precision) : result.lat,
            lng: round ? misc.round(result.lng, options.precision) : result.lng,
            locationType: result.locationType,
            partialMatch: result.partialMatch
          }
        };

      }

      //Unknown extraction error
      return { message: "Invalid return value from handler for response body: " + body };

    }

    //Milliseconds to wait before the nth retry (0-based), repeating the last
    //wait if there are more retries than waits
    function retryWait(retry) {
      const waits = options.retryWaits;
      return waits[Math.min(retry, waits.length - 1)];
    }

    //A readable message for a request that got no response
    function describeError(e) {
      if (e.name === "TimeoutError") {
        return "Timed out after " + (options.timeout / 1000) + " seconds";
      }
      return "Network error: " + (e.cause && e.cause.message ? e.cause.message : e.message);
    }

    async function complete(results) {

      //successes: rows that have a valid lat/lng at the end, whether they were
      //geocoded now or already had one (in the input, or a resumed output)
      //skipped: rows that needed no geocoding this run, for either reason
      //geocoded: successes that were actually geocoded during this run
      const numSuccesses = results.filter(successful).length,
            numFailures = results.length - numSuccesses,
            numSkipped = skippedRows.size,
            numSkippedSuccesses = results.filter(row => skippedRows.has(row) && successful(row)).length,
            numGeocoded = numSuccesses - numSkippedSuccesses,
            summarize = function() {
              _this.emit("complete", {
                failures: numFailures,
                successes: numSuccesses,
                geocoded: numGeocoded,
                skipped: numSkipped,
                time: Date.now() - time
              });
            };

      if (options.test) {
        summarize();
      } else if (typeof output === "string") {
        await csv.write(output, results, outputColumns);
        summarize();
      } else {
        process.stdout.write(csv.stringify(results, outputColumns), summarize);
      }

    }

    function needsNoGeocoding(row) {
      return resumed.has(row) || (!options.force && hasCoordinates(row));
    }

    //Is there a valid lat/lng in the row?
    function hasCoordinates(row) {
      return misc.isNumeric(row[options.lat], 90) && misc.isNumeric(row[options.lng], 180);
    }

    //A failure that retrying won't fix, like NO MATCH
    function isPermanentFailure(status) {
      return Boolean(status) && status !== "SUCCESS" && !status.startsWith(TEMPORARY);
    }

    //Copy lat/lngs (and status columns) from a previous run's output onto the
    //input rows, after checking that the output really came from this same
    //input. Rows that were geocoded, or failed permanently, are skipped this
    //time. Returns the number of permanent failures.
    function resumeFrom(previous) {

      if (previous.length !== rows.length) {
        throw new Error("Can't resume: " + output + " has " + previous.length + " rows but " + input + " has " + rows.length + ".");
      }

      const outputColumns = [options.lat, options.lng].concat(options.statusColumns ? STATUS_COLUMNS : []);
      let failed = 0;

      rows.forEach(function(row, i) {

        const before = previous[i];

        for (const key in row) {
          if (!outputColumns.includes(key) && row[key] !== before[key]) {
            throw new Error("Can't resume: row " + (i + 1) + " of " + output + " doesn't match " + input + " (column \"" + key + "\").");
          }
        }

        const geocoded = hasCoordinates(before),
              failedBefore = !geocoded && options.statusColumns && isPermanentFailure(before[STATUS]);

        if (geocoded || failedBefore) {
          for (const key of outputColumns) {
            row[key] = before[key] === undefined ? "" : before[key];
          }
          resumed.add(row);
          failed += failedBefore ? 1 : 0;
        }

      });

      return failed;

    }

    //Write every row so far (geocoded ones plus the untouched remainder) to the
    //output file, so an interrupted run can resume by using it as the input.
    //quiet: skip the "progress" event, when the caller reports the save itself.
    function saveProgress({ quiet = false } = {}) {

      if (!rows || typeof output !== "string" || options.test) {
        return null;
      }

      csv.writeSync(output, rows, outputColumns);
      unsaved = 0;

      const progress = { done: done, total: rows.length };
      if (!quiet) {
        _this.emit("progress", progress);
      }
      return progress;

    }

    function successful(row) {
      return hasCoordinates(row);
    }

    //Make sure every {{column}} in the URL template is a real column, so a
    //typo doesn't quietly geocode (and pay for) partial addresses. Also
    //refuses a CSV with a duplicate column name, since only one of them
    //could ever be kept.
    function checkTemplate(columns) {

      const duplicate = firstDuplicate(columns);
      if (duplicate) {
        throw new Error(input + " has more than one column named \"" + duplicate +
          "\". Rename or remove the duplicates first, since only one of them can be kept.");
      }

      const missing = templateColumns(options.url).filter(column => !columns.includes(column));

      if (!missing.length) {
        return;
      }

      const tags = missing.map(column => "{{" + column + "}}"),
            suggestions = missing.map(column => columns.find(c => c.trim().toLowerCase() === column.toLowerCase()))
              .filter(Boolean).map(column => "{{" + column + "}}");

      throw new Error("The URL uses " + tags.join(", ") + ", but " + input + " has no " +
        (missing.length > 1 ? "columns with those names" : "column with that name") + "." +
        (suggestions.length ? " Did you mean " + suggestions.join(", ") + "?" : "") +
        " Its columns are: " + columns.join(", "));

    }

    function templateColumns(template) {
      return Array.from(template.matchAll(TEMPLATE_TAG), match => match[1]);
    }

    //The first column name that appears more than once, or null
    function firstDuplicate(columns) {
      const seen = new Set();
      for (const column of columns) {
        if (seen.has(column)) {
          return column;
        }
        seen.add(column);
      }
      return null;
    }

    //Fill each {{column}} in the URL template with that column's value,
    //URL-encoded. In the query string (after the first ?), spaces become +,
    //which only means a space there; in the path, they stay %20. Unknown
    //columns become empty.
    function fillTemplate(template, row) {

      const fill = (part, useQueryEncoding) => part.replace(TEMPLATE_TAG, function(tag, column) {
        if (!(column in row)) {
          return "";
        }
        const encoded = encodeURIComponent(row[column]);
        return useQueryEncoding ? encoded.replace(/%20/g, "+") : encoded;
      });

      const q = template.indexOf("?");

      return q === -1 ?
        fill(template, false) :
        fill(template.slice(0, q), false) + fill(template.slice(q), true);

    }

  }

}
