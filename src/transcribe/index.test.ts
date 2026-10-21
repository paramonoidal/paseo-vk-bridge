import { describe, expect, it } from "vitest";
import { CommandTranscriber, createTranscriber, TranscriptionError } from "./index.js";

const audio = { bytes: new Uint8Array([1, 2, 3]), fileName: "voice.ogg", mimeType: "audio/ogg" };

describe("OpenAI-compatible transcription", () => {
  it("uploads the audio with the model and language", async () => {
    let request: { url: string; form: FormData; headers: RequestInit["headers"] } | undefined;
    const fetch = (async (url: string, init: RequestInit) => {
      request = { url, form: init.body as FormData, headers: init.headers };
      return new Response(JSON.stringify({ text: " привет мир " }));
    }) as unknown as typeof globalThis.fetch;
    const transcriber = createTranscriber(
      {
        kind: "openai",
        baseUrl: "https://api.groq.com/openai/v1/",
        apiKey: "key",
        model: "whisper-large-v3",
        language: "ru",
        timeoutSeconds: 10,
      },
      { fetch },
    );
    await expect(transcriber?.transcribe(audio)).resolves.toBe("привет мир");
    expect(request?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(request?.headers).toEqual({ authorization: "Bearer key" });
    expect(request?.form.get("model")).toBe("whisper-large-v3");
    expect(request?.form.get("language")).toBe("ru");
    const file = request?.form.get("file") as File;
    expect(file.name).toBe("voice.ogg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio.bytes);
  });

  it("reports HTTP errors", async () => {
    const fetch = (async () =>
      new Response("bad key", { status: 401 })) as unknown as typeof globalThis.fetch;
    const transcriber = createTranscriber(
      { kind: "openai", baseUrl: "https://x/v1", model: "m", timeoutSeconds: 5 },
      { fetch },
    );
    await expect(transcriber?.transcribe(audio)).rejects.toThrow(/HTTP 401 bad key/);
  });
});

describe("command transcription", () => {
  it("passes the audio file and reads the text from stdout", async () => {
    const script =
      "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);process.stdout.write(' bytes='+b.length+'\\n')";
    const transcriber = new CommandTranscriber([process.execPath, "-e", script, "{file}"], 10_000);
    await expect(transcriber.transcribe(audio)).resolves.toBe("bytes=3");
  });

  it("reports a failing command", async () => {
    const transcriber = new CommandTranscriber(
      [process.execPath, "-e", "process.stderr.write('no model');process.exit(2)"],
      10_000,
    );
    await expect(transcriber.transcribe(audio)).rejects.toBeInstanceOf(TranscriptionError);
    await expect(transcriber.transcribe(audio)).rejects.toThrow(/no model/);
  });

  it("is off when not configured", () => {
    expect(createTranscriber({ kind: "none" })).toBeNull();
  });
});
