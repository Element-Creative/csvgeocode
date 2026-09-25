// Offline test suite: runs the real CLI (and the Node module API) against a
// fake geocoding API on localhost. Run with `npm test`.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ROOT, startServer, runCli, tempDir, writeFixture, read, rowsOf, waitFor, rawLat, rawLng, rounded
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
    const { code, stderr } = await cli(["in.csv", "out.csv", "--verbose"]);
    assert.equal(code, 0);
    const out = read(path.join(dir, "out.csv"));
    assert.match(out, /^A,nomatch,,$/m);
    assert.match(out, /^B,garbage,,$/m);
    assert.match(out, /^D,addr 4,32\./m);
    assert.match(stderr, /^NO MATCH \| A,nomatch/m);
    assert.match(stderr, /^Parsing error: .* \| B,garbage/m);
    assert.match(stderr, /^HTTP Status 500 \| C,http500/m);
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
    ].map((line, i) => i === 4 && lines[4] === "NO MATCH | X,nomatch," ? lines[4] : line)); // dsv 0.0.4 drops the trailing empty field

    assert.match(lines[6], /^Rows geocoded: 3$/);
    assert.match(lines[7], /^Rows failed: 1$/);
    assert.match(lines[8], /^Time elapsed: [\d.]+ seconds$/);
  });

});

describe("interrupting and resuming", () => {

  // Start a slow run, Ctrl-C it after a few requests, and return the result.
  async function interrupted(rows) {
    writeFixture(dir, "in.csv", rows);
    const result = await cli(["in.csv", "out.csv", "--delay", "30"], {
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
    [["in.csv", "out.csv", "--save-every", "x"], /--save-every requires a whole number of rows\./]
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

  it("throws right away without a url or with an unknown handler", () => {
    assert.throws(() => geocode("in.csv", { test: true }), /url/i);
    assert.throws(() => geocode("in.csv", { test: true, url: "x", handler: "nope" }), /invalid value/i);
  });

});
