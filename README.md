csvgeocode
==========

For when you have a CSV with addresses and you want a lat/lng for every row.  Bulk geocode the addresses in a CSV with a few lines of code.

The defaults are configured for [Google's geocoder](https://developers.google.com/maps/documentation/geocoding/) but it can be configured to work with any other similar geocoding service.  There are built-in response handlers for [Google](https://developers.google.com/maps/documentation/geocoding/), [Mapbox](https://www.mapbox.com/developers/api/geocoding/), [OSM Nominatim](http://nominatim.openstreetmap.org/), and [Texas A & M's](http://geoservices.tamu.edu/Services/Geocode/WebService/) geocoders (details below). Only the Google handler is maintained and in regular use; the others are unchanged from the original project and haven't been tested against their live services in years (see [`--handler`](#--handler-handler)).

Make sure that you use this in compliance with the relevant API's terms of service.

## Basic command line usage

Requires Node 20 or newer. This is the [Element-Creative fork](https://github.com/Element-Creative/csvgeocode); the `csvgeocode` package on npm is the original 2.x version without these changes. Install from GitHub:

```
git clone https://github.com/Element-Creative/csvgeocode.git
cd csvgeocode
npm ci
ln -s "$PWD/bin/csvgeocode" /usr/local/bin/csvgeocode
```

The `ln -s` puts it on your `PATH` for every Node version (it runs with whichever `node` is active); it may need `sudo`.

Use it:

```
$ csvgeocode path/to/input.csv path/to/output.csv --url "https://maps.googleapis.com/maps/api/geocode/json?address={{MY_ADDRESS_COLUMN_NAME}}&key=MY_API_KEY"
```

If you don't specify an output file, the output will stream to stdout instead, so you can stream the result as an HTTP response or do something like:

```
$ csvgeocode path/to/input.csv [options] | grep "greppin for somethin"
```

## Options

You can add extra options when running `csvgeocode`.  For example:

```
$ csvgeocode input.csv output.csv --url "http://someurl.com/" --lat CALL_MY_LATITUDE_COLUMN_THIS_SPECIAL_NAME --delay 1000 --verbose
```

The only required option is `url`.  All others are optional.

#### `--url [url]` (REQUIRED)

A URL template with column names in double curly braces, like `{{address}}`. Each one is replaced with that column's value for the row, URL-encoded (apostrophes, `&`, `#` and so on are safe). Spaces become `+` in the query string (after the first `?`), since that's the only place `+` means a space; in the path, they're `%20` instead. For example:

```
http://api.tiles.mapbox.com/v4/geocode/mapbox.places/{{address}}.json?access_token=MY_API_KEY

https://maps.googleapis.com/maps/api/geocode/json?address={{address}}&key=MY_API_KEY

http://geoservices.tamu.edu/Services/Geocode/WebService/GeocoderWebServiceHttpNonParsed_V04_01.aspx?apiKey=MY_API_KEY&version=4.01&streetAddress={{address}}&city={{city}}&state={{state}}
```

Before making any requests, csvgeocode checks that every `{{column}}` in the URL is a column in your CSV (names are case-sensitive), so a typo can't quietly geocode partial addresses. It also refuses to run if your CSV has two columns with the same name, since only one of them could ever be kept. The input has to be UTF-8 (see [Text encoding](#text-encoding) for what happens if it isn't, and `--encoding`).

If several rows end up with the same URL (the same address), it's only requested once, and the other rows reuse the result, whether that was a match or a permanent failure like `NO MATCH`. Temporary failures (e.g. a timeout) aren't reused, so a later row with the same address tries again.

If every `{{column}}` the URL template uses is blank for a row, csvgeocode doesn't bother making a request for it: that row's status is `NO ADDRESS` (see `--status-columns`) and it's counted as a failure, the same as any other row that didn't get a lat/lng.

If your addresses are broken up into multiple columns (e.g. a street_address column, a city column, and a state column), you can use them all together in a URL template:

```
https://maps.googleapis.com/maps/api/geocode/json?address={{street_address}},{{city}},{{state}}&key=MY_API_KEY
```

#### `--handler [handler]`

What handler function to process the API response with.  Current built-in handlers are `"google"`, `"mapbox"`, `"osm"`, and `"tamu"`. Contributions of handlers for other geocoders are welcome! You can define a custom handler when using this as a Node module (see below).

**Only `google` is maintained.** `mapbox`, `osm` and `tamu` are unchanged from the original project (last updated in 2016) and haven't been tested against their live services since, so they may not work as-is. Known concerns:

* **Mapbox:** the example URL below uses Mapbox's old v4 geocoding endpoint; Mapbox has since moved to newer API versions, whose responses may not match what the handler expects.
* **OSM Nominatim:** its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) requires an identifying User-Agent and at most 1 request per second. csvgeocode identifies itself (`csvgeocode/<version> (+https://github.com/Element-Creative/csvgeocode)`), but you still need `--delay 1000`.
* **Texas A&M:** the example URL uses plain `http`, and the API version in it may be outdated.

