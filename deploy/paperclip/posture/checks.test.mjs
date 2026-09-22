import test from "node:test";
import assert from "node:assert/strict";
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

test("checkDeploymentPosture passes only for authenticated+private+tailnet", () => {
  assert.equal(
    checkDeploymentPosture({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      PAPERCLIP_BIND: "tailnet",
    }).pass,
    true,
  );
  assert.equal(checkDeploymentPosture({}).pass, false);
  assert.equal(
    checkDeploymentPosture({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      PAPERCLIP_BIND: "lan",
    }).pass,
    false,
  );
  assert.equal(
    checkDeploymentPosture({
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      PAPERCLIP_BIND: "tailnet",
    }).pass,
    false,
  );
});

test("checkTelemetryDisabled accepts 1 or true, rejects unset/other", () => {
  assert.equal(checkTelemetryDisabled({ PAPERCLIP_TELEMETRY_DISABLED: "1" }).pass, true);
  assert.equal(checkTelemetryDisabled({ PAPERCLIP_TELEMETRY_DISABLED: "true" }).pass, true);
  assert.equal(checkTelemetryDisabled({}).pass, false);
  assert.equal(checkTelemetryDisabled({ PAPERCLIP_TELEMETRY_DISABLED: "0" }).pass, false);
});

test("checkTelemetryConfigFile skips when null, checks telemetry.enabled===false otherwise", () => {
  assert.equal(checkTelemetryConfigFile(null).skipped, true);
  assert.equal(checkTelemetryConfigFile(null).pass, null);
  assert.equal(checkTelemetryConfigFile({ telemetry: { enabled: false } }).pass, true);
  assert.equal(checkTelemetryConfigFile({ telemetry: { enabled: true } }).pass, false);
  assert.equal(checkTelemetryConfigFile({}).pass, false);
});

