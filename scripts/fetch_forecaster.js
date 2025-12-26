// scripts/fetch_forecaster.js
import { chromium } from "playwright";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
if (!MAKE_WEBHOOK_URL) {
  console.error("Missing env var: MAKE_WEBHOOK_URL");
  process.exit(1);
}

const TICKER = "TSLA";
const BASE_URL = "https://terminal.forecaster.biz/instrument/nasdaq/tsla/projection";

function toISODate(ms) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function todayUTC() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function waitForApexSeries(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const series = await page.evaluate(() => {
        const apex = window.Apex;
        if (!apex || !apex._chartInstances || !apex._chartInstances.length) return null;

        // try to find the projection chart specifically
        const inst =
          apex._chartInstances.find((x) => x?.id === "projection-chart") ||
          apex._chartInstances[0];

        const s = inst?.chart?.w?.config?.series;
        if (!Array.isArray(s) || s.length === 0) return null;

        // Ensure the series contains data points
        const hasPoints = s.some((z) => Array.isArray(z?.data) && z.data.length > 0);
        return hasPoints ? s : null;
      });

      if (series) return series;
    } catch (e) {
      // ignore eval hiccups, keep polling
    }
    await page.waitForTimeout(750);
  }
  throw new Error("Timed out waiting for ApexCharts series to appear.");
}

async function scrapeTimeframe(context, { label, url }) {
  const page = await context.newPage();

  // Log page errors without crashing the run
  page.on("pageerror", (err) => {
    console.log(`[PAGE ERROR ${label}] ${err?.message || err}`);
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    // Wait for the chart container to exist (helps ensure the page layout loaded)
    await page.waitForSelector("#projection-chart, .apexcharts-canvas", { timeout: 120000 });

    // Give the app a moment to render chart instances
    await page.waitForTimeout(1500);

    const series = await waitForApexSeries(page, 120000);

    // Convert series -> rows
    const forecastDate = todayUTC();
    const rows = [];

    for (const s of series) {
      const scenario = s?.name || "Unknown";
      const points = Array.isArray(s?.data) ? s.data : [];

      for (const p of points) {
        const x = p?.x;
        const y = p?.y;
        if (typeof x !== "number" || typeof y !== "number") continue;

        rows.push({
          Ticker: TICKER,
          Forecast_Date: forecastDate,
          Target_Date: toISODate(x),
          Scenario: scenario,
          Predicted_Price: Number(y.toFixed(2)),
          Horizon: label, // helpful for Make routing / separate sheets
        });
      }
    }

    if (!rows.length) {
      throw new Error(`No prediction points found for ${label}.`);
    }

    return rows;
  } finally {
    await page.close().catch(() => {});
  }
}

async function postToMake(payload) {
  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Make webhook failed (${res.status}): ${text}`);
  }
  console.log(`✅ Sent to Make (${res.status})`);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    javaScriptEnabled: true,
    bypassCSP: true,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  try {
    const targets = [
      { label: "3m", url: BASE_URL }, // default page = 3m
      { label: "1m", url: `${BASE_URL}?tf=1m` },
    ];

    let allRows = [];
    for (const t of targets) {
      console.log(`--- Scraping ${t.label}: ${t.url}`);
      const rows = await scrapeTimeframe(context, t);
      console.log(`✅ ${t.label} rows: ${rows.length}`);
      allRows = allRows.concat(rows);
    }

    // Send everything in one payload; Make can split by Horizon
    await postToMake({
      source: "forecaster_terminal",
      scraped_at_utc: new Date().toISOString(),
      rows: allRows,
    });

    console.log(`✅ Total rows sent: ${allRows.length}`);
  } catch (err) {
    console.error(`❌ Scrape failed: ${err?.message || err}`);
    process.exit(1);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main();
