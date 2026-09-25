// Offline test suite: runs the real CLI (and the Node module API) against a
// fake geocoding API on localhost. Run with `npm test`.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ROOT, startServer, runCli, tempDir, closedPort, writeFixture, read, rowsOf, waitFor, rawLat, rawLng, rounded
} from "./helpers.mjs";

let server, dir;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
  dir = tempDir();
});

// Run the CLI inside the test's temp dir with the fake API's URL.
function cli(args, options = {}) {
  const delay = args.includes("--delay") ? [] : ["--delay", "0"];
  return runCli(["--url", server.url(options.template), ...delay, ...args], { cwd: dir, ...options });
}

describe("geocoding", () => {

  it("geocodes every row, rounds to 6 decimals, and keeps the input columns", async () => {
    writeFixture(dir, "in.csv", 3);
    const { code } = await cli(["in.csv", "out.csv"]);
    assert.equal(code, 0);
    assert.equal(read(path.join(dir, "out.csv")), [
      "NAME,ADDRESS,lat,lng",
      ...[1, 2, 3].map(n => "Place " + n + ",addr " + n + "," + rounded(rawLat(n)) + "," + rounded(rawLng(n)))
    ].join("\n"));
    assert.deepEqual(server.requests.map(r => r.address), ["addr 1", "addr 2", "addr 3"]);
  });

  it("rounds to --precision decimal places", async () => {
    writeFixture(dir, "in.csv", 1);
    await cli(["in.csv", "out.csv", "--precision", "7"]);
    assert.deepEqual(rowsOf(path.join(dir, "out.csv")).rows[0].slice(2), [rounded(rawLat(1), 7), rounded(rawLng(1), 7)]);
  });

  it("fills a URL template that uses several columns", async () => {
    fs.writeFileSync(path.join(dir, "in.csv"), "STREET,CITY\naddr 5,Dallas\n");
    await cli(["in.csv", "out.csv"], { template: "{{STREET}},{{CITY}}" });
    assert.equal(server.requests[0].address, "addr 5,Dallas");
    assert.equal(server.requests[0].key, "TESTKEY");
  });

  it("sends addresses with apostrophes, ampersands and other symbols intact", async () => {
    const addresses = ["1234 O'Connor Rd addr 7", "A&B Plaza addr 8", "Høvik #9 addr 9", "50% + more addr 10", "St. Mary's (rear) addr 11"];
    writeFixture(dir, "in.csv", 0, addresses.map((a, i) => "P" + i + "," + a));
    const { stderr } = await cli(["in.csv", "out.csv", "--verbose"]);
    assert.deepEqual(server.requests.map(r => r.address), addresses);
    assert.deepEqual(server.requests.map(r => r.key), addresses.map(() => "TESTKEY"));
    assert.equal(stderr.match(/^SUCCESS \| /gm).length, addresses.length);
  });

  it("allows spaces inside {{ }} in the URL template", async () => {
    writeFixture(dir, "in.csv", 1);
    await cli(["in.csv", "out.csv"], { template: "{{ ADDRESS }}" });
    assert.equal(server.requests[0].address, "addr 1");
  });

  it("gives up on a request that doesn't answer within --timeout and moves on", { timeout: 20000 }, async () => {
    writeFixture(dir, "in.csv", 0, ["A,hang", "B,addr 2"]);
    const start = Date.now();
    const { code, stderr } = await cli(["in.csv", "out.csv", "--verbose", "--timeout", "300", "--retries", "0"]);
    assert.equal(code, 0);
    assert.match(stderr, /^Timed out after 0\.3 seconds \| A,hang,,$/m);
    assert.match(stderr, /^SUCCESS \| B,addr 2,/m);
    assert.ok(Date.now() - start < 10000);
  });

  it("reports network errors on the row", async () => {
    writeFixture(dir, "in.csv", 1);
    const url = "http://127.0.0.1:" + (await closedPort()) + "/?a={{ADDRESS}}";
    const { code, stderr } = await runCli(["in.csv", "out.csv", "--verbose", "--delay", "0", "--retries", "0", "--url", url], { cwd: dir });
    assert.equal(code, 0);
    assert.match(stderr, /^Network error: .*ECONNREFUSED.* \| Place 1,addr 1,,$/m);
  });

  it("detects existing latitude/longitude columns and fills them in place", async () => {
    fs.writeFileSync(path.join(dir, "in.csv"), "ADDRESS,Latitude,Longitude,NOTE\naddr 1,,,x\n");
    await cli(["in.csv", "out.csv"]);
    assert.equal(read(path.join(dir, "out.csv")),
      "ADDRESS,Latitude,Longitude,NOTE\naddr 1," + rounded(rawLat(1)) + "," + rounded(rawLng(1)) + ",x");
  });

  it("uses --lat and --lng column names", async () => {
    writeFixture(dir, "in.csv", 1);
    await cli(["in.csv", "out.csv", "--lat", "Y", "--lng", "X"]);
    assert.equal(rowsOf(path.join(dir, "out.csv")).header, "NAME,ADDRESS,Y,X");
  });

  it("skips rows that already have coordinates, unless --force", async () => {
    fs.writeFileSync(path.join(dir, "in.csv"), "ADDRESS,lat,lng\naddr 1,10,20\naddr 2,,\n");
    await cli(["in.csv", "out.csv"]);
    assert.deepEqual(server.requests.map(r => r.address), ["addr 2"]);
    assert.match(read(path.join(dir, "out.csv")), /^addr 1,10,20$/m);

    server.reset();
    await cli(["in.csv", "out2.csv", "--force"]);
    assert.deepEqual(server.requests.map(r => r.address), ["addr 1", "addr 2"]);
    assert.match(read(path.join(dir, "out2.csv")), new RegExp("^addr 1," + rounded(rawLat(1)) + ",", "m"));
  });

  it("only requests a repeated address once", async () => {
    writeFixture(dir, "in.csv", 2, ["Again,addr 1"]);
    await cli(["in.csv", "out.csv"]);
    assert.deepEqual(server.requests.map(r => r.address), ["addr 1", "addr 2"]);
    assert.match(read(path.join(dir, "out.csv")), new RegExp("^Again,addr 1," + rounded(rawLat(1)) + ",", "m"));
  });

  it("leaves failed rows blank and keeps going", async () => {
    writeFixture(dir, "in.csv", 0, ["A,nomatch", "B,garbage", "C,http500", "D,addr 4"]);
    const { code, stderr } = await cli(["in.csv", "out.csv", "--verbose", "--retries", "0"]);
    assert.equal(code, 0);
    const out = read(path.join(dir, "out.csv"));
    assert.match(out, /^A,nomatch,,$/m);
    assert.match(out, /^B,garbage,,$/m);
    assert.match(out, /^D,addr 4,32\./m);
    assert.match(stderr, /^NO MATCH \| A,nomatch/m);
    assert.match(stderr, /^Parsing error: .* \| B,garbage,,$/m);
    assert.match(stderr, /^HTTP Status 500 \| C,http500,,$/m);
    assert.match(stderr, /Rows geocoded: 1\nRows failed: 3/);
  });

  it("writes to stdout when there's no output file", async () => {
    writeFixture(dir, "in.csv", 2);
    const { code, stdout } = await cli(["in.csv"]);
    assert.equal(code, 0);
    assert.match(stdout, /^NAME,ADDRESS,lat,lng\nPlace 1,addr 1,32\./);
  });

  it("leaves no temp file behind", async () => {
    writeFixture(dir, "in.csv", 3);
    await cli(["in.csv", "out.csv", "--save-every", "1"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["in.csv", "out.csv"]);
  });

});

describe("input checks", () => {

  it("handles Excel's byte order mark, and keeps it in the output", async () => {
    fs.writeFileSync(path.join(dir, "in.csv"), "\uFEFFADDRESS,CITY\naddr 1,Dallas\n");
    const { code } = await cli(["in.csv", "out.csv"]);
    assert.equal(code, 0);
    assert.equal(server.requests[0].address, "addr 1");
    assert.equal(read(path.join(dir, "out.csv")), "\uFEFFADDRESS,CITY,lat,lng\naddr 1,Dallas," + rounded(rawLat(1)) + "," + rounded(rawLng(1)));

    server.reset();
    const resumed = await cli(["in.csv", "out.csv", "--resume"]);
    assert.match(resumed.stderr, /Resuming: 1 of 1 rows/);
    assert.equal(server.requests.length, 0);
  });

  it("refuses a URL template that uses a column the file doesn't have", async () => {
    fs.writeFileSync(path.join(dir, "in.csv"), "ADDRESS,CITY\naddr 1,Dallas\n");
    const { code, stderr } = await cli(["in.csv", "out.csv"], { template: "{{ADDRESS}},{{CITTY}},{{STATE}}" });
    assert.equal(code, 1);
    assert.match(stderr, /^The URL uses \{\{CITTY\}\}, \{\{STATE\}\}, but in\.csv has no columns with those names\. Its columns are: ADDRESS, CITY$/m);
    assert.equal(server.requests.length, 0);
    assert.deepEqual(fs.readdirSync(dir), ["in.csv"]);
  });

  it("suggests the right column name for a case mismatch", async () => {
    fs.writeFileSync(path.join(dir, "in.csv"), "ADDRESS,CITY\naddr 1,Dallas\n");
    const { stderr } = await cli(["in.csv", "out.csv"], { template: "{{address}}" });
    assert.match(stderr, /^The URL uses \{\{address\}\}, but in\.csv has no column with that name\. Did you mean \{\{ADDRESS\}\}\? Its columns are: ADDRESS, CITY$/m);
  });

});

describe("temporary and fatal errors", () => {

  it("retries a temporary error and then succeeds", { timeout: 20000 }, async () => {
    writeFixture(dir, "in.csv", 0, ["X,overlimit"]);
    const { code, stderr } = await cli(["in.csv", "out.csv", "--verbose", "--retries", "1"]);
    assert.equal(code, 0);
    assert.match(stderr, /^Retrying in 2 seconds after OVER_QUERY_LIMIT: Slow down\. \| X,overlimit$/m);
    assert.match(stderr, /^SUCCESS \| X,overlimit,32\./m);
    assert.equal(server.requests.length, 2);
  });

  it("waits --delay after failed requests too", async () => {
    writeFixture(dir, "in.csv", 0, ["A,http500", "B,http500", "C,http500"]);
    await cli(["in.csv", "out.csv", "--retries", "0", "--delay", "150"]);
    const [a, b, c] = server.requests.map(r => r.time);
    assert.ok(b - a >= 140 && c - b >= 140, "gaps: " + (b - a) + ", " + (c - b));
  });

  it("stops and saves on an API key/account error, with a hint to resume", async () => {
    writeFixture(dir, "in.csv", 1, ["X,denied", "Y,addr 3"]);
    const { code, stderr } = await cli(["in.csv", "out.csv", "--verbose"]);
    assert.doesNotMatch(stderr, /Saved progress/);
    assert.equal(code, 1);
    assert.match(stderr, /^Stopping: REQUEST_DENIED: The provided API key is invalid\.$/m);
    assert.match(stderr, /^Saved 1 of 3 rows to out\.csv\. Once the problem is fixed, rerun with --resume to continue\.$/m);
    assert.deepEqual(server.requests.map(r => r.address), ["addr 1", "denied"]);
    assert.match(read(path.join(dir, "out.csv")), /^Place 1,addr 1,32\.[\d.]+,-96\.[\d.]+\nX,denied,,\nY,addr 3,,$/m);
  });

  it("treats HTTP 401/403 as fatal", async () => {
    writeFixture(dir, "in.csv", 0, ["X,forbidden", "Y,addr 2"]);
    const { code, stderr } = await cli(["in.csv", "out.csv"]);
    assert.equal(code, 1);
    assert.match(stderr, /^Stopping: HTTP Status 403$/m);
    assert.equal(server.requests.length, 1);
  });

  it("stops after 5 rows in a row fail with temporary errors", async () => {
    writeFixture(dir, "in.csv", 7);
    const url = "http://127.0.0.1:" + (await closedPort()) + "/?a={{ADDRESS}}";
    const { code, stderr } = await runCli(["in.csv", "out.csv", "--delay", "0", "--retries", "0", "--url", url], { cwd: dir });
    assert.equal(code, 1);
    assert.match(stderr, /^Stopping: the last 5 rows all failed with temporary errors, even after retrying\./m);
    assert.match(stderr, /^Saved 5 of 7 rows to out\.csv\./m);
    assert.equal(rowsOf(path.join(dir, "out.csv")).rows.length, 7);
  });

  it("only stops for failures in a row, not scattered ones", async () => {
    writeFixture(dir, "in.csv", 0, [1, 2, 3, 4].map(i => "A" + i + ",http500 a" + i).concat(["B,addr 1"], [1, 2, 3, 4].map(i => "C" + i + ",http500 c" + i)));
    const { code } = await cli(["in.csv", "out.csv", "--retries", "0"]);
    assert.equal(code, 0);
    assert.equal(server.requests.length, 9);
  });

});

describe("--verbose", () => {

  it("prints one 'STATUS | row' line per row, progress saves, and a summary", async () => {
    writeFixture(dir, "in.csv", 3, ["X,nomatch"]);
    const { stderr } = await cli(["in.csv", "out.csv", "--verbose", "--save-every", "2", "--handler", "google"]);
    const lines = stderr.trim().split("\n");
    assert.deepEqual(lines.slice(0, 6), [
      "SUCCESS | Place 1,addr 1," + rounded(rawLat(1)) + "," + rounded(rawLng(1)),
      "SUCCESS | Place 2,addr 2," + rounded(rawLat(2)) + "," + rounded(rawLng(2)),
      "Saved progress: 2 of 4 rows",
      "SUCCESS | Place 3,addr 3," + rounded(rawLat(3)) + "," + rounded(rawLng(3)),
      "NO MATCH | X,nomatch,,",
      ""
    ]);

    assert.match(lines[6], /^Rows geocoded: 3$/);
    assert.match(lines[7], /^Rows failed: 1$/);
    assert.match(lines[8], /^Time elapsed: [\d.]+ seconds$/);
  });

});

describe("interrupting and resuming", () => {

  // Start a slow run, Ctrl-C it after a few requests, and return the result.
  async function interrupted(rows) {
    writeFixture(dir, "in.csv", rows);
    const result = await cli(["in.csv", "out.csv", "--delay", "30", "--verbose"], {
      onSpawn: async child => {
        await waitFor(() => server.requests.length >= 5);
        child.kill("SIGINT");
      }
    });
    return result;
  }

  it("saves every row on Ctrl-C, with blanks for rows not reached", async () => {
    const { code, stderr } = await interrupted(40);
    assert.equal(code, 130);
    assert.match(stderr, /Interrupted\. Saved \d+ of 40 rows to out\.csv/);
    assert.doesNotMatch(stderr, /Saved progress/);
    const { header, rows } = rowsOf(path.join(dir, "out.csv"));
    assert.equal(header, "NAME,ADDRESS,lat,lng");
    assert.equal(rows.length, 40);
    assert.ok(rows[0][2], "first row geocoded");
    assert.equal(rows[39][2], "", "last row not reached");
  });

  it("--resume finishes the run without repeating requests", async () => {
    await interrupted(40);
    const done = rowsOf(path.join(dir, "out.csv")).rows.filter(r => r[2]).length;
    server.reset();

    const { code, stderr } = await cli(["in.csv", "out.csv", "--resume"]);
    assert.equal(code, 0);
    assert.match(stderr, new RegExp("Resuming: " + done + " of 40 rows already geocoded in out.csv"));
    assert.equal(server.requests.length, 40 - done);
    assert.equal(server.requests[0].address, "addr " + (done + 1));

    await cli(["in.csv", "reference.csv"]);
    assert.equal(read(path.join(dir, "out.csv")), read(path.join(dir, "reference.csv")));
  });

  it("saves progress every --save-every rows while running", async () => {
    writeFixture(dir, "in.csv", 30);
    await cli(["in.csv", "out.csv", "--delay", "30", "--save-every", "3"], {
      onSpawn: async child => {
        await waitFor(() => server.requests.length >= 8);
        child.kill("SIGKILL"); // no chance to save on exit
      }
    });
    const done = rowsOf(path.join(dir, "out.csv")).rows.filter(r => r[2]).length;
    assert.ok(done >= 6 && done % 3 === 0, "expected a multiple of 3 rows saved, got " + done);
  });

  it("--resume with no output file yet starts from the beginning", async () => {
    writeFixture(dir, "in.csv", 2);
    const { code, stderr } = await cli(["in.csv", "out.csv", "--resume"]);
    assert.equal(code, 0);
    assert.match(stderr, /Nothing to resume: out\.csv doesn't exist yet/);
    assert.equal(server.requests.length, 2);
  });

  it("--resume refuses an output file from a different input", async () => {
    writeFixture(dir, "in.csv", 3);
    await cli(["in.csv", "out.csv"]);
    const before = read(path.join(dir, "out.csv"));

    fs.writeFileSync(path.join(dir, "edited.csv"), read(path.join(dir, "in.csv")).replace("Place 2", "Place Two"));
    let result = await cli(["edited.csv", "out.csv", "--resume"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Can't resume: row 2 of out\.csv doesn't match edited\.csv \(column "NAME"\)/);

    writeFixture(dir, "short.csv", 2);
    result = await cli(["short.csv", "out.csv", "--resume"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Can't resume: out\.csv has 3 rows but short\.csv has 2/);

    assert.equal(read(path.join(dir, "out.csv")), before);
  });

});

describe("command-line checks", () => {

  it("refuses to replace an existing output file without --overwrite or --resume", async () => {
    writeFixture(dir, "in.csv", 1);
    fs.writeFileSync(path.join(dir, "out.csv"), "keep me");
    const result = await cli(["in.csv", "out.csv"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /out\.csv already exists\. Add --resume to continue that run, or --overwrite to replace it\./);
    assert.equal(read(path.join(dir, "out.csv")), "keep me");
    assert.equal(server.requests.length, 0);

    assert.equal((await cli(["in.csv", "out.csv", "--overwrite"])).code, 0);
    assert.match(read(path.join(dir, "out.csv")), /^NAME,ADDRESS,lat,lng/);
  });

  const refusals = [
    [["in.csv", "./in.csv"], /The output file can't be the same as the input file\./],
    [["in.csv", "--resume"], /--resume requires an output file\./],
    [["in.csv", "out.csv", "--resume", "--force"], /--resume and --force can't be used together/],
    [["in.csv", "out.csv", "--resume", "--overwrite"], /--resume and --overwrite can't be used together\./],
    [["in.csv", "out.csv", "--delay", "abc"], /--delay requires a numeric value in milliseconds\./],
    [["in.csv", "out.csv", "--precision", "x"], /--precision requires a whole number of decimal places\./],
    [["in.csv", "out.csv", "--save-every", "x"], /--save-every requires a whole number of rows\./],
    [["in.csv", "out.csv", "--timeout", "0"], /--timeout requires a whole number of milliseconds, greater than 0\./],
    [["in.csv", "out.csv", "--retries", "x"], /--retries requires a whole number\./]
  ];

  for (const [args, message] of refusals) {
    it("refuses: " + args.slice(1).join(" "), async () => {
      writeFixture(dir, "in.csv", 1);
      const result = await cli(args);
      assert.equal(result.code, 1);
      assert.match(result.stderr, message);
      assert.equal(server.requests.length, 0);
    });
  }

  it("rejects unknown options instead of ignoring them", async () => {
    writeFixture(dir, "in.csv", 1);
    const result = await cli(["in.csv", "out.csv", "--verbos"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown option '--verbos'/);
    assert.equal(server.requests.length, 0);
  });

  it("reports a missing input file without a stack trace", async () => {
    const result = await cli(["missing.csv", "out.csv"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ENOENT: no such file or directory, open 'missing\.csv'/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });

  it("requires --url", async () => {
    writeFixture(dir, "in.csv", 1);
    const result = await runCli(["in.csv", "out.csv"], { cwd: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /url/);
  });

  it("shows help when there's no input file", async () => {
    const result = await runCli(["--url", "x"], { cwd: dir });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /--resume/);
  });

});

describe("Node module API", () => {

  let geocode;

  before(async () => {
    geocode = (await import(path.join(ROOT, "index.js"))).default;
  });

  function run(input, options) {
    return new Promise(resolve => {
      const rows = [];
      geocode(input, { delay: 0, url: server.url(), ...options })
        .on("row", (err, row) => rows.push({ err, row: { ...row } }))
        .on("complete", summary => resolve({ rows, summary }));
    });
  }

  it("emits a row event per row and a complete summary", async () => {
    const input = writeFixture(dir, "in.csv", 2, ["X,nomatch"]);
    const { rows, summary } = await run(input, { test: true });
    assert.deepEqual(rows.map(r => r.err), [null, null, "NO MATCH"]);
    assert.equal(rows[0].row.lat, Number(rounded(rawLat(1))));
    assert.equal(summary.successes, 2);
    assert.equal(summary.failures, 1);
    assert.ok(summary.time >= 0);
    assert.deepEqual(fs.readdirSync(dir), ["in.csv"], "test mode writes nothing");
  });

  it("accepts a custom handler function", async () => {
    const input = writeFixture(dir, "in.csv", 2);
    const handler = body => body.includes('"lat":32.0001') ? { lat: 1.5, lng: 2.5 } : "CUSTOM ERROR";
    const { rows, summary } = await run(input, { test: true, handler });
    assert.deepEqual(rows.map(r => [r.err, r.row.lat]), [[null, 1.5], ["CUSTOM ERROR", ""]]);
    assert.equal(summary.successes, 1);
  });

  it("retries with the given waits and emits a retry event each time", async () => {
    const input = writeFixture(dir, "in.csv", 0, ["X,flaky"]);
    const retries = [];
    const { rows } = await new Promise(resolve => {
      const rows = [];
      geocode(input, { delay: 0, url: server.url(), test: true, retryWaits: [10, 20] })
        .on("retry", (retry, row) => retries.push(retry))
        .on("row", (err, row) => rows.push({ err, row: { ...row } }))
        .on("complete", () => resolve({ rows }));
    });
    assert.deepEqual(retries.map(r => [r.error, r.wait, r.retry, r.retries]), [["HTTP Status 503", 10, 1, 3], ["HTTP Status 503", 20, 2, 3]]);
    assert.equal(rows[0].err, null);
    assert.equal(server.requests.length, 3);
  });

  it("gives up after `retries` and reports the last error", async () => {
    const input = writeFixture(dir, "in.csv", 0, ["X,flaky"]);
    const { rows } = await run(input, { test: true, retries: 1, retryWaits: [10] });
    assert.equal(rows[0].err, "HTTP Status 503");
    assert.equal(rows[0].row.lat, "");
    assert.equal(server.requests.length, 2);
  });

  it("emits an error for a URL template column that doesn't exist", async () => {
    const input = writeFixture(dir, "in.csv", 1);
    const err = await new Promise(resolve => geocode(input, { url: server.url("{{NOPE}}"), test: true }).on("error", resolve));
    assert.match(err.message, /The URL uses \{\{NOPE\}\}/);
    assert.equal(server.requests.length, 0);
  });

  it("throws right away without a url or with an unknown handler", () => {
    assert.throws(() => geocode("in.csv", { test: true }), /url/i);
    assert.throws(() => geocode("in.csv", { test: true, url: "x", handler: "nope" }), /invalid value/i);
  });

});
