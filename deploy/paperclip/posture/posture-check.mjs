#!/usr/bin/env node
// Posture check CLI: gathers live data (HTTP, process env, listening
// sockets) and hands it to the pure checks in checks.mjs. This file is
// deliberately thin glue — only checks.mjs and parsing.mjs are unit
// tested, because this file is the untestable part (real network/process
// inspection) called out in WORK.md.
//
// Usage:
//   node deploy/paperclip/posture/posture-check.mjs [options]
//
// Options (all optional; also settable via env, CLI flag wins):
//   --base-url <url>            default http://127.0.0.1:3100 (POSTURE_BASE_URL)
//   --tailscale-address <ip>    the host's `tailscale ip -4` output (POSTURE_TAILSCALE_ADDRESS)
//   --postgres-port <port>      default 5432 (POSTURE_POSTGRES_PORT)
//   --paperclip-port <port>     default 3100 (POSTURE_PAPERCLIP_PORT)
//   --session-cookie <cookie>   Better Auth session cookie for the live
//                                feedback-sharing verification; obtain by
//                                signing in to the board in a browser and
//                                copying the `Cookie` header from devtools.
//                                Omit to skip the live (but not the env)
//                                feedback-sharing check. (POSTURE_SESSION_COOKIE)
//   --instance-config <path>    path to the running instance's config.json
//                                (POSTURE_INSTANCE_CONFIG), e.g.
//                                ~/.paperclip/instances/default/config.json
//
// Exit code 0 only if every non-skipped check passed. Any skipped check is
// printed loudly; it is not a silent pass.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";
import {
  checkDeploymentPosture,
  checkTelemetryDisabled,
  checkTelemetryConfigFile,
  checkNoTracingOrCrashReporting,
  checkNoProviderCredentials,
  checkFeedbackSharingEnvConfig,
  checkFeedbackSharingLive,
  checkHealth,
  checkListeningSurface,
  buildReport,
} from "./checks.mjs";
import { parseProcEnviron, extractKnownEnvVars, parseLsofListenOutput, parseSsListenOutput } from "./parsing.mjs";

const KNOWN_ENV_VARS = [
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
  "PAPERCLIP_BIND",
  "PAPERCLIP_TELEMETRY_DISABLED",
  "PAPERCLIP_HIDDEN_SETTINGS",
  "PAPERCLIP_SETTING_DEFAULTS",
  "SENTRY_DSN",
  "SENTRY_DSN_FRONTEND",
  "SENTRY_DSN_BACKEND",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.POSTURE_BASE_URL ?? "http://127.0.0.1:3100",
    tailscaleAddress: process.env.POSTURE_TAILSCALE_ADDRESS ?? null,
    postgresPort: Number(process.env.POSTURE_POSTGRES_PORT ?? 5432),
    paperclipPort: Number(process.env.POSTURE_PAPERCLIP_PORT ?? 3100),
    sessionCookie: process.env.POSTURE_SESSION_COOKIE ?? null,
    instanceConfigPath: process.env.POSTURE_INSTANCE_CONFIG ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--base-url":
        opts.baseUrl = next();
        break;
      case "--tailscale-address":
        opts.tailscaleAddress = next();
        break;
      case "--postgres-port":
        opts.postgresPort = Number(next());
        break;
      case "--paperclip-port":
        opts.paperclipPort = Number(next());
        break;
      case "--session-cookie":
        opts.sessionCookie = next();
        break;
      case "--instance-config":
        opts.instanceConfigPath = next();
        break;
      default:
        console.error(`unrecognized argument: ${arg}`);
        process.exit(2);
    }
  }
  return opts;
}

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch {
    return null;
  }
}

function gatherListeningSockets() {
  if (platform() === "linux") {
    const out = tryExec("ss", ["-ltnp"]);
    if (out) return { sockets: parseSsListenOutput(out), tool: "ss" };
  }
  const out = tryExec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  if (out) return { sockets: parseLsofListenOutput(out), tool: "lsof" };
  return { sockets: null, tool: null };
}

function findPidForPort(sockets, port) {
  if (!sockets) return null;
  const match = sockets.find((s) => s.port === port);
  return match ? match.pid : null;
}

function gatherProcessEnv(pid) {
  if (pid === null) return null;
  if (platform() === "linux") {
    try {
      return parseProcEnviron(readFileSync(`/proc/${pid}/environ`));
    } catch {
      return null;
    }
  }
  // macOS/BSD: no /proc. Best-effort scrape of `ps eww`.
  const out = tryExec("ps", ["-Eww", "-o", "command=", "-p", String(pid)]);
  if (!out) return null;
  return extractKnownEnvVars(out, KNOWN_ENV_VARS);
}

async function fetchJson(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body, leave as null
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: null, body: null, error: err.message };
  }
}

function readInstanceConfig(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const { sockets, tool } = gatherListeningSockets();
  const paperclipPid = findPidForPort(sockets, opts.paperclipPort);
  const env = gatherProcessEnv(paperclipPid) ?? {};

  const health = await fetchJson(`${opts.baseUrl}/api/health`);

  let settingsPayload = null;
  let writeProbeResult = null;
  if (opts.sessionCookie) {
    const settingsResult = await fetchJson(`${opts.baseUrl}/api/instance/settings/general`, {
      headers: { Cookie: opts.sessionCookie },
    });
    settingsPayload = settingsResult.body;

    // Probe the floor: attempt to change the value. A correctly floored
    // control must reject this with 403 settings_operator_managed
    // regardless of what value we send.
    const attemptedValue = settingsPayload?.feedbackDataSharingPreference === "allowed" ? "denied" : "allowed";
    writeProbeResult = await fetchJson(`${opts.baseUrl}/api/instance/settings/general`, {
      method: "PATCH",
      headers: { Cookie: opts.sessionCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ feedbackDataSharingPreference: attemptedValue }),
    });
  }

  const instanceConfig = readInstanceConfig(opts.instanceConfigPath);

  const findings = [
    checkDeploymentPosture(env),
    checkTelemetryDisabled(env),
    checkTelemetryConfigFile(instanceConfig),
    checkNoTracingOrCrashReporting(env),
    checkNoProviderCredentials(env),
    checkFeedbackSharingEnvConfig(env),
    checkFeedbackSharingLive(settingsPayload, writeProbeResult),
    checkHealth(health.status === null ? null : health),
    sockets === null
      ? { id: "listening-surface", title: "Listening surface matches tailnet-only + loopback-DB intent", pass: null, skipped: true, detail: "neither ss nor lsof was available to inspect listening sockets" }
      : checkListeningSurface(sockets, {
          paperclipPort: opts.paperclipPort,
          postgresPort: opts.postgresPort,
          tailscaleAddress: opts.tailscaleAddress,
        }),
  ];

  const report = buildReport(findings);

  console.log(`Paperclip posture check (socket tool: ${tool ?? "none available"}, paperclip pid: ${paperclipPid ?? "not found"})`);
  console.log("");
  for (const f of report.findings) {
    const marker = f.skipped ? "SKIP" : f.pass ? "PASS" : "FAIL";
    console.log(`[${marker}] ${f.title}`);
    console.log(`       ${f.detail}`);
  }
  console.log("");
  if (report.skipped.length > 0) {
    console.log(`${report.skipped.length} check(s) skipped — see SKIP lines above; these are not verified, not passed.`);
  }
  console.log(report.pass ? "RESULT: PASS (no failing checks)" : `RESULT: FAIL (${report.failed.length} check(s) failed)`);

  process.exit(report.pass ? 0 : 1);
}

main();
