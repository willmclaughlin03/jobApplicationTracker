# Monitoring & Observability

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AXIOM_DATASET` | For production logging | Axiom dataset name to send logs to |
| `AXIOM_TOKEN` | For production logging | Axiom API token with ingest permission |

Set these in **Vercel Project Settings → Environment Variables** for the Production (and optionally Preview) environments.

When both variables are present, the Pino logger ships structured JSON logs to Axiom via the `@axiomhq/pino` transport. When either is missing, logs go to JSON stdout (picked up by Vercel's default log drain).

## Axiom Setup

### 1. Create a Dataset

1. Go to [app.axiom.co](https://app.axiom.co) → **Datasets**
2. Click **New Dataset**, name it (e.g., `job-tracker-prod`)
3. Note the dataset name — this is your `AXIOM_DATASET` value

### 2. Generate an API Token

1. Go to **Settings → API Tokens**
2. Click **New Token**
3. Name it (e.g., `vercel-ingest`)
4. Grant **Ingest** permission scoped to your dataset
5. Copy the token — this is your `AXIOM_TOKEN` value

### 3. Verify Logs Are Flowing

1. Deploy with both env vars set
2. Hit any API endpoint (e.g., `GET /api/health`)
3. In Axiom, go to your dataset → **Stream** tab
4. You should see structured log entries with `level`, `msg`, `requestId` fields

## Health Endpoint

`GET /api/health` returns the status of Redis and Supabase dependencies.

**Response (200 — healthy):**
```json
{
  "status": "ok",
  "checks": { "redis": "ok", "supabase": "ok" },
  "timestamp": "2026-03-27T12:00:00.000Z"
}
```

**Response (503 — degraded):**
```json
{
  "status": "degraded",
  "checks": { "redis": "fail", "supabase": "ok" },
  "timestamp": "2026-03-27T12:00:00.000Z"
}
```

This endpoint is intentionally **not rate-limited** so uptime monitors can poll it freely.

## Axiom Alerts

### Error Rate Spike

1. Go to **Monitors → New Monitor**
2. **Query:** filter by `level == "error"`, count over 5-minute window
3. **Threshold:** alert when count > 10 (adjust based on baseline)
4. **Notify:** Slack channel or email

### Health Degradation

1. **Query:** filter by `msg == "Health check degraded"`, count over 5-minute window
2. **Threshold:** alert when count > 0
3. **Notify:** Slack channel or email

### Rate Limit Exhaustion

1. **Query:** filter by `msg` containing `"rate limit"` and `level == "warn"`, count over 5-minute window
2. **Threshold:** alert when count > 50 (adjust based on traffic)
3. **Notify:** Slack channel or email

## Uptime Monitoring

Configure an external uptime monitor to poll the health endpoint:

- **URL:** `https://your-domain.vercel.app/api/health`
- **Method:** `GET`
- **Interval:** 60 seconds
- **Alert on:** HTTP status ≠ 200 or no response within 10 seconds

Options for uptime monitoring:
- **Axiom Monitors** — built-in, no extra service needed
- **Better Uptime** — free tier available
- **UptimeRobot** — free tier with 5-minute intervals

## Local Development

Without `AXIOM_DATASET` and `AXIOM_TOKEN` set, logs are pretty-printed to the terminal via `pino-pretty` with colors and timestamps. No Axiom calls are made locally.
