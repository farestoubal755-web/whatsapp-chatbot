import { google } from "googleapis";
import { cfg } from "./config.js";
import { withRetry } from "./retry.js";
import { normalize, colLetter } from "./utils.js";

const auth = new google.auth.JWT({
  email: cfg.google.clientEmail,
  key: cfg.google.privateKey.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  projectId: cfg.google.projectId,
});
const sheetsApi = google.sheets({ version: "v4", auth });

// Tiny in-memory TTL cache. Products/shipping rarely change, so short-lived
// caching removes most of the duplicate reads that used to hit Sheets'
// per-minute quota on every single incoming message.
const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}
function cacheSet(key, value, ttlMs) {
  if (ttlMs > 0) cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
function invalidateTab(tab) {
  const marker = `'${tab}'!`;
  for (const key of cache.keys()) if (key.includes(marker)) cache.delete(key);
}

export async function getValues(range, { ttlMs = 0 } = {}) {
  if (ttlMs > 0) {
    const cached = cacheGet(`get:${range}`);
    if (cached) return cached;
  }
  const r = await withRetry(
    () => sheetsApi.spreadsheets.values.get({ spreadsheetId: cfg.google.spreadsheetId, range }),
    { label: `sheets.get ${range}` }
  );
  const values = r.data.values || [];
  if (ttlMs > 0) cacheSet(`get:${range}`, values, ttlMs);
  return values;
}

function tabNameOf(range) {
  return range.split("!")[0].replace(/^'|'$/g, "");
}

export async function updateValues(range, values) {
  await withRetry(
    () => sheetsApi.spreadsheets.values.update({ spreadsheetId: cfg.google.spreadsheetId, range, valueInputOption: "USER_ENTERED", requestBody: { values } }),
    { label: `sheets.update ${range}` }
  );
  invalidateTab(tabNameOf(range));
}

export async function appendValues(range, values) {
  await withRetry(
    () => sheetsApi.spreadsheets.values.append({ spreadsheetId: cfg.google.spreadsheetId, range, valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS", requestBody: { values } }),
    { label: `sheets.append ${range}` }
  );
  invalidateTab(tabNameOf(range));
}

// Creates the tab with the given headers if it doesn't exist yet. If it
// already exists, adds any headers that are missing (appended as new
// trailing columns) without touching existing columns or data - this lets us
// evolve SESSIONS/ORDERS over time without breaking a store owner's existing
// spreadsheet.
export async function ensureTab(title, headers) {
  const meta = await withRetry(
    () => sheetsApi.spreadsheets.get({ spreadsheetId: cfg.google.spreadsheetId, fields: "sheets.properties" }),
    { label: `sheets.meta ${title}` }
  );
  const exists = (meta.data.sheets || []).some((s) => s.properties?.title === title);

  if (!exists) {
    await withRetry(
      () => sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: cfg.google.spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } }),
      { label: `sheets.addTab ${title}` }
    );
    await updateValues(`'${title}'!A1`, [headers]);
    return;
  }

  const headerRow = await getValues(`'${title}'!1:1`);
  const current = headerRow[0] || [];
  const currentNormalized = new Set(current.map(normalize));
  const missing = headers.filter((h) => !currentNormalized.has(normalize(h)));
  if (missing.length) {
    const range = `'${title}'!${colLetter(current.length + 1)}1`;
    await updateValues(range, [missing]);
  }
}
