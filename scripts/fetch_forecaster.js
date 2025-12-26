import fetch from "node-fetch";

const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK_URL;

const SYMBOL = "tsla";
const EXCHANGE = "nasdaq";

async function fetchForecast(horizon) {
  const url = `https://terminal.forecaster.biz/instrument/${EXCHANGE}/${SYMBOL}/projection?horizon=${horizon}`;
  const res = await fetch(url);
  const html = await res.text();

  // Grab ApexCharts data
  const match = html.match(/ApexCharts\.exec\([\s\S]*?\)/);
  if (!match) throw new Error("Forecast data not found");

  return match[0];
}

async function run() {
  const now = new Date().toISOString().slice(0, 10);

  const payload = {
    ticker: "TSLA",
    forecast_date: now,
    forecasts: []
  };

  // 1-month + 3-month
  for (const horizon of ["1m", "3m"]) {
    const raw = await fetchForecast(horizon);

    payload.forecasts.push({
      horizon,
      raw
    });
  }

  await fetch(MAKE_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

