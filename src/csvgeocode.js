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

class Geocoder extends EventEmitter {

  run(input, output, options) {

    const cache = {}, //Cached results by address
          resumed = new Set(), //Rows whose lat/lng came from a previous run's output
          time = Date.now(),
          _this = this;

    let rows = null, //All parsed rows, filled in as they're geocoded
        done = 0, //Number of rows processed so far
        unsaved = 0; //Number of rows geocoded since the last save

    this.options = options;
    this.saveProgress = saveProgress;

    start().catch(err => _this.emit("error", err));

    return this;

    async function start() {

      const parsed = await csv.read(input);
      let previous = null;

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

      for (const row of rows) {
        const skipped = needsNoGeocoding(row);
        await codeRow(row);
        done++;
        if (!skipped && options.saveEvery > 0 && ++unsaved >= options.saveEvery && done < rows.length) {
          saveProgress();
        }
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

      let response, body;

      try {
        response = await fetch(url, { signal: AbortSignal.timeout(options.timeout) });
        body = await response.text();
      } catch (e) {
        _this.emit("row", describeError(e), row);
        return;
      }

      if (response.status !== 200) {
        _this.emit("row", "HTTP Status " + response.status, row);
        return;
      }

      handleResponse(body, row, url);
      await sleep(options.delay);

    }

    function handleResponse(body, row, url) {

      let result;

      try {
        result = options.handler(body);
      } catch (e) {
        result = "Parsing error: " + e.toString();
      }

      //Error code
      if (typeof result === "string") {

        row[options.lat] = "";
        row[options.lng] = "";

        _this.emit("row", result, row);

      //Success
      } else if (result && "lat" in result && "lng" in result) {

        //Round off floating-point noise (e.g. -96.68371259999999)
        if (options.precision !== null && options.precision !== false) {
          result = {
            lat: misc.round(result.lat, options.precision),
            lng: misc.round(result.lng, options.precision)
          };
        }

        row[options.lat] = result.lat;
        row[options.lng] = result.lng;

        //Cache the result
        cache[url] = result;
        _this.emit("row", null, row);

      //Unknown extraction error
      } else {

        _this.emit("row", "Invalid return value from handler for response body: " + body, row);

      }

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
    //output file, so an interrupted run can resume by using it as the input
    function saveProgress() {

      if (!rows || typeof output !== "string" || options.test) {
        return null;
      }

      csv.writeSync(output, rows);
      unsaved = 0;

      const progress = { done: done, total: rows.length };
      _this.emit("progress", progress);
      return progress;

    }

    function successful(row) {
      return misc.isNumeric(row[options.lat]) && misc.isNumeric(row[options.lng]);
    }

    //Fill each {{column}} in the URL template with that column's value,
    //URL-encoded (spaces as +). Unknown columns become empty.
    function fillTemplate(template, row) {
      return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function(tag, column) {
        return column in row ? encodeURIComponent(row[column]).replace(/%20/g, "+") : "";
      });
    }

  }

}
