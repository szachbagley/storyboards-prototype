// Preload with node --import before any app module. The fixture API, database,
// and fetch client may use loopback; every other socket/fetch is rejected.
import net from "node:net";

const permitted = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
globalThis.__package1Outbound = { blocked: 0 };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = args[0];
  const host = typeof target === "object" && target !== null
    ? (target.host ?? target.hostname ?? (target.path ? "localhost" : ""))
    : typeof args[1] === "string" ? args[1] : "";
  // net.connect(port) and some local fetch clients omit host; Node defaults
  // those calls to loopback. Keep the same default while denying named hosts.
  if (host !== "" && !permitted.has(host)) {
    globalThis.__package1Outbound.blocked += 1;
    throw new Error("offline fixture blocked a non-loopback socket");
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const destination = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!permitted.has(destination.hostname)) {
    globalThis.__package1Outbound.blocked += 1;
    throw new Error("offline fixture blocked a non-loopback fetch");
  }
  return originalFetch(input, init);
};
