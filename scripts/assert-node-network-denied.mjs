import { resolve4 } from "node:dns/promises";
import { createSocket } from "node:dgram";
import http from "node:http";
import net from "node:net";

const EXPECTED_NODE_VERSION = "26.8.1";
const TIMEOUT_MS = 2_000;
const PROBE_PORT = 45_678;

if (process.versions.node !== EXPECTED_NODE_VERSION) {
  throw new Error(`Expected Node ${EXPECTED_NODE_VERSION}, received ${process.versions.node}.`);
}
if (!process.permission || process.permission.has("net")) {
  throw new Error("Node network permission must be denied.");
}

function isNetworkDenied(error) {
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current.code === "ERR_ACCESS_DENIED"
      && (current.permission === undefined
        || current.permission === "Net"
        || current.permission === "Network")) return true;
    pending.push(current.cause, current.errno);
  }
  return false;
}

async function expectNetworkDenied(label, attempt) {
  let timer;
  try {
    await Promise.race([
      attempt(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (isNetworkDenied(error)) return;
    throw new Error(`${label} did not fail with Network ERR_ACCESS_DENIED.`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`${label} unexpectedly accessed the network.`);
}

await expectNetworkDenied("net.connect", () => new Promise((resolve, reject) => {
  let socket;
  try {
    socket = net.connect({ host: "127.0.0.1", port: PROBE_PORT });
  } catch (error) {
    reject(error);
    return;
  }
  socket.once("connect", () => {
    socket.destroy();
    resolve();
  });
  socket.once("error", reject);
}));

await expectNetworkDenied("http.get", () => new Promise((resolve, reject) => {
  let request;
  try {
    request = http.get(`http://127.0.0.1:${PROBE_PORT}/`, (response) => {
      response.resume();
      resolve();
    });
  } catch (error) {
    reject(error);
    return;
  }
  request.once("error", reject);
}));

await expectNetworkDenied("fetch", () => fetch(`http://127.0.0.1:${PROBE_PORT}/`));

await expectNetworkDenied("dns.resolve4", () => resolve4("example.com"));

await expectNetworkDenied("dgram.send", () => new Promise((resolve, reject) => {
  const socket = createSocket("udp4");
  socket.once("error", (error) => {
    socket.close();
    reject(error);
  });
  try {
    socket.send(Buffer.from("x"), PROBE_PORT, "127.0.0.1", (error) => {
      socket.close();
      if (error) reject(error);
      else resolve();
    });
  } catch (error) {
    socket.close();
    reject(error);
  }
}));

console.log(`Node ${EXPECTED_NODE_VERSION} denied all network probes.`);
