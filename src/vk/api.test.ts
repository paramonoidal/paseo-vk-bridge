import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttachmentTooLargeError,
  isTrustedVkHost,
  VkApi,
  VkApiError,
  VkTransportError,
} from "./api.js";

function fakeFetch(responses: Array<unknown | Error>) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const noSleep = async () => {};

describe("VkApi.call", () => {
  it("posts the token and version and unwraps the response", async () => {
    const { fetch, calls } = fakeFetch([{ response: 123 }]);
    const api = new VkApi({ token: "secret", groupId: 1, fetch, sleep: noSleep });
    await expect(api.call("utils.getServerTime", { a: 1, b: true, c: undefined })).resolves.toBe(
      123,
    );
    expect(calls[0]?.url).toBe("https://api.vk.com/method/utils.getServerTime");
    expect(Object.fromEntries(calls[0]?.body ?? [])).toEqual({
      a: "1",
      b: "1",
      access_token: "secret",
      v: "5.199",
    });
  });

  it("maps VK errors without echoing the request", async () => {
    const { fetch } = fakeFetch([
      {
        error: {
          error_code: 901,
          error_msg: "Can't send messages",
          request_params: [{ key: "access_token", value: "secret" }],
        },
      },
    ]);
    const api = new VkApi({ token: "secret", groupId: 1, fetch, sleep: noSleep });
    const error = await api.call("messages.send").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VkApiError);
    expect((error as VkApiError).code).toBe(901);
    expect((error as Error).message).not.toContain("secret");
  });
});

describe("VkApi.sendMessage", () => {
  it("retries transient failures with the same random_id", async () => {
    const { fetch, calls } = fakeFetch([
      new TypeError("socket hang up"),
      { error: { error_code: 10, error_msg: "Internal server error" } },
      { response: 77 },
    ]);
    const api = new VkApi({ token: "t", groupId: 1, fetch, sleep: noSleep });
    await expect(api.sendMessage({ peerId: 5, text: "hi" })).resolves.toBe(77);
    const ids = calls.map((call) => call.body.get("random_id"));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(calls[0]?.body.get("dont_parse_links")).toBe("1");
  });

  it("does not retry permanent errors", async () => {
    const { fetch, calls } = fakeFetch([{ error: { error_code: 901, error_msg: "no" } }]);
    const api = new VkApi({ token: "t", groupId: 1, fetch, sleep: noSleep });
    await expect(api.sendMessage({ peerId: 5, text: "hi" })).rejects.toBeInstanceOf(VkApiError);
    expect(calls).toHaveLength(1);
  });
});

describe("VkApi.download", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function serve(handler: Parameters<typeof createServer>[1]) {
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("follows redirects only to trusted hosts and enforces the size limit", async () => {
    const base = await serve((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/file" }).end();
      } else if (request.url === "/away") {
        response.writeHead(302, { location: "http://evil.example/x" }).end();
      } else {
        response.writeHead(200, { "content-type": "text/plain" }).end("hello");
      }
    });
    const api = new VkApi({
      token: "t",
      groupId: 1,
      trustHost: (host) => host === "127.0.0.1",
      allowHttp: true,
    });
    const file = await api.download(`${base}/start`, 100);
    expect(Buffer.from(file.bytes).toString()).toBe("hello");
    expect(file.contentType).toBe("text/plain");
    await expect(api.download(`${base}/away`, 100)).rejects.toBeInstanceOf(VkTransportError);
    await expect(api.download(`${base}/file`, 3)).rejects.toBeInstanceOf(AttachmentTooLargeError);
  });

  it("refuses untrusted and plain-HTTP URLs by default", async () => {
    const api = new VkApi({ token: "t", groupId: 1 });
    await expect(api.download("https://example.com/x", 10)).rejects.toThrow(/untrusted/);
    await expect(api.download("http://vk.com/x", 10)).rejects.toThrow(/http:/);
  });
});

describe("isTrustedVkHost", () => {
  it("accepts VK domains and their subdomains only", () => {
    expect(isTrustedVkHost("sun9-1.userapi.com")).toBe(true);
    expect(isTrustedVkHost("vk.com")).toBe(true);
    expect(isTrustedVkHost("evilvk.com")).toBe(false);
    expect(isTrustedVkHost("vk.com.evil.io")).toBe(false);
  });
});
