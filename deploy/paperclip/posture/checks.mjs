// Pure posture checks: structured data in, a finding out. No I/O.
//
// Every check returns { id, title, pass, skipped, detail }. `pass` is a
// boolean, except when `skipped` is true (no live credential/tool was
// available to evaluate it), in which case `pass` is null and the report
// must say so loudly rather than silently treating it as green.

const MODEL_PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

const TRACING_AND_CRASH_ENV_VARS = [
  "SENTRY_DSN",
  "SENTRY_DSN_FRONTEND",
  "SENTRY_DSN_BACKEND",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
];

function finding(id, title, pass, detail, extra = {}) {
  return { id, title, pass, skipped: false, detail, ...extra };
}

function skipped(id, title, detail) {
  return { id, title, pass: null, skipped: true, detail };
}

/** Deployment mode / exposure / bind, as effective in the process env. */
export function checkDeploymentPosture(env) {
  const mode = env.PAPERCLIP_DEPLOYMENT_MODE;
  const exposure = env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  const bind = env.PAPERCLIP_BIND;
  const pass = mode === "authenticated" && exposure === "private" && bind === "tailnet";
  return finding(
    "deployment-posture",
    "Deployment mode is authenticated+private, bind is tailnet",
    pass,
    `PAPERCLIP_DEPLOYMENT_MODE=${mode ?? "(unset)"}, PAPERCLIP_DEPLOYMENT_EXPOSURE=${exposure ?? "(unset)"}, PAPERCLIP_BIND=${bind ?? "(unset)"}`,
  );
}

/** Product telemetry must be disabled via the env-var belt. */
export function checkTelemetryDisabled(env) {
  const value = env.PAPERCLIP_TELEMETRY_DISABLED;
  const pass = value === "1" || value === "true";
  return finding(
    "telemetry-env",
    "Product telemetry disabled (env belt)",
    pass,
    `PAPERCLIP_TELEMETRY_DISABLED=${value ?? "(unset)"}`,
  );
}

/**
 * Product telemetry's config-file brace. `instanceConfig` is the parsed
 * contents of ~/.paperclip/instances/<id>/config.json, or null if it could
 * not be read (skips rather than fails, since the file lives outside any
 * live API and reading it is host-filesystem glue, not this check's job).
 */
export function checkTelemetryConfigFile(instanceConfig) {
  if (instanceConfig === null) {
    return skipped(
      "telemetry-config",
      "Product telemetry disabled (config-file brace)",
      "instance config.json was not supplied to the check",
    );
  }
  const pass = instanceConfig?.telemetry?.enabled === false;
  return finding(
    "telemetry-config",
    "Product telemetry disabled (config-file brace)",
    pass,
    `telemetry.enabled=${JSON.stringify(instanceConfig?.telemetry?.enabled)}`,
  );
}

/** Sentry and OpenTelemetry must be left unconfigured (opt-in upstream). */
export function checkNoTracingOrCrashReporting(env) {
  const present = TRACING_AND_CRASH_ENV_VARS.filter((name) => env[name]);
  return finding(
    "tracing-crash-reporting-off",
    "Sentry and OpenTelemetry unconfigured",
    present.length === 0,
    present.length === 0
      ? "none of SENTRY_DSN*, OTEL_EXPORTER_OTLP_ENDPOINT are set"
      : `set and must not be: ${present.join(", ")}`,
  );
}

/** No model-provider credential may be visible to the instance. */
export function checkNoProviderCredentials(env) {
  const present = MODEL_PROVIDER_ENV_VARS.filter((name) => env[name]);
  return finding(
    "no-provider-credentials",
    "No model-provider credentials present",
    present.length === 0,
    present.length === 0
      ? "none of " + MODEL_PROVIDER_ENV_VARS.join(", ") + " are set"
      : `present and must not be: ${present.join(", ")}`,
  );
}

/**
 * Feedback-trace sharing must be defaulted denied AND floored via env, so
 * the belt is in place even before checking the live API.
 */
