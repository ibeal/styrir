import test from "node:test";
import assert from "node:assert/strict";
import { parseProcEnviron, extractKnownEnvVars, parseLsofListenOutput, parseSsListenOutput } from "./parsing.mjs";

test("parseProcEnviron splits NUL-separated KEY=VALUE records", () => {
  const buf = Buffer.from("FOO=bar\0BAZ=qux=with=equals\0EMPTY=\0", "utf8");
  const env = parseProcEnviron(buf);
  assert.deepEqual(env, { FOO: "bar", BAZ: "qux=with=equals", EMPTY: "" });
});

test("parseProcEnviron accepts a plain string too", () => {
  const env = parseProcEnviron("A=1\0B=2\0");
  assert.deepEqual(env, { A: "1", B: "2" });
});

test("extractKnownEnvVars pulls only the requested names out of a ps eww line", () => {
  const line =
    "/usr/bin/node server.js PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=tailnet PATH=/usr/bin:/bin HOME=/root";
  const found = extractKnownEnvVars(line, ["PAPERCLIP_DEPLOYMENT_MODE", "PAPERCLIP_BIND", "NOT_PRESENT"]);
  assert.deepEqual(found, {
    PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
    PAPERCLIP_BIND: "tailnet",
  });
});

test("extractKnownEnvVars handles compact JSON values without spaces", () => {
  const line = 'node server.js PAPERCLIP_SETTING_DEFAULTS={"feedbackDataSharingPreference":"denied"} PATH=/bin';
  const found = extractKnownEnvVars(line, ["PAPERCLIP_SETTING_DEFAULTS"]);
  assert.equal(found.PAPERCLIP_SETTING_DEFAULTS, '{"feedbackDataSharingPreference":"denied"}');
});

test("parseLsofListenOutput parses standard lsof LISTEN rows", () => {
  const text = [
    "COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "node    12345   ian    23u  IPv4 0x1234      0t0  TCP 127.0.0.1:3100 (LISTEN)",
    "node    12345   ian    24u  IPv6 0x5678      0t0  TCP 100.64.1.2:3100 (LISTEN)",
    "postgres 999    ian    7u   IPv4 0x9999      0t0  TCP 127.0.0.1:5432 (LISTEN)",
  ].join("\n");
  const sockets = parseLsofListenOutput(text);
  assert.equal(sockets.length, 3);
  assert.deepEqual(sockets[0], { command: "node", pid: 12345, protocol: "tcp", address: "127.0.0.1", port: 3100 });
  assert.deepEqual(sockets[2], { command: "postgres", pid: 999, protocol: "tcp", address: "127.0.0.1", port: 5432 });
});

test("parseLsofListenOutput returns empty list for empty input", () => {
  assert.deepEqual(parseLsofListenOutput(""), []);
});

test("parseSsListenOutput parses ss -ltnp rows", () => {
  const text = [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port  Process",
    "LISTEN 0      128    127.0.0.1:5432      0.0.0.0:*          users:((\"postgres\",pid=999,fd=7))",
    "LISTEN 0      128    100.64.1.2:3100     0.0.0.0:*          users:((\"node\",pid=12345,fd=23))",
  ].join("\n");
  const sockets = parseSsListenOutput(text);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].address, "127.0.0.1");
  assert.equal(sockets[0].port, 5432);
  assert.equal(sockets[0].pid, 999);
  assert.equal(sockets[1].address, "100.64.1.2");
  assert.equal(sockets[1].port, 3100);
});