If you rely on one of these, test it on a few rows first.

Examples:
```
$ csvgeocode input.csv --url "http://api.tiles.mapbox.com/v4/geocode/mapbox.places/{{MY_ADDRESS_COLUMN_NAME}}.json?access_token=123ABC" --handler mapbox

$ csvgeocode input.csv --url "http://geoservices.tamu.edu/Services/Geocode/WebService/GeocoderWebServiceHttpNonParsed_V04_01.aspx?version=4.01&streetAddress={{ADDR}}&city={{CITY}}&state={{STATE}}&apiKey=123ABC" --handler tamu
```

**Default:** `"google"`

#### `--encoding [name]`

The input file's text encoding, if it isn't UTF-8. csvgeocode never guesses: a file that isn't valid UTF-8 stops with an error before any request is made, and this option is how you tell it what the file really is. The names you're most likely to need:

* `windows-1252`: plain "CSV" from Excel on Windows, and most other Windows programs (also called ANSI or CP1252; `latin1` and `iso-8859-1` are treated as the same thing).
* `macintosh`: plain "CSV" from Excel on a Mac (Mac Roman).
* `utf-16le`: exports from SQL Server, older PowerShell and some other Windows tools.

Any other [WHATWG encoding name](https://encoding.spec.whatwg.org/#names-and-labels) works too. The output is always UTF-8, whatever the input was. See [Text encoding](#text-encoding) for the details and the cases this doesn't cover.

**Default:** `utf-8`

#### `--lat [latitude column name]`

The name of the column that should contain the resulting latitude.  If this column doesn't exist in the input CSV, it will be created in the output.

**Default:** Tries to automatically detect if there is a relevant existing column name in the input CSV, like `lat` or `latitude`.  If none is found, it will use `lat`.

#### `--lng [longitude column name]`

The name of the column that should contain the resulting longitude.  If this column doesn't exist in the input CSV, it will be created in the output.

**Default:** Tries to automatically detect if there is a relevant existing column name in the input CSV, like `lng` or `longitude`.  If none is found, it will use `lng`.

#### `--delay [milliseconds]`

The number of milliseconds to wait between geocoding calls.  Setting this to 0 is probably a bad idea because most geocoders limit how fast you can make requests.

**Default:** 250

#### `--timeout [milliseconds]`

How long to wait for each API response. If there's no answer in time, that row fails with `Timed out after N seconds` and csvgeocode moves on, instead of hanging (e.g. after your laptop sleeps or switches networks).

**Default:** 30000

#### `--retries [number]`

How many times to retry a request that failed with a temporary problem: a network error, a timeout, a rate limit (HTTP 429 or Google's `OVER_QUERY_LIMIT`), a server error (HTTP 5xx or Google's `UNKNOWN_ERROR`), or a response that isn't what the API normally sends (like a Wi-Fi login page). It waits 2 seconds, then 10, then 30 between tries. Set to 0 to not retry.

Some problems stop the run instead, after saving progress, because every remaining row would fail the same way:

* an API key or account problem: HTTP 401 or 403, or Google's `REQUEST_DENIED` or `OVER_DAILY_LIMIT`
* 5 rows in a row that still failed with temporary problems after retrying (e.g. the network is down)

Fix the problem, then rerun with `--resume` to continue.

**Default:** 3

#### `--force`

By default, if a lat/lng is already found in an input row, that will be kept.  If you want to re-geocode every row no matter what and replace any lat/lngs that already exist, add `--force`.  This means you'll hit API limits faster and the process will take longer.

`--force` is about the rows in your *input*, not the output file: to replace an existing output file, use `--overwrite` (the two can be combined). A `--force` run can't be continued with `--resume`, since there's no way to tell which rows of the saved file were re-geocoded; if one is interrupted, start it over with `--overwrite`.

#### `--overwrite`

If the output file already exists, csvgeocode refuses to start so a previous run isn't lost by accident. Add `--overwrite` to replace it, or `--resume` to continue it. The output file also can't be the same as the input file.

#### `--precision [decimal places]`

Round the resulting lat/lng to this many decimal places. This removes floating-point noise like `-96.68371259999999`.

**Default:** 6

#### `--status-columns`

Add three columns to the output, after `lat` and `lng`:

* `geocode_status`: `SUCCESS`, or why the row failed, e.g. `NO MATCH` or `NO ADDRESS` (every `{{column}}` the URL uses was blank, so nothing was requested). Failures that might work if tried again later start with `TEMPORARY ERROR:`, e.g. `TEMPORARY ERROR: Timed out after 30 seconds`. It's blank for rows that already had a lat/lng in the input.
* `geocode_location_type`: how precise the match is (Google only). `ROOFTOP` is an exact address; `RANGE_INTERPOLATED` is estimated between two points on the street; `GEOMETRIC_CENTER` is the center of something like a street or area; `APPROXIMATE` is only approximate, e.g. a ZIP code or city center.
* `geocode_partial_match`: `true` if Google couldn't match the whole address and returned its best guess (Google only). Worth checking by hand, along with anything that isn't `ROOFTOP`.

With `--resume`, rows whose status is a permanent failure are skipped instead of tried again (and paid for). Rows with a `TEMPORARY ERROR` are tried again.

#### `--save-every [rows]`

When writing to an output file, save progress to it every this many geocoded rows. Pressing Ctrl-C also saves before exiting. Each save is a complete copy of the input: rows done so far have a lat/lng, and the rest have blanks. Set to 0 to only write at the end.

**Default:** 100

#### `--resume`

Continue an interrupted run. Rerun the same command with `--resume` added: rows that already have a lat/lng in the output file are kept and skipped, and geocoding picks up from there. Rows that failed before are tried again, unless the run used `--status-columns`: then only rows with a `TEMPORARY ERROR` are, and permanent failures like `NO MATCH` are skipped. (A run that used `--status-columns` keeps them when resumed, even if you leave the flag off.)

```
$ csvgeocode input.csv output.csv --url "MY_API_URL"            # interrupted partway
$ csvgeocode input.csv output.csv --url "MY_API_URL" --resume   # picks up where it stopped
```

The output file has to come from the same input: if the row count or any input column differs, csvgeocode stops with an error instead of mixing up rows. If the output file doesn't exist yet, `--resume` just starts from the beginning. Can't be combined with `--force` or `--overwrite`.

#### `--verbose`

See extra output while csvgeocode is running. (The summary at the end, on stderr, is printed on every run, with or without `--verbose`.)

Each row gets one line: its status, then the row as it's written to the output. `SUCCESS` is an exact match; a less precise one says how, e.g. `SUCCESS (APPROXIMATE, partial match)` (Google only; see `--status-columns`). Failures that might work on another try start with `TEMPORARY ERROR:`.

```
$ csvgeocode input.csv --url "MY_API_URL" --verbose
SUCCESS | 160 Varick St,New York,NY
SUCCESS (APPROXIMATE, partial match) | 1600 Pennsylvania Ave,Washington,DC
NO MATCH | 123 Fictional St,Noncity,XY

Rows geocoded: 2
Rows failed: 1
Time elapsed: 1.8 seconds
```

If a row already had a lat/lng (in the input, or from a resumed run) it doesn't count as "geocoded", and a `Rows skipped (already had a lat/lng, or done in a previous run): N` line is added between `Rows failed` and `Time elapsed` (only when there is at least one).

#### Progress

Without `--verbose`, if you're writing to an output file (not stdout) and stderr is an interactive terminal, csvgeocode shows a single updating line while it runs, like `Processed 1,234 of 50,000 rows` (every row handled so far, whether it was geocoded, failed, or skipped). It's skipped when stderr isn't a terminal (e.g. piped to a log file), so it never shows up in scripted or logged runs.

#### `--version`

Print the installed version number and exit.

## Using as a Node module

Install from GitHub with `npm`:

```
npm install github:Element-Creative/csvgeocode
```

It's an ES module, so use `import`:

```js
import csvgeocode from "csvgeocode";

//stream to stdout
csvgeocode("path/to/input.csv",{
    url: "MY_API_URL"
  });

//write to a file
csvgeocode("path/to/input.csv","path/to/output.csv",{
    url: "MY_API_URL"
  });
```

You can add all the same options in a script, except for `verbose`, which is CLI-only:

| Module option     | CLI flag            | Default |
| ------------------ | -------------------- | ------- |
| `url`               | `--url`               | (required) |
| `handler`           | `--handler`           | `"google"` |
| `encoding`          | `--encoding`          | `"utf-8"` |
| `lat`               | `--lat`               | automatic detection |
| `lng`               | `--lng`               | automatic detection |
| `delay`             | `--delay`             | `250` |
| `timeout`           | `--timeout`           | `30000` |
| `retries`           | `--retries`           | `3` |
| `retryWaits`        | *(not exposed on the CLI)* | `[2000, 10000, 30000]` (ms to wait before each retry; the last one repeats if there are more retries than waits) |
| `maxFailedInARow`   | *(not exposed on the CLI)* | `5` (stop the run after this many consecutive temporary failures; `0` disables) |
| `force`             | `--force`             | `false` |
| `resume`            | `--resume`            | `false` |
| `precision`         | `--precision`         | `6` |
| `statusColumns`     | `--status-columns`    | `false` |
| `saveEvery`         | `--save-every`        | `100` |

For example:

```js
const options = {
  "url": "MY_API_URL",
  "lat": "MY_SPECIAL_LATITUDE_COLUMN_NAME",
  "lng": "MY_SPECIAL_LONGITUDE_COLUMN_NAME",
  "delay": 1000,
  "force": true,
  "handler": "mapbox"
};

//stream to stdout
csvgeocode("input.csv",options);

//write to a file
csvgeocode("input.csv","output.csv",options);
```

`csvgeocode` runs asynchronously, but you can listen for events. The main ones are `row` and `complete`; there's also `error` (a problem that stops the run, like an unreadable input file or a bad API key: if nothing listens for it, it's thrown), `retry` (before each retry of a failed request), `progress` (each time progress is saved) and `resume` (when `resume: true` picks up a previous run).

