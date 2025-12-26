// scripts/fetch_forecaster.js
// Scrapes Forecaster terminal chart data via headless browser (Playwright)
// and sends rows to Make.com webhook.
//
// Output row format:
// Ticker, Forecast_Date, Target_Date, Scenario, Predicted_Price

import { chromium } from "playwright";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
if (!MAKE_WEBHOOK_URL) {
  console.error("Missing env var: MAKE_WEBHOOK_URL");
  process.exit(1);
}

const TICKER = process.env.TICKER || "TSLA";

const URLS = [
  { horizon: "1m", url: "https://terminal.forecaster.biz/instrument/nasdaq/tsla/projection?tf=1m" },
  { horizon: "3m", url: "https://terminal.forecaster.biz/instrument/nasdaq/tsla/projection" },
];

function toISODate(ms) {
  // ms is epoch milliseconds
  const d = new Date(ms);
  // Use UTC date so it’s stable in Actions
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

async function getSeriesFromPage(page, url, horizon) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Wait until Apex chart instances exist (page is hydrated + chart rendered)
  await page.waitForFunction(() => {
    // eslint-disable-next-line no-undef
    return typeof window !== "undefined"
      // eslint-disable-next-line no-undef
      && window.Apex
      // eslint-disable-next-line no-undef
      && Array.isArray(window.Apex._chartInstances)
      // eslint-disable-next-line no-undef
      && window.Apex._chartInstances.length > 0
      // eslint-disable-next-line no-undef
      && window.Apex._chartInstances[0]?.chart?.w?.config?.series?.length > 0;
  }, { timeout: 60000 });

  const series = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const inst = window.Apex._chartInstances[0];
    return inst.chart.w.config.series || [];
  });

  if (!series || !Array.isArray(series) || series.length === 0) {
    throw new Error(`Could not locate ApexCharts series data on page (${horizon}).`);
  }

  return series;
}

async function main() {
  const forecastDate = todayUTC();
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  const allRows = [];

  try {
    for (const item of URLS) {
      const { horizon, url } = item;

      const series = await getSeriesFromPage(page, url, horizon);

      for (const s of series) {
        const scenario = s?.name || "Unknown";
        const points = Array.isArray(s?.data) ? s.data : [];

        for (const p of points) {
          if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;

          allRows.push({
            Ticker: TICKER,
            Forecast_Date: forecastDate,
            Target_Date: toISODate(p.x),
            Scenario: `${horizon}:${scenario}`,
            Predicted_Price: Number(p.y.toFixed(2)),
          });
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (allRows.length === 0) {
    console.error("No rows were scraped. Exiting.");
    process.exit(1);
  }

  // Send to Make webhook
  const payload = {
    ticker: TICKER,
    forecast_date: forecastDate,
    rows: allRows,
  };

  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("Make webhook error:", res.status, text);
    process.exit(1);
  }

  console.log(`✅ Sent ${allRows.length} rows to Make.`);
  console.log(text);
}

main().catch((err) => {
  console.error("❌ Scrape failed:", err?.message || err);
  process.exit(1);
});
