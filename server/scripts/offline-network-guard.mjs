// Preload with node --import before any app module. The fixture API, database,
// and fetch client may use loopback; every other socket/fetch is rejected.
import net from "node:net";

const permitted = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
globalThis.__package1Outbound = { blocked: 0 };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() and the HTTP clients pass [options, callback] as a single
  // normalized argument. Inspect its options rather than treating the array
  // as an object with a missing host (which would allow every destination).
  const parameters = Array.isArray(args[0]) ? args[0] : args;
  const target = parameters[0];
  let host;
  if (typeof target === "object" && target !== null && !target.path && target.port !== undefined) {
    host = target.host || target.hostname || "localhost";
  } else if (typeof target === "number") {
    host = typeof parameters[1] === "string" ? parameters[1] : "localhost";
  }
  // Unknown forms and Unix sockets are unnecessary for this TCP fixture.
  if (!permitted.has(host)) {
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
