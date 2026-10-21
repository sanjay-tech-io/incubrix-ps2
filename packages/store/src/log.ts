import pino from "pino";

// One logger setup for api and worker. Lines are JSON with `timestamp`, `level` (a word), `service`, and whatever
// the caller binds: `job_id`, `correlation_id`. Secrets are redacted by path; never log request bodies.
export function makeLogger(service: string, level: string, destination?: pino.DestinationStream): pino.Logger {
  return pino(
    {
      level,
      base: { service },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: ["authorization", "*.authorization", "req.headers.authorization", "headers.authorization", "token", "*.token", "secret", "*.secret", "api_token", "callback_secret", "S3_SECRET_KEY", "*.S3_SECRET_KEY"], censor: "[redacted]" },
    },
    destination,
  );
}
export type Logger = pino.Logger;
