// Shared helpers for the offline test suite: a fake geocoding API, a way to
// run the real CLI against it, and fixture/temp-file utilities.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "csvgeocode");

// Coordinates for "addr N", written the way Google's JSON writes them: with
// floating-point noise in the last digits (e.g. 32.00054039999999).
export function rawLat(n) {
  return "32." + String(n).padStart(4, "0") + "4039999999";
}

export function rawLng(n) {
  return "-96." + String(n).padStart(4, "0") + "712600000002";
}

export function rounded(raw, places = 6) {
  return String(Number(Number(raw).toFixed(places)));
}

// A fake Google-style geocoder. The address decides the response:
//   "addr N"      -> OK, coordinates from rawLat(N)/rawLng(N)
//   "nomatch..."  -> ZERO_RESULTS
//   "garbage..."  -> 200 with an HTML body
//   "http500..."  -> HTTP 500
//   "denied..."   -> REQUEST_DENIED
//   "overlimit..." -> OVER_QUERY_LIMIT the first time, then OK
//   "flaky..."    -> HTTP 503 twice, then OK
//   "hang..."     -> never responds
// Every request is recorded in `requests` (address + key query params).
export async function startServer() {
  const requests = [];
  const seen = new Map();
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    //No keep-alive: on Node 26, fetch reusing a plain-http localhost
    //connection after a pause stalls for up to 500ms (not seen over https)
    res.setHeader("Connection", "close");
    const url = new URL(req.url, "http://localhost");
    const address = url.searchParams.get("address") ?? "";
    const key = url.searchParams.get("key");
    requests.push({ url: req.url, address, key });

    const count = (seen.get(address) ?? 0) + 1;
    seen.set(address, count);

    const json = body => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const ok = n => {
      res.setHeader("Content-Type", "application/json");
      res.end('{"status":"OK","results":[{"geometry":{"location":{"lat":' + rawLat(n) + ',"lng":' + rawLng(n) + "}}}]}");
    };

    if (address.startsWith("hang")) return;
    if (address.startsWith("nomatch")) return json({ status: "ZERO_RESULTS", results: [] });
    if (address.startsWith("garbage")) return res.end("<html>Service Unavailable</html>");
    if (address.startsWith("http500")) {
      res.statusCode = 500;
      return res.end("Internal Server Error");
    }
    if (address.startsWith("denied")) {
      return json({ status: "REQUEST_DENIED", error_message: "The provided API key is invalid.", results: [] });
    }
    if (address.startsWith("overlimit") && count === 1) {
      return json({ status: "OVER_QUERY_LIMIT", error_message: "Slow down.", results: [] });
    }
    if (address.startsWith("flaky") && count <= 2) {
      res.statusCode = 503;
      return res.end("Service Unavailable");
    }

    ok(Number((address.match(/\d+/) ?? ["0"])[0]));
  });

  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    requests,
    url: (template = "{{ADDRESS}}") => "http://127.0.0.1:" + port + "/json?address=" + template + "&key=TESTKEY",
    reset() {
      requests.length = 0;
      seen.clear();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

// Run the real CLI with the Node that's running the tests. `onSpawn` gets the
// child process, e.g. to send it a signal mid-run.
export function runCli(args, { cwd, onSpawn } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (onSpawn) onSpawn(child);
  });
}

// A localhost port with nothing listening on it
export async function closedPort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csvgeocode-test-"));
}

// Write a CSV of `n` rows "Place i,addr i" (plus any extra rows) into dir.
export function writeFixture(dir, name, n, extraRows = []) {
  const lines = ["NAME,ADDRESS"];
  for (let i = 1; i <= n; i++) lines.push("Place " + i + ",addr " + i);
  lines.push(...extraRows);
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

export function read(file) {
  return fs.readFileSync(file, "utf8");
}

// Parse a simple (unquoted) CSV into header + rows of strings.
export function rowsOf(file) {
  const [header, ...lines] = read(file).trim().split("\n");
  return { header, rows: lines.map(line => line.split(",")) };
}

export async function waitFor(predicate, timeout = 10000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
