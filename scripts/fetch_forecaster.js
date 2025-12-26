import playwright from "playwright";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
if (!MAKE_WEBHOOK_URL) {
  console.error("Missing env var: MAKE_WEBHOOK_URL");
  process.exit(1);
}

const TICKER = "TSLA";
const BASE_URL = "https://terminal.forecaster.biz/instrument/nasdaq/tsla/projection";

const timeframes = [
  { tf: "1m", url: `${BASE_URL}?tf=1m` },
  { tf: "3m", url: `${BASE_URL}` }, // default is 3m
];

// converts ms timestamp -> YYYY-MM-DD
function toISODate(ms) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// robust extractor: tries Apex internal, then scans window for {x,y} series
function extractSeriesFromPage(result) {
  // result is what we return from page.evaluate
  if (result?.apexSeries?.length) return result.apexSeries;
  if (result?.windowScanSeries?.length) return result.windowScanSeries;
  return [];
}

async function scrapeOne(page, tf, url) {
  console.log(`➡️ Loading ${tf}: ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

  // Give it time to hydrate charts
  await page.waitForTimeout(3000);

  // Wait up to 90s for ANY evidence of chart data.
  // We don't hardcode exact object paths because they change.
  await page.waitForFunction(
    () => {
      // obvious apex global?
      if (window.Apex && window.Apex._chartInstances && window.Apex._chartInstances.length) return true;

      // common apexcharts internal objects
      if (window.__APEXCHARTS__ && Object.keys(window.__APEXCHARTS__).length) return true;

      // scan window for any array containing {x,y}
      for (const k of Object.keys(window)) {
        try {
          const v = window[k];
          if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object") {
            // look for at least one {x: number, y: number}
            const hit = v.find?.(o => o && typeof o === "object" && "x" in o && "y" in o);
            if (hit && typeof hit.x === "number" && typeof hit.y === "number") return true;
          }
        } catch (_) {}
      }
      return false;
    },
    { timeout: 90000 }
  );

  // Pull the series out
  const raw = await page.evaluate(() => {
    // 1) Try Apex global
    let apexSeries = [];
    try {
      if (window.Apex && window.Apex._chartInstances && window.Apex._chartInstances.length) {
        const inst = window.Apex._chartInstances[0];
        // in many builds this exists:
        const s = inst?.chart?.w?.config?.series;
        if (Array.isArray(s) && s.length) apexSeries = s;
      }
    } catch (e) {}

    // 2) Try scanning window for arrays of {x,y}
    // We return in a normalized "series-like" format
    let windowScanSeries = [];
    try {
      const candidates = [];
      for (const k of Object.keys(window)) {
        try {
          const v = window[k];
          if (Array.isArray(v) && v.length) {
            const hit = v.find?.(o => o && typeof o === "object" && "x" in o && "y" in o);
            if (hit && typeof hit.x === "number" && typeof hit.y === "number") {
              candidates.push({ key: k, data: v });
            }
          }
        } catch (_) {}
      }

      // If we found at least one candidate, wrap it
      if (candidates.length) {
        windowScanSeries = candidates.map(c => ({
          name: c.key,
          data: c.data,
        }));
      }
    } catch (e) {}

    return { apexSeries, windowScanSeries };
  });

  const series = extractSeriesFromPage(raw);

  if (!series.length) {
    throw new Error(`Could not locate ApexCharts series data on page (${tf}).`);
  }

  // Convert to rows for Make webhook
  // Keep only series that have {x,y} pairs
  const rows = [];
  const forecastDate = new Date().toISOString().slice(0, 10);

  for (const s of series) {
    const scenario = s?.name || "Unknown";
    const data = Array.isArray(s?.data) ? s.data : [];

    for (const pt of data) {
      if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") continue;

      rows.push({
        Ticker: TICKER,
        Forecast_Date: forecastDate,
        Target_Date: toISODate(pt.x),
        Scenario: scenario,
        Predicted_Price: Number(pt.y.toFixed(4)),
        Timeframe: tf, // helpful for routing in Make
      });
    }
  }

  console.log(`✅ ${tf}: extracted ${rows.length} points`);
  return rows;
}

async function main() {
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Some sites behave differently headless; spoof a normal UA
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  const allRows = [];
  try {
    for (const t of timeframes) {
      const rows = await scrapeOne(page, t.tf, t.url);
      allRows.push(...rows);
    }
  } catch (err) {
    console.error("❌ Scrape failed:", err?.message || err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }

  if (process.exitCode === 1) return;

  // Post to Make webhook
  console.log(`➡️ Posting ${allRows.length} rows to Make webhook...`);
  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows: allRows }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("❌ Webhook POST failed:", res.status, txt);
    process.exit(1);
  }

  console.log("✅ Webhook delivered successfully");
}

main();