`row` is triggered when each row is processed. It passes a string error message if geocoding the row failed, the row itself, and details: `{ locationType, partialMatch }` for a match (when the handler provides them), or `{ temporary: true }` for a failure that might work on another try. Rows that already had a lat/lng get no details.

```js
csvgeocode("input.csv",options)
  .on("row",function(err,row){
    if (err) {
      console.warn(err);
    }
    /*
      `row` is an object like:
      {
        first: "John",
        last: "Keefe",
        address: "160 Varick St, New York NY",
        employer: "WNYC",
        lat: 40.7267926,
        lng: -74.00537369999999
      }
    */
  });
```

`complete` is triggered when all geocoding is done.  It passes a `summary` object:

* `successes`: rows that have a valid lat/lng at the end of the run, whether that's because they were geocoded now, they already had one in the input, or a resumed run had already done them.
* `failures`: rows that don't (`results.length - successes`).
* `geocoded`: rows actually geocoded during *this* run — `successes` minus the ones that were skipped.
* `skipped`: rows that needed no geocoding at all: they already had a lat/lng in the input, or were already done in a resumed run's output (whether that was a success or a permanent failure like `NO MATCH`).
* `time`: milliseconds elapsed.

```js
csvgeocode("input.csv",options)
  .on("complete",function(summary){
    /*
      `summary` is an object like:
      {
        failures: 1, //1 row failed
        successes: 49, //49 rows have a lat/lng now
        geocoded: 40, //40 of those were geocoded this run
        skipped: 9, //9 rows needed no geocoding (already had a lat/lng, or were resumed)
        time: 8700 //it took 8.7 seconds
      }
    */
  });
```

