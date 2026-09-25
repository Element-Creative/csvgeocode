export default {
  lat: null,
  lng: null,
  delay: 250,
  timeout: 30000,
  retries: 3,
  retryWaits: [2000, 10000, 30000],
  maxFailedInARow: 5,
  force: false,
  resume: false,
  precision: 6,
  statusColumns: false,
  saveEvery: 100,
  handler: "google",
  encoding: "utf-8"
};