export function checkFeedbackSharingEnvConfig(env) {
  const hidden = (env.PAPERCLIP_HIDDEN_SETTINGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const flooredKey = "instance.general.feedbackDataSharingPreference";
  const floored = hidden.includes(flooredKey);

  let defaultedDenied = false;
  let defaultsParseError = null;
  if (env.PAPERCLIP_SETTING_DEFAULTS) {
    try {
      const parsed = JSON.parse(env.PAPERCLIP_SETTING_DEFAULTS);
      defaultedDenied = parsed.feedbackDataSharingPreference === "denied";
    } catch (err) {
      defaultsParseError = err.message;
    }
  }

  const pass = floored && defaultedDenied && !defaultsParseError;
  const detailParts = [
    `PAPERCLIP_HIDDEN_SETTINGS includes ${flooredKey}: ${floored}`,
    `PAPERCLIP_SETTING_DEFAULTS.feedbackDataSharingPreference === "denied": ${defaultedDenied}`,
  ];
  if (defaultsParseError) detailParts.push(`PAPERCLIP_SETTING_DEFAULTS is not valid JSON: ${defaultsParseError}`);
  return finding(
    "feedback-sharing-env",
    "Feedback-trace sharing defaulted denied and floored (env belt)",
    pass,
    detailParts.join("; "),
  );
}

/**
 * Feedback-trace sharing verified against the live instance settings API:
 * the effective value really is denied, and an attempted value-changing
 * write really is rejected. `settingsPayload`/`writeProbe` are null when no
 * live credential was supplied — this check reports skipped, not passed,
 * in that case, per the research notes' warning that a default alone is
 * not proof.
 */
export function checkFeedbackSharingLive(settingsPayload, writeProbeResult) {
  if (settingsPayload === null || writeProbeResult === null) {
    return skipped(
      "feedback-sharing-live",
      "Feedback-trace sharing verified live (effective value + floored write)",
      "no authenticated session was supplied to the posture check; env-only belt-and-braces was checked instead",
    );
  }
  const effectiveDenied = settingsPayload.feedbackDataSharingPreference === "denied";
  const writeRejected =
    writeProbeResult.status === 403 && writeProbeResult.body?.error === "settings_operator_managed";
  const pass = effectiveDenied && writeRejected;
  return finding(
    "feedback-sharing-live",
    "Feedback-trace sharing verified live (effective value + floored write)",
    pass,
    `effective feedbackDataSharingPreference=${JSON.stringify(settingsPayload.feedbackDataSharingPreference)}; write attempt status=${writeProbeResult.status}, error=${JSON.stringify(writeProbeResult.body?.error)}`,
  );
}

/** GET /api/health must report ok. */
export function checkHealth(healthResult) {
  if (healthResult === null) {
    return skipped("health", "Health endpoint reachable and ok", "no health response was supplied");
  }
  const pass = healthResult.status === 200 && healthResult.body?.status === "ok";
  return finding(
    "health",
    "Health endpoint reachable and ok",
    pass,
    `status=${healthResult.status}, body=${JSON.stringify(healthResult.body)}`,
  );
}

/**
 * The actual listening surface must match the intended exposure:
 * Paperclip listens on loopback and/or the tailnet address only (never a
 * bare 0.0.0.0/LAN address), and PostgreSQL listens on loopback only.
 *
 * `sockets` is a list of { command, pid, address, port } as produced by
 * parsing.mjs. `expected` is { paperclipPort, postgresPort, tailscaleAddress }.
 */
export function checkListeningSurface(sockets, expected) {
  const disallowedAddresses = new Set(["0.0.0.0", "::", "*"]);

  const paperclipSockets = sockets.filter((s) => s.port === expected.paperclipPort);
  const postgresSockets = sockets.filter((s) => s.port === expected.postgresPort);

  const paperclipBad = paperclipSockets.filter(
    (s) =>
      disallowedAddresses.has(s.address) ||
      (s.address !== "127.0.0.1" && s.address !== "::1" && s.address !== expected.tailscaleAddress),
  );
  const postgresBad = postgresSockets.filter((s) => s.address !== "127.0.0.1" && s.address !== "::1");

  const paperclipListening = paperclipSockets.length > 0;
  const postgresListening = postgresSockets.length > 0;

  const pass = paperclipListening && postgresListening && paperclipBad.length === 0 && postgresBad.length === 0;

  const detail = [
    `paperclip (port ${expected.paperclipPort}): ${
      paperclipSockets.map((s) => `${s.address}:${s.port}`).join(", ") || "not listening"
    }`,
    `postgres (port ${expected.postgresPort}): ${
      postgresSockets.map((s) => `${s.address}:${s.port}`).join(", ") || "not listening"
    }`,
  ].join("; ");

  return finding("listening-surface", "Listening surface matches tailnet-only + loopback-DB intent", pass, detail);
}

/** Roll every finding up into one report. */
export function buildReport(findings) {
  const failed = findings.filter((f) => f.pass === false);
  const skippedOnes = findings.filter((f) => f.skipped);
  return {
    findings,
    pass: failed.length === 0,
    failed,
    skipped: skippedOnes,
  };
}