## Using a custom geocoder

You can use any basic geocoding service from within a Node script by supplying a custom handler.

The easiest way to see what a handler should look like is to look at [handlers.js](./src/handlers.js).

The handler function is passed the body of an API response and should either return a string error message or an object with `lat` and `lng` properties. A successful result can also include `locationType` (a string) and `partialMatch` (`true` or `false`), which fill in the `--status-columns` columns. It can also return `{ retry: "message" }` for a temporary problem that's worth retrying, or `{ fatal: "message" }` for one that should stop the whole run (like an invalid API key). If it throws, that's treated as a temporary problem.

```js

csvgeocode("input.csv",{
  url: "MY_API_URL",
  handler: customHandler
});

function customHandler(body) {
  //success, return a lat/lng
  if (body.result) {
    return {
      lat: body.result.lat,
      lng: body.result.lng
    };
  }

  //failure, return a string
  return "NO MATCH";
}
```

## Text encoding

csvgeocode reads the input as UTF-8 unless you say otherwise with `--encoding`, and always writes UTF-8. It never guesses an encoding, because a wrong guess silently turns every accented character into a different accented character, and nobody notices until the client opens the file. So the rule is: if a file isn't valid UTF-8, csvgeocode stops before spending anything on API calls and tells you, and you either re-save the file as UTF-8 or pass `--encoding`.

