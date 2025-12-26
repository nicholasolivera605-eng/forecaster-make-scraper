// scripts/fetch_forecaster.js
//
// Fetches forecast series from Forecaster Terminal (ApexCharts data) for 1m + 3m,
// then POSTs the rows to a Make.com webhook.
//
// Usage (GitHub Actions):
//   node scripts/fetch_forecaster.js
//
// Required env vars:
//   MAKE_WEBHOOK_URL = https://hook.us1.make.com/xxxx
//
// Optional env vars (defaults shown):
//   SYMBOL=tsla
//   EXCHANGE=nasdaq
//   FORECAST_DATE=auto (ISO date today in UTC, e.g. 2025-12-26)

const SYMBOL = (process.env.SYMBOL || "tsla").toLowerCase();
const EXCHANGE = (process.env.EXCHANGE || "nasdaq").toLowerCase();
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// Set forecast_date as YYYY-MM-DD (UTC)
const FORECAST_DATE =
  process.env.FORECAST_DATE ||
  new Date().toISOString().slice(0, 10);

if (!MAKE_WEBHOOK_URL) {
  console.error("Missing env var: MAKE_WEBHOOK_URL");
  process.exit(1);
}

// Convert ms timestamp to YYYY-MM-DD (UTC)
function toYMD(ms) {
  const d = new Date(Number(ms));
  return d.toISOString().slice(0, 10);
}

// Scrape the projection page HTML and extract ApexCharts series data.
async function fetchForecast(horizon) {
  // 3m is the default page; 1m uses ?tf=1m
  const base = `https://terminal.forecaster.biz/instrument/${EXCHANGE}/${SYMBOL}/projection`;
  const url = horizon === "1m" ? `${base}?tf=1m` : base;

  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`Forecaster fetch failed (${horizon}): ${res.status} ${res.statusText}`);
  }

  const html = await res.text();

  // We look for the ApexCharts "series" array in the HTML.
  // The page typically includes something like: series:[{name:"Price",data:[{x:...,y:...},...]}, ...]
  // We'll capture the JSON-ish blob and eval it safely-ish by normalizing to JSON.
  //
  // 1) Find "series" block
  const seriesMatch =
    html.match(/series\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])/m) ||
    html.match(/"series"\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])/m);

  if (!seriesMatch) {
    throw new Error(
      `Could not locate ApexCharts series data on page (${horizon}). The page structure may have changed.`
    );
  }

  const seriesRaw = seriesMatch[1];

  // 2) Convert JS object-ish syntax to JSON:
  // - Quote unquoted keys (x:, y:, name:, data:, type:, color:, group:)
  // - Convert single quotes to double quotes
  // This is best-effort; if it breaks, we can switch to a Playwright runner.
  const seriesJsonString = seriesRaw
    .replace(/(\w+)\s*:/g, '"$1":') // quote keys
    .replace(/'/g, '"'); // normalize quotes

  let series;
  try {
    series = JSON.parse(seriesJsonString);
  } catch (e) {
    // If JSON parsing fails, throw with a little debug.
    throw new Error(
      `Failed to parse series JSON (${horizon}). Error: ${e.message}`
    );
  }

  // 3) Flatten into rows:
  // Output format requested:
  // Ticker, Forecast_Date, Target_Date, Scenario, Predicted_Price
  //
  // Scenario will be series.name, e.g. "Best Match", "Bear Scenario", "Bull Scenario"
  // We ignore "Price" unless you want to store it too.
  const rows = [];

  for (const s of series) {
    const scenario = s?.name || "Unknown";
    const points = Array.isArray(s?.data) ? s.data : [];

    // If points are objects like {x:..., y:...}
    for (const p of points) {
      if (!p || typeof p !== "object") continue;
      if (p.x == null || p.y == null) continue;

      rows.push({
        Ticker: SYMBOL.toUpperCase(),
        Forecast_Date: FORECAST_DATE,
        Target_Date: toYMD(p.x),
        Scenario: scenario,
        Predicted_Price: Number(p.y),
        Horizon: horizon, // keep for routing to 1m/3m sheets in Make (optional)
      });
    }
  }

  return rows;
}

async function postToMake(payload) {
  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Make webhook failed: ${res.status} ${res.statusText}\n${text}`);
  }

  return res.text().catch(() => "");
}

async function main() {
  try {
    const [rows1m, rows3m] = await Promise.all([
      fetchForecast("1m"),
      fetchForecast("3m"),
    ]);

    // You can choose to keep/strip "Price" series.
    // If you want to exclude "Price" (actual series) uncomment this filter:
    // const filterOutPrice = (r) => r.Scenario !== "Price";
    // const rows = [...rows1m, ...rows3m].filter(filterOutPrice);

    const rows = [...rows1m, ...rows3m];

    const payload = {
      ticker: SYMBOL.toUpperCase(),
      exchange: EXCHANGE.toUpperCase(),
      forecast_date: FORECAST_DATE,
      rows,
    };

    const resp = await postToMake(payload);
    console.log(`✅ Sent ${rows.length} rows to Make. Response: ${resp}`);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

main();

