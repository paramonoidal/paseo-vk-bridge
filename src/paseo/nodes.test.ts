import { describe, expect, it } from "vitest";
import { resolveEndpoint } from "./nodes.js";
import { pickFullAccessMode } from "./providers.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

function pairingLink(relay: { endpoint: string; useTls?: boolean }) {
  const offer = { v: 2, serverId: "srv_test", daemonPublicKeyB64: KEY, relay };
  return `https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
}

describe("resolveEndpoint", () => {
  it("connects through the relay with end-to-end encryption for a pairing link", () => {
    const endpoint = resolveEndpoint({
      pairing: pairingLink({ endpoint: "relay.paseo.sh:443", useTls: true }),
    });
    expect(endpoint.e2ee).toEqual({ enabled: true, daemonPublicKeyB64: KEY });
    const url = new URL(endpoint.url);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("relay.paseo.sh");
    expect(url.searchParams.get("serverId")).toBe("srv_test");
    expect(url.searchParams.get("role")).toBe("client");
    expect(endpoint.via).toBe("relay relay.paseo.sh:443");
  });

  it("reads relay:// URIs with their password", () => {
    const endpoint = resolveEndpoint({
      pairing: `relay://relay.example.com:8443/srv_x?key=${encodeURIComponent(KEY)}&ssl=true&password=pw`,
    });
    expect(endpoint.password).toBe("pw");
    expect(new URL(endpoint.url).host).toBe("relay.example.com:8443");
  });

  it("accepts host:port and full WebSocket URLs", () => {
    expect(resolveEndpoint({ url: "100.64.0.2:6767", password: "p" })).toMatchObject({
      url: "ws://100.64.0.2:6767/ws",
      password: "p",
      via: "100.64.0.2:6767",
    });
    expect(resolveEndpoint({ url: "wss://paseo.example.com/ws" }).url).toBe(
      "wss://paseo.example.com/ws",
    );
  });

  it("rejects something that is not a pairing link", () => {
    expect(() => resolveEndpoint({ pairing: "https://example.com/nothing" })).toThrow();
  });
});

describe("pickFullAccessMode", () => {
  it("prefers known full-access mode IDs, then matching labels", () => {
    expect(
      pickFullAccessMode([{ id: "default" }, { id: "acceptEdits" }, { id: "bypassPermissions" }]),
    ).toBe("bypassPermissions");
    expect(pickFullAccessMode([{ id: "read-only" }, { id: "auto" }, { id: "full-access" }])).toBe(
      "full-access",
    );
    expect(
      pickFullAccessMode([
        { id: "build", label: "Build" },
        { id: "x", label: "YOLO" },
      ]),
    ).toBe("x");
    expect(pickFullAccessMode([{ id: "default" }])).toBeUndefined();
    expect(pickFullAccessMode(undefined)).toBeUndefined();
  });
});
