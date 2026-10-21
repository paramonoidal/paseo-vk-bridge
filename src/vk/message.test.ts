import { describe, expect, it } from "vitest";
import { eventId, isDirectMessage, parseMessageNew } from "./message.js";

function event(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: "message_new",
    event_id: "e1",
    group_id: 7,
    object: { message: { id: 10, peer_id: 42, from_id: 42, text: "hi", out: 0, ...message } },
    ...extra,
  };
}

describe("parseMessageNew", () => {
  it("reads text, photos, documents, voice and quoted messages", () => {
    const parsed = parseMessageNew(
      event({
        attachments: [
          {
            type: "photo",
            photo: {
              sizes: [
                { url: "https://sun.userapi.com/s.jpg", width: 10, height: 10 },
                { url: "https://sun.userapi.com/l.jpg", width: 100, height: 80 },
              ],
            },
          },
          { type: "doc", doc: { url: "https://vk.com/doc1", title: "log.txt", size: 12 } },
          {
            type: "audio_message",
            audio_message: {
              link_ogg: "https://psv4.vkuseraudio.net/v.ogg",
              link_mp3: "https://psv4.vkuseraudio.net/v.mp3",
              duration: 3,
              transcript: " привет ",
            },
          },
          { type: "sticker", sticker: {} },
        ],
        fwd_messages: [{ text: "forwarded", attachments: [] }],
        reply_message: { text: "replied to" },
      }),
      7,
    );
    expect(parsed).toMatchObject({
      id: 10,
      peerId: 42,
      text: "hi",
      photos: [{ url: "https://sun.userapi.com/l.jpg" }],
      documents: [{ url: "https://vk.com/doc1", title: "log.txt", size: 12 }],
      voice: {
        url: "https://psv4.vkuseraudio.net/v.ogg",
        mimeType: "audio/ogg",
        durationSeconds: 3,
        vkTranscript: "привет",
      },
      quoted: ["forwarded", "replied to"],
      unsupported: ["sticker"],
    });
    expect(isDirectMessage(parsed!)).toBe(true);
  });

  it("ignores other communities, outgoing messages and other event types", () => {
    expect(parseMessageNew(event({}), 8)).toBeNull();
    expect(parseMessageNew(event({ out: 1 }), 7)).toBeNull();
    expect(parseMessageNew({ ...event({}), type: "message_reply" }, 7)).toBeNull();
  });

  it("recognizes group conversations", () => {
    const parsed = parseMessageNew(event({ peer_id: 2_000_000_001 }), 7);
    expect(parsed && isDirectMessage(parsed)).toBe(false);
  });
});

describe("eventId", () => {
  it("uses event_id, then the message ID", () => {
    expect(eventId(event({}))).toBe("e1");
    expect(eventId({ ...event({}), event_id: undefined })).toBe("message:10");
    expect(eventId({})).toBeNull();
  });
});
