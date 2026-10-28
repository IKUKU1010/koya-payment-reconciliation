// Payment reconciliation.
//
// Reads payments.jsonl and works out how much money we actually collected.
// Rules (from the README):
//   - A payment can be attempted several times; every attempt shares a txn_id.
//   - Only the LATEST attempt (by ts) for each txn_id counts.
//   - It counts as collected only if that latest attempt is "success".
//   - Unreadable lines and events without a txn_id are ignored.
//
// Run:  node reconcile.js

const fs = require("fs");

function readFileOrExit(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (err) {
    console.error(`Could not read ${path}: ${err.message}`);
    process.exit(1);
  }
}

// "1,200.50", "₦1,200.50", 1200.5 -> integer kobo (avoids float drift)
function toKobo(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : NaN;
  const cleaned = String(raw ?? "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "") return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

// ISO strings (with or without offset) or epoch numbers -> milliseconds
function toMillis(ts) {
  if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts;
  const t = Date.parse(String(ts ?? "").trim());
  return Number.isNaN(t) ? -Infinity : t;
}

const skipped = { unreadable: 0, noTxnId: 0, superseded: 0, badAmount: 0 };
const statusTally = {};

// txn_id -> { time, order, status, amountKobo }
const latest = new Map();

const lines = readFileOrExit("payments.jsonl").split(/\r?\n/);
let order = 0;
for (const raw of lines) {
  const line = raw.trim();
  if (line === "") continue;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    skipped.unreadable += 1;
    continue;
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    skipped.unreadable += 1;
    continue;
  }

  const txnId = event.txn_id === undefined || event.txn_id === null ? "" : String(event.txn_id).trim();
  if (txnId === "") {
    skipped.noTxnId += 1;
    continue;
  }

  const status = String(event.status ?? "").trim().toLowerCase();
  statusTally[status] = (statusTally[status] || 0) + 1;

  const attempt = {
    time: toMillis(event.ts),
    order: order++, // file order breaks ties between equal timestamps
    status,
    amountKobo: toKobo(event.amount),
  };

  const prev = latest.get(txnId);
  if (!prev || attempt.time > prev.time || (attempt.time === prev.time && attempt.order > prev.order)) {
    if (prev) skipped.superseded += 1;
    latest.set(txnId, attempt);
  } else {
    skipped.superseded += 1;
  }
}

let totalKobo = 0;
let count = 0;
for (const a of latest.values()) {
  if (a.status !== "success") continue;
  if (Number.isNaN(a.amountKobo)) {
    skipped.badAmount += 1;
    continue;
  }
  totalKobo += a.amountKobo;
  count += 1;
}

const expected = parseInt(readFileOrExit("expected.txt").trim(), 10);
if (Number.isNaN(expected)) {
  console.error("expected.txt does not contain a number.");
  process.exit(1);
}

console.log("Skipped:", skipped);
console.log("Statuses seen:", statusTally);
console.log(`Distinct txn_ids: ${latest.size}`);

if (count !== expected) {
  console.log(`Check failed: counted ${count} successful payments, expected ${expected}.`);
  console.log("Something in the data isn't being handled the way the README describes.");
} else {
  console.log(`Check passed: ${count} successful payments.`);
  console.log(`Your code: KOYA-${Math.round(totalKobo / 100)}`);
}
