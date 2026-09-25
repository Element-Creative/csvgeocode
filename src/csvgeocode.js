import fs from "node:fs";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import * as misc from "./misc.js";
import * as csv from "./csv.js";
import defaults from "./defaults.js";
import handlers from "./handlers.js";

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

  return new Geocoder().run(input, output || null, options);

}

//A {{column}} tag in the URL template
const TEMPLATE_TAG = /\{\{\s*([^{}]+?)\s*\}\}/g;

//An error that ends the whole run (after saving progress)
class StopError extends Error {}

class Geocoder extends EventEmitter {

  run(input, output, options) {

    const cache = {}, //Cached results by address
          resumed = new Set(), //Rows whose lat/lng came from a previous run's output
          time = Date.now(),
          _this = this;

    let rows = null, //All parsed rows, filled in as they're geocoded
        done = 0, //Number of rows processed so far
        unsaved = 0, //Number of rows geocoded since the last save
        failedInARow = 0; //Consecutive rows that failed with temporary errors

    this.options = options;
    this.saveProgress = saveProgress;

    start().catch(err => _this.emit("error", err));

    return this;

    async function start() {

      const parsed = await csv.read(input);
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

      if (previous) {
        resumeFrom(previous);
        _this.emit("resume", { found: true, done: resumed.size, total: parsed.length });
      }

      try {

        for (const row of rows) {
          const skipped = needsNoGeocoding(row);
          await codeRow(row);
          done++;
          if (!skipped && options.saveEvery > 0 && ++unsaved >= options.saveEvery && done < rows.length) {
            saveProgress();
          }
          //Every row lately failed with a temporary error: the network or
          //the API is probably down, so stop rather than fail every row
          if (options.maxFailedInARow > 0 && failedInARow >= options.maxFailedInARow) {
            throw new StopError("Stopping: the last " + failedInARow + " rows all failed with temporary errors, even after retrying. Check your network connection and the API's status.");
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

    async function codeRow(row) {

      const url = fillTemplate(options.url, row);

      //Doesn't need geocoding
      if (needsNoGeocoding(row)) {
        //Rows finished in a previous run aren't reported again
        if (!resumed.has(row)) {
          _this.emit("row", null, row);
        }
        return;
      }

      //Address is cached from a previous result
      if (cache[url]) {

        row[options.lat] = cache[url].lat;
        row[options.lng] = cache[url].lng;

        _this.emit("row", null, row);
        return;

      }

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

      if (outcome.result) {

        row[options.lat] = outcome.result.lat;
        row[options.lng] = outcome.result.lng;

        //Cache the result
        cache[url] = outcome.result;
        failedInARow = 0;
        _this.emit("row", null, row);

      } else {

        row[options.lat] = "";
        row[options.lng] = "";

        failedInARow = outcome.retry ? failedInARow + 1 : 0;
        _this.emit("row", outcome.message, row);

      }

      await sleep(options.delay);

    }

    //Request one URL. Resolves to { result: {lat, lng} } on success, or
    //{ message } for a failed row, plus retry: true if it's worth trying
    //again or fatal: true if the whole run should stop.
    async function attempt(url) {

      let response, body, result;

      try {
        response = await fetch(url, { signal: AbortSignal.timeout(options.timeout) });
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

      //Success
      if (result && "lat" in result && "lng" in result) {

        //Round off floating-point noise (e.g. -96.68371259999999)
        if (options.precision !== null && options.precision !== false) {
          result = {
            lat: misc.round(result.lat, options.precision),
            lng: misc.round(result.lng, options.precision)
          };
        }

        return { result: { lat: result.lat, lng: result.lng } };

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

      const numSuccesses = results.filter(successful).length,
            numFailures = results.length - numSuccesses,
            summarize = function() {
              _this.emit("complete", {
                failures: numFailures,
                successes: numSuccesses,
                time: Date.now() - time
              });
            };

      if (options.test) {
        summarize();
      } else if (typeof output === "string") {
        await csv.write(output, results);
        summarize();
      } else {
        process.stdout.write(csv.stringify(results), summarize);
      }

    }

    function needsNoGeocoding(row) {
      return !options.force && misc.isNumeric(row[options.lat]) && misc.isNumeric(row[options.lng]);
    }

    //Copy lat/lngs from a previous run's output onto the input rows, after
    //checking that the output really came from this same input
    function resumeFrom(previous) {

      if (previous.length !== rows.length) {
        throw new Error("Can't resume: " + output + " has " + previous.length + " rows but " + input + " has " + rows.length + ".");
      }

      rows.forEach(function(row, i) {

        for (const key in row) {
          if (key !== options.lat && key !== options.lng && row[key] !== previous[i][key]) {
            throw new Error("Can't resume: row " + (i + 1) + " of " + output + " doesn't match " + input + " (column \"" + key + "\").");
          }
        }

        if (misc.isNumeric(previous[i][options.lat]) && misc.isNumeric(previous[i][options.lng])) {
          row[options.lat] = previous[i][options.lat];
          row[options.lng] = previous[i][options.lng];
          resumed.add(row);
        }

      });

    }

    //Write every row so far (geocoded ones plus the untouched remainder) to the
    //output file, so an interrupted run can resume by using it as the input.
    //quiet: skip the "progress" event, when the caller reports the save itself.
    function saveProgress({ quiet = false } = {}) {

      if (!rows || typeof output !== "string" || options.test) {
        return null;
      }

      csv.writeSync(output, rows);
      unsaved = 0;

      const progress = { done: done, total: rows.length };
      if (!quiet) {
        _this.emit("progress", progress);
      }
      return progress;

    }

    function successful(row) {
      return misc.isNumeric(row[options.lat]) && misc.isNumeric(row[options.lng]);
    }

    //Make sure every {{column}} in the URL template is a real column, so a
    //typo doesn't quietly geocode (and pay for) partial addresses
    function checkTemplate(columns) {

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

    //Fill each {{column}} in the URL template with that column's value,
    //URL-encoded (spaces as +). Unknown columns become empty.
    function fillTemplate(template, row) {
      return template.replace(TEMPLATE_TAG, function(tag, column) {
        return column in row ? encodeURIComponent(row[column]).replace(/%20/g, "+") : "";
      });
    }

  }

}