Things that work as-is:

* UTF-8 with or without a byte order mark (BOM). Excel's "CSV UTF-8" format, Google Sheets, Numbers, LibreOffice, Airtable, HubSpot, Salesforce and most modern exports all produce this. If the input had a BOM, the output gets one too; otherwise it doesn't.
* Plain ASCII, which is valid UTF-8 (and valid everything else).

Known cases that need `--encoding`:

* **Excel's plain "CSV (Comma delimited)" format** writes the system's legacy encoding, not UTF-8: `windows-1252` on Windows and `macintosh` on a Mac. Any accented name or address makes the file invalid UTF-8. The easy fix is to re-save it as "CSV UTF-8"; otherwise pass the matching `--encoding`.
* **UTF-16 files** from SQL Server, older PowerShell versions and some Windows tools. These get their own error message, since they aren't a UTF-8 problem; pass `--encoding utf-16le` (or `utf-16be`).
* **Older CRM, ERP and mailing-list exports**, which are usually `windows-1252` or one of the `iso-8859-*` family.

Known cases csvgeocode can't detect or fix:

* **Text that was already mangled before it got to csvgeocode**, e.g. `CafÃ©` for `Café`, which happens when a UTF-8 file is opened as Windows-1252 and re-saved. That's valid UTF-8, so it's passed through unchanged and sent to the geocoder as-is. Fix the file upstream.
* **A file with more than one encoding**, e.g. rows pasted together from different sources. It's refused as invalid UTF-8 (or, with `--encoding`, decoded wrongly in places). Convert the pieces separately.
* **An input with only ASCII characters in the wrong encoding.** Nothing to detect, and nothing goes wrong.
* **Converting to anything but UTF-8.** If whatever reads the output needs a legacy encoding, convert it afterwards with a tool like `iconv -f UTF-8 -t CP1252 out.csv > out_cp1252.csv` (on a Mac or Linux) or PowerShell's `Get-Content ... | Set-Content -Encoding ...`. The same `iconv` in the other direction is the general escape hatch for any input `--encoding` doesn't cover.

Known cases on the *output* side, which are about the program opening the file rather than csvgeocode:

* **Excel on Windows opens a UTF-8 file without a BOM as ANSI**, so accented characters look wrong. If your input didn't have a BOM (a plain Windows-1252 Excel file never does), either use Excel's Data → From Text/CSV import and pick UTF-8, or add a BOM after the fact. The content is correct; it's Excel's default that's wrong.
* **The opposite problem for a BOM**: if the input had one, the output has one too, and some programs (Python's `csv` module, PostgreSQL's `COPY`, some import tools) then see a first column named `\ufeffNAME`. Strip it (`sed '1s/^\xEF\xBB\xBF//'`) or tell that tool the file is `utf-8-sig`.
* **Accented characters written two different ways.** Text from Macs sometimes stores `é` as `e` plus a combining accent (NFD) rather than a single character (NFC). Both are valid UTF-8 and csvgeocode keeps whichever it got; the geocoders handle both, but a spreadsheet lookup or database join between the two forms won't match. Normalize upstream if that matters.

## Contributing/tests

```
npm test
```

The tests run offline: they start a fake geocoding API on localhost and run the real `csvgeocode` command (and the Node module) against it, so no API keys or network access are needed.

## Some Alternatives

* [file-geocoder](https://www.npmjs.com/package/file-geocoder)
* [Texas A & M Batch Geocoder](http://geoservices.tamu.edu/Services/Geocode/BatchProcess/)
* [batchgeo](https://en.batchgeo.com/)

## Credits/License

By [Noah Veltman](https://twitter.com/veltman)

Available under the MIT license.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions.

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
