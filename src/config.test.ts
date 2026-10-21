import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.js";

const base = {
  vk: { token: "${VK_TOKEN}", groupId: 1, allowlist: [5] },
  nodes: { laptop: { url: "localhost:6767", cwd: "/home/me/code" } },
};

describe("parseConfig", () => {
  it("expands environment variables and fills defaults", () => {
    const config = parseConfig(base, { VK_TOKEN: "secret" });
    expect(config.vk.token).toBe("secret");
    expect(config.vk.textChunkLimit).toBe(4000);
    expect(config.defaults).toEqual({ provider: "codex", modes: {}, busy: "steer" });
    expect(config.feed).toEqual({ actions: true, flushAfterSeconds: 45 });
    expect(config.transcription).toEqual({ kind: "none" });
  });

  it("fails on a missing variable", () => {
    expect(() => parseConfig(base, {})).toThrow(/VK_TOKEN is not set/);
  });

  it("requires exactly one of pairing or url per node", () => {
    expect(() =>
      parseConfig({ ...base, nodes: { a: { url: "x:1", pairing: "y" } } }, { VK_TOKEN: "t" }),
    ).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, nodes: { a: {} } }, { VK_TOKEN: "t" })).toThrow(
      /exactly one of/,
    );
  });

  it("checks the default node and unknown keys", () => {
    expect(() => parseConfig({ ...base, defaults: { node: "server" } }, { VK_TOKEN: "t" })).toThrow(
      /unknown node "server"/,
    );
    expect(() => parseConfig({ ...base, extra: true }, { VK_TOKEN: "t" })).toThrow(ConfigError);
  });

  it("accepts transcription backends", () => {
    const config = parseConfig(
      { ...base, transcription: { kind: "openai", apiKey: "k", language: "ru" } },
      { VK_TOKEN: "t" },
    );
    expect(config.transcription).toMatchObject({
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
      language: "ru",
    });
  });
});
