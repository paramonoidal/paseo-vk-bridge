import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TranscriptionConfig } from "../config.js";

export interface Audio {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}

export interface Transcriber {
  transcribe(audio: Audio): Promise<string>;
}

export class TranscriptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TranscriptionError";
  }
}

export function createTranscriber(
  config: TranscriptionConfig,
  options: { fetch?: typeof fetch } = {},
): Transcriber | null {
  switch (config.kind) {
    case "openai":
      return new OpenAiTranscriber(config, options.fetch ?? globalThis.fetch);
    case "command":
      return new CommandTranscriber(config.command, config.timeoutSeconds * 1000);
    case "none":
      return null;
  }
}

/** `POST /audio/transcriptions` on any OpenAI-compatible server. */
export class OpenAiTranscriber implements Transcriber {
  constructor(
    private readonly config: Extract<TranscriptionConfig, { kind: "openai" }>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async transcribe(audio: Audio): Promise<string> {
    const form = new FormData();
    form.set("file", new Blob([audio.bytes], { type: audio.mimeType }), audio.fileName);
    form.set("model", this.config.model);
    form.set("response_format", "json");
    if (this.config.language) form.set("language", this.config.language);
    if (this.config.prompt) form.set("prompt", this.config.prompt);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, "")}/audio/transcriptions`,
        {
          method: "POST",
          headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
          body: form,
          signal: AbortSignal.timeout(this.config.timeoutSeconds * 1000),
        },
      );
    } catch (error) {
      throw new TranscriptionError("transcription request failed", { cause: error });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new TranscriptionError(
        `transcription returned HTTP ${response.status} ${detail}`.trim(),
      );
    }
    const body = (await response.json()) as { text?: unknown };
    if (typeof body.text !== "string") {
      throw new TranscriptionError("transcription response has no text");
    }
    return body.text.trim();
  }
}

/**
 * Runs a local program, for offline recognition such as whisper.cpp. `{file}` in the
 * argv becomes the path of the audio file; the program prints the text.
 */
export class CommandTranscriber implements Transcriber {
  constructor(
    private readonly argv: readonly string[],
    private readonly timeoutMs: number,
  ) {}

  async transcribe(audio: Audio): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-vk-voice-"));
    const file = path.join(directory, audio.fileName.replace(/[^\w.-]/g, "_"));
    try {
      await writeFile(file, audio.bytes);
      const [command, ...args] = this.argv.map((part) => part.replaceAll("{file}", file));
      if (!command) throw new TranscriptionError("transcription command is empty");
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          command,
          args,
          { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
          (error, out, err) => {
            if (error) {
              reject(
                new TranscriptionError(
                  `transcription command failed: ${(err || error.message).trim().slice(0, 300)}`,
                  { cause: error },
                ),
              );
            } else {
              resolve(out);
            }
          },
        );
      });
      return stdout.trim();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