test("checkNoTracingOrCrashReporting fails if any Sentry/OTel var is set", () => {
  assert.equal(checkNoTracingOrCrashReporting({}).pass, true);
  assert.equal(checkNoTracingOrCrashReporting({ SENTRY_DSN: "https://x" }).pass, false);
  assert.equal(checkNoTracingOrCrashReporting({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x" }).pass, false);
});

test("checkNoProviderCredentials fails if any model-provider key is present", () => {
  assert.equal(checkNoProviderCredentials({}).pass, true);
  assert.equal(checkNoProviderCredentials({ ANTHROPIC_API_KEY: "sk-x" }).pass, false);
  assert.equal(checkNoProviderCredentials({ OPENAI_API_KEY: "" }).pass, true); // empty string is falsy
});

test("checkFeedbackSharingEnvConfig requires both the floor and the denied default", () => {
  const good = checkFeedbackSharingEnvConfig({
    PAPERCLIP_HIDDEN_SETTINGS: "instance.general.feedbackDataSharingPreference",
    PAPERCLIP_SETTING_DEFAULTS: '{"feedbackDataSharingPreference":"denied"}',
  });
  assert.equal(good.pass, true);

  const missingFloor = checkFeedbackSharingEnvConfig({
    PAPERCLIP_SETTING_DEFAULTS: '{"feedbackDataSharingPreference":"denied"}',
  });
  assert.equal(missingFloor.pass, false);

  const wrongDefault = checkFeedbackSharingEnvConfig({
    PAPERCLIP_HIDDEN_SETTINGS: "instance.general.feedbackDataSharingPreference",
    PAPERCLIP_SETTING_DEFAULTS: '{"feedbackDataSharingPreference":"allowed"}',
  });
  assert.equal(wrongDefault.pass, false);

  const malformed = checkFeedbackSharingEnvConfig({
    PAPERCLIP_HIDDEN_SETTINGS: "instance.general.feedbackDataSharingPreference",
    PAPERCLIP_SETTING_DEFAULTS: "{not json",
  });
  assert.equal(malformed.pass, false);

  const multiValueList = checkFeedbackSharingEnvConfig({
    PAPERCLIP_HIDDEN_SETTINGS: "instance.access, instance.general.feedbackDataSharingPreference",
    PAPERCLIP_SETTING_DEFAULTS: '{"feedbackDataSharingPreference":"denied"}',
  });
  assert.equal(multiValueList.pass, true);
});

test("checkFeedbackSharingLive skips without live data, verifies effective value + rejected write otherwise", () => {
  assert.equal(checkFeedbackSharingLive(null, null).skipped, true);

  const passing = checkFeedbackSharingLive(
    { feedbackDataSharingPreference: "denied" },
    { status: 403, body: { error: "settings_operator_managed" } },
  );
  assert.equal(passing.pass, true);

  const wrongValue = checkFeedbackSharingLive(
    { feedbackDataSharingPreference: "allowed" },
    { status: 403, body: { error: "settings_operator_managed" } },
  );
  assert.equal(wrongValue.pass, false);

  const writeSucceeded = checkFeedbackSharingLive(
    { feedbackDataSharingPreference: "denied" },
    { status: 200, body: { feedbackDataSharingPreference: "allowed" } },
  );
  assert.equal(writeSucceeded.pass, false);
});

test("checkHealth requires 200 + status ok", () => {
  assert.equal(checkHealth(null).skipped, true);
  assert.equal(checkHealth({ status: 200, body: { status: "ok" } }).pass, true);
  assert.equal(checkHealth({ status: 500, body: null }).pass, false);
  assert.equal(checkHealth({ status: 200, body: { status: "degraded" } }).pass, false);
});

test("checkListeningSurface passes for loopback+tailnet paperclip and loopback-only postgres", () => {
  const sockets = [
    { command: "node", pid: 111, address: "127.0.0.1", port: 3100 },
    { command: "node", pid: 111, address: "100.64.1.2", port: 3100 },
    { command: "postgres", pid: 222, address: "127.0.0.1", port: 5432 },
  ];
  const pass = checkListeningSurface(sockets, {
    paperclipPort: 3100,
    postgresPort: 5432,
    tailscaleAddress: "100.64.1.2",
  });
  assert.equal(pass.pass, true);
});

test("checkListeningSurface fails if paperclip is bound to 0.0.0.0", () => {
  const sockets = [
    { command: "node", pid: 111, address: "0.0.0.0", port: 3100 },
    { command: "postgres", pid: 222, address: "127.0.0.1", port: 5432 },
  ];
  const result = checkListeningSurface(sockets, {
    paperclipPort: 3100,
    postgresPort: 5432,
    tailscaleAddress: "100.64.1.2",
  });
  assert.equal(result.pass, false);
});

test("checkListeningSurface fails if postgres is bound beyond loopback", () => {
  const sockets = [
    { command: "node", pid: 111, address: "127.0.0.1", port: 3100 },
    { command: "postgres", pid: 222, address: "0.0.0.0", port: 5432 },
  ];
  const result = checkListeningSurface(sockets, {
    paperclipPort: 3100,
    postgresPort: 5432,
    tailscaleAddress: "100.64.1.2",
  });
  assert.equal(result.pass, false);
});

test("checkListeningSurface fails if paperclip is not listening at all", () => {
  const sockets = [{ command: "postgres", pid: 222, address: "127.0.0.1", port: 5432 }];
  const result = checkListeningSurface(sockets, {
    paperclipPort: 3100,
    postgresPort: 5432,
    tailscaleAddress: "100.64.1.2",
  });
  assert.equal(result.pass, false);
});

test("buildReport aggregates pass/fail/skip correctly", () => {
  const report = buildReport([
    { id: "a", pass: true, skipped: false },
    { id: "b", pass: false, skipped: false },
    { id: "c", pass: null, skipped: true },
  ]);
  assert.equal(report.pass, false);
  assert.equal(report.failed.length, 1);
  assert.equal(report.skipped.length, 1);
});
