import { chromium } from "playwright";

const TICKER = process.env.TICKER || "TSLA";
const EXCHANGE = process.env.EXCHANGE || "nasdaq";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

if (!MAKE_WEBHOOK_URL) {
  console.error("Missing env var: MAKE_WEBHOOK_URL");
  process.exit(1);
}

const BASE = `https://terminal.forecaster.biz/instrument/${EXCHANGE}/${TICKER.toLowerCase()}/projection`;
const URL_3M = BASE; // default is 3m
const URL_1M = `${BASE}?tf=1m`;

function toISODateFromMs(ms) {
  const d = new Date(Number(ms));
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
  // Give the page more time globally (prevents 30s defaults)
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  // Wait for Apex chart instances to exist
  await page.waitForFunction(
    () => {
      const A = window.Apex;
      return !!(A && A._chartInstances && A._chartInstances.length);
    },
    { timeout: 120000 }
  );

  const raw = await page.evaluate(() => {
    const A = window.Apex;
    if (!A?._chartInstances?.length) return null;

    const instances = A._chartInstances;

    const byId =
      instances.find((x) => x?.id === "projection-chart" || x?.chart?.id === "projection-chart") ||
      instances.find((x) => x?.chart?.el?.id === "projection-chart");

    const inst = byId || instances[0];
    const series = inst?.chart?.w?.config?.series;

    if (!Array.isArray(series) || !series.length) return null;

    return series.map((s) => ({
      name: s?.name,
      type: s?.type,
      data: Array.isArray(s?.data) ? s.data : [],
    }));
  });

  if (!raw) {
    throw new Error(`Could not locate ApexCharts series data on page (${timeframeLabel}).`);
  }

  const now = new Date();
  const forecastDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate()
  ).padStart(2, "0")}`;

  const rows = [];
  for (const s of raw) {
    const scenario = (s?.name || "").trim();
    if (!scenario) continue;

    // skip historical area series
    if (scenario.toLowerCase() === "price") continue;

    for (const pt of s.data) {
      const x = pt?.x;
      const y = pt?.y;
      if (x == null || y == null) continue;

      rows.push({
        Ticker: TICKER.toUpperCase(),
        Forecast_Date: forecastDate,
        Target_Date: toISODateFromMs(x),
        Scenario: scenario,
        Predicted_Price: round2(y),
        Timeframe: timeframeLabel,
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
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1400, height: 900 },
    });

    const page = await context.newPage();

    // Extra logging so we can diagnose if it’s being blocked
    page.on("console", (msg) => console.log(`[PAGE ${timeframeLabel}]`, msg.text()));
    page.on("pageerror", (err) => console.log(`[PAGE ERROR ${timeframeLabel}]`, err.message));

    // Load page (networkidle helps on JS-heavy sites)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // If Apex is slow, retry once with a refresh
    try {
      return await scrapeApexSeriesFromPage(page, timeframeLabel);
    } catch (e) {
      console.log(`Retrying ${timeframeLabel} after reload...`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(4000);
      return await scrapeApexSeriesFromPage(page, timeframeLabel);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const allRows = [];

  const rows3m = await scrapeOne(URL_3M, "3m");
  allRows.push(...rows3m);

  const rows1m = await scrapeOne(URL_1M, "1m");
  allRows.push(...rows1m);

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
