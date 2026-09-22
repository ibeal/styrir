// Pure parsers: raw text/bytes in, structured data out. No process spawning,
// no network, no filesystem access — those live only in posture-check.mjs so
// this module is fully unit-testable.

/**
 * Parse `/proc/<pid>/environ` bytes (NUL-separated KEY=VALUE records) into
 * a plain object. Used on Linux.
 */
export function parseProcEnviron(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const env = {};
  for (const record of text.split("\0")) {
    if (record === "") continue;
    const eq = record.indexOf("=");
    if (eq === -1) continue;
    env[record.slice(0, eq)] = record.slice(eq + 1);
  }
  return env;
}

/**
 * Best-effort extraction of specific known env vars from `ps eww` /
 * `ps -Eww` output. macOS/BSD ps has no `/proc`; it appends the process
 * environment to the command line instead, space-separated, with no
 * reliable quoting guarantee. We only look for exact `NAME=` tokens for a
 * caller-supplied allowlist of variable names, and take everything up to
 * the next ` NAME=`-shaped token or end of string. This is sufficient for
 * the fixed, space-free values this deployment sets (mode names, compact
 * JSON, hex secrets) and deliberately does not try to be a general env
 * parser.
 */
export function extractKnownEnvVars(psOutputLine, varNames) {
  const found = {};
  for (const name of varNames) {
    const marker = `${name}=`;
    const start = psOutputLine.indexOf(marker);
    if (start === -1) continue;
    const valueStart = start + marker.length;
    // Find the next occurrence of ` SOMENAME=` (any of our known var names,
    // or a generic `WORD=` token) to bound this value.
    const rest = psOutputLine.slice(valueStart);
    const nextVarMatch = rest.match(/\s[A-Za-z_][A-Za-z0-9_]*=/);
    const value = nextVarMatch ? rest.slice(0, nextVarMatch.index) : rest.trimEnd();
    found[name] = value;
  }
  return found;
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN` output into a list of
 * { command, pid, protocol, address, port }.
 */
export function parseLsofListenOutput(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const [, ...rows] = lines; // drop header row
  const sockets = [];
  for (const row of rows) {
    const cols = row.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const command = cols[0];
    const pid = cols[1];
    // NAME is the 9th column onward; lsof writes it as e.g.
    // "127.0.0.1:5432 (LISTEN)", which whitespace-splitting breaks in two.
    const name = cols.slice(8).join(" ");
    // name looks like "127.0.0.1:5432 (LISTEN)" or "*:3100 (LISTEN)" or
    // "[::1]:3100 (LISTEN)"
    const m = name.match(/^(.*):(\d+)\s*\(LISTEN\)$/);
    if (!m) continue;
    sockets.push({
      command,
      pid: Number(pid),
      protocol: "tcp",
      address: m[1],
      port: Number(m[2]),
    });
  }
  return sockets;
}

/**
 * Parse `ss -ltnp` (Linux) output into the same shape as parseLsofListenOutput.
 */
export function parseSsListenOutput(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const sockets = [];
  for (const line of lines) {
    if (line.startsWith("State")) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const localAddrPort = cols[3];
    const lastColon = localAddrPort.lastIndexOf(":");
    if (lastColon === -1) continue;
    const address = localAddrPort.slice(0, lastColon).replace(/^\[|\]$/g, "");
    const port = Number(localAddrPort.slice(lastColon + 1));
    const procMatch = line.match(/pid=(\d+)/);
    sockets.push({
      command: null,
      pid: procMatch ? Number(procMatch[1]) : null,
      protocol: "tcp",
      address,
      port,
    });
  }
  return sockets;
}
