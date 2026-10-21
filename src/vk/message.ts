/** First peer ID of a group conversation; smaller positive IDs are direct messages. */
const CHAT_PEER_OFFSET = 2_000_000_000;
const MAX_ATTACHMENTS = 10;

export interface VkPhoto {
  url: string;
}

export interface VkDocument {
  url: string;
  title: string;
  size: number | null;
}

export interface VkVoice {
  url: string;
  mimeType: "audio/ogg" | "audio/mpeg";
  durationSeconds: number | null;
  /** VK's own recognition, when the community has it. */
  vkTranscript: string | null;
}

export interface VkInboundMessage {
  id: number;
  peerId: number;
  fromId: number;
  text: string;
  photos: VkPhoto[];
  documents: VkDocument[];
  voice: VkVoice | null;
  /** Text of forwarded messages and of the message this one replies to. */
  quoted: string[];
  /** Attachment types the bridge cannot pass on (stickers, videos, …). */
  unsupported: string[];
  /** Button payload, e.g. `{"command":"start"}` from VK's Start button. */
  payload: string | null;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function eventId(event: unknown): string | null {
  const root = record(event);
  if (!root) return null;
  const id = str(root.event_id);
  if (id) return id;
  const messageId = num(record(record(root.object)?.message)?.id);
  return messageId === null ? null : `message:${messageId}`;
}

/** Extracts an incoming direct message from a Long Poll `message_new` event. */
export function parseMessageNew(event: unknown, groupId: number): VkInboundMessage | null {
  const root = record(event);
  if (!root || root.type !== "message_new" || num(root.group_id) !== groupId) return null;
  const message = record(record(root.object)?.message);
  if (!message) return null;
  const id = num(message.id);
  const peerId = num(message.peer_id);
  const fromId = num(message.from_id);
  if (id === null || peerId === null || fromId === null) return null;
  if (num(message.out) === 1 || fromId <= 0) return null;

  const parsed: VkInboundMessage = {
    id,
    peerId,
    fromId,
    text: str(message.text) ?? "",
    photos: [],
    documents: [],
    voice: null,
    quoted: [],
    unsupported: [],
    payload: str(message.payload),
  };

  const attachments: unknown[] = Array.isArray(message.attachments) ? [...message.attachments] : [];
  const related: unknown[] = [
    ...(Array.isArray(message.fwd_messages) ? message.fwd_messages : []),
    ...(message.reply_message ? [message.reply_message] : []),
  ];
  for (const item of related.slice(0, MAX_ATTACHMENTS)) {
    const quotedMessage = record(item);
    if (!quotedMessage) continue;
    const text = str(quotedMessage.text);
    if (text) parsed.quoted.push(text);
    if (Array.isArray(quotedMessage.attachments)) attachments.push(...quotedMessage.attachments);
  }

  for (const item of attachments.slice(0, MAX_ATTACHMENTS)) {
    const attachment = record(item);
    const type = str(attachment?.type);
    if (!attachment || !type) continue;
    const body = record(attachment[type]);
    switch (type) {
      case "photo": {
        const url = largestPhotoUrl(body);
        if (url) parsed.photos.push({ url });
        break;
      }
      case "doc": {
        const url = str(body?.url);
        if (url) {
          parsed.documents.push({
            url,
            title: str(body?.title) ?? "document",
            size: num(body?.size),
          });
        }
        break;
      }
      case "audio_message": {
        const ogg = str(body?.link_ogg);
        const mp3 = str(body?.link_mp3);
        const url = ogg ?? mp3;
        if (url && parsed.voice === null) {
          parsed.voice = {
            url,
            mimeType: ogg ? "audio/ogg" : "audio/mpeg",
            durationSeconds: num(body?.duration),
            vkTranscript:
              (num(body?.transcript_error) ?? 0) === 0
                ? (str(body?.transcript)?.trim() ?? null)
                : null,
          };
        }
        break;
      }
      default:
        parsed.unsupported.push(type);
    }
  }
  return parsed;
}

function largestPhotoUrl(photo: Json | null): string | null {
  const sizes = Array.isArray(photo?.sizes) ? photo.sizes : [];
  let best: { url: string; area: number } | null = null;
  for (const size of sizes) {
    const entry = record(size);
    const url = str(entry?.url);
    if (!url) continue;
    const area = (num(entry?.width) ?? 0) * (num(entry?.height) ?? 0);
    if (!best || area > best.area) best = { url, area };
  }
  return best?.url ?? str(photo?.orig_photo && record(photo.orig_photo)?.url);
}

export function isDirectMessage(message: VkInboundMessage): boolean {
  return message.peerId < CHAT_PEER_OFFSET && message.peerId === message.fromId;
}
