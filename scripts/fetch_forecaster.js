// scripts/fetch_forecaster.js
// Scrapes Forecaster projections (1m + 3m) from terminal.forecaster.biz using Playwright,
// then POSTs rows to your Make webhook as JSON.
//
// Output schema per row:
// Ticker, Forecast_Date, Target_Date, Scenario, Predicted_Price, Timeframe
//
// Env required:
// MAKE_WEBHOOK_URL = your Make custom webhook URL (full https://hook....)

import { chromium } from "playwright";

const TICKER = process.env.TICKER || "TSLA";
const EXCHANGE = process.env.EXCHANGE || "nasdaq";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

if (!MAKE_WEBHOOK_URL) {
  console.error("Missing env var: MAKE_WEBHOOK_URL");
  process.exit(1);
}

const BASE = `https://terminal.forecaster.biz/instrument/${EXCHANGE}/${TICKER.toLowerCase()}/projection`;
const URL_3M = BASE; // default is 3m on this site
const URL_1M = `${BASE}?tf=1m`;

function toISODateFromMs(ms) {
  // site returns ms timestamps
  const d = new Date(Number(ms));
  // Use YYYY-MM-DD (no time)
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function round2(n) {
  const x = Number(n);
  return Math.round(x * 100) / 100;
}

async function postToMake(payload) {
  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Make webhook failed: ${res.status} ${res.statusText} ${text}`);
  }
}

async function scrapeApexSeriesFromPage(page, timeframeLabel) {
  // Wait for Apex to exist + chart instances to populate
  // (more reliable than waiting for CSS selectors)
  await page.waitForFunction(
    () => {
      const A = window.Apex;
      return !!(A && A._chartInstances && A._chartInstances.length);
    },
    { timeout: 90000 }
  );

  // Pull series from the chart instance in the page context
  const raw = await page.evaluate(() => {
    const A = window.Apex;
    if (!A?._chartInstances?.length) return null;

    // Try to locate the projection chart instance
    // Most of the time it's the first/only chart, but we also try by id.
    const instances = A._chartInstances;

    const byId =
      instances.find((x) => x?.id === "projection-chart" || x?.chart?.id === "projection-chart") ||
      instances.find((x) => x?.chart?.el?.id === "projection-chart");

    const inst = byId || instances[0];
    const series = inst?.chart?.w?.config?.series;

    if (!Array.isArray(series) || !series.length) return null;

    // Return minimal clean object
    return series.map((s) => ({
      name: s?.name,
      type: s?.type,
      data: Array.isArray(s?.data) ? s.data : [],
    }));
  });

  if (!raw) {
    throw new Error(
      `Could not locate ApexCharts series data on page (${timeframeLabel}). The page structure may have changed.`
    );
  }

  // Normalize to rows
  // We expect series like: Price (area), Best Match, Bear Scenario, Bull Scenario
  const now = new Date();
  const forecastDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate()
  ).padStart(2, "0")}`;

  const rows = [];
  for (const s of raw) {
    const scenario = (s?.name || "").trim();
    if (!scenario) continue;

    // Only keep forecast scenario lines (not the historical Price area)
    // If you WANT Price too, remove this filter.
    if (scenario.toLowerCase() === "price") continue;

    for (const pt of s.data) {
      // points are usually objects like {x: 1766534400000, y: 485.4}
      const x = pt?.x;
      const y = pt?.y;

      if (x == null || y == null) continue;

      rows.push({
        Ticker: TICKER.toUpperCase(),
        Forecast_Date: forecastDate,
        Target_Date: toISODateFromMs(x),
        Scenario: scenario,
        Predicted_Price: round2(y),
        Timeframe: timeframeLabel, // "1m" or "3m"
      });
    }
  }

  if (!rows.length) {
    throw new Error(`Apex series found but no usable scenario points (${timeframeLabel}).`);
  }

  return rows;
}

async function scrapeOne(url, timeframeLabel) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    // NOTE: userAgent belongs on CONTEXT (not page)
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1400, height: 900 },
    });

    const page = await context.newPage();

    // Faster + less flaky loads
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    // Give scripts time to hydrate charts
    // (some pages render after network is "idle", so we use a short delay too)
    await page.waitForTimeout(2500);

    const rows = await scrapeApexSeriesFromPage(page, timeframeLabel);
    return rows;
  } finally {
    await browser.close();
  }
}

async function main() {
  // Scrape both timeframes
  const allRows = [];

  // 3m first (default)
  const rows3m = await scrapeOne(URL_3M, "3m");
  allRows.push(...rows3m);

  // 1m second
  const rows1m = await scrapeOne(URL_1M, "1m");
  allRows.push(...rows1m);

  // Send to Make in one payload (recommended)
  // Your Make scenario should iterate over payload.rows
  const payload = {
    source: "forecaster_terminal",
    ticker: TICKER.toUpperCase(),
    scraped_at_utc: new Date().toISOString(),
    rows: allRows,
  };

  await postToMake(payload);

  console.log(`✅ Sent ${allRows.length} forecast points to Make.`);
}

main().catch((err) => {
  console.error("❌ Scrape failed:", err?.message || err);
  process.exit(1);
});
