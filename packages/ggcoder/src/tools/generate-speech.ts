import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";

/**
 * Voiceover for Motion videos. Two providers, chosen by which key is present:
 * - ElevenLabs (`ELEVENLABS_API_KEY`): returns per-character timings, so the
 *   caption file is exact.
 * - OpenAI (`OPENAI_API_KEY`): steerable delivery via `instructions`; no
 *   timings, so captions are estimated from text length and marked as such.
 * ChatGPT OAuth tokens are not used: the audio endpoints reject them.
 */
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM"; // "Rachel", a stock voice.
const DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const MAX_CHARS = 5000;

const GenerateSpeechParams = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_CHARS)
    .describe("Exact words to speak. Write numbers and names the way they should be said."),
  direction: z
    .string()
    .max(500)
    .optional()
    .describe(
      "How it should sound, in plain words: 'warm and unhurried', 'confident product launch'. " +
        "Used by OpenAI; ElevenLabs takes its tone from the voice.",
    ),
  voice: z
    .string()
    .max(100)
    .optional()
    .describe("Provider voice id or name. Omit for a neutral default."),
  provider: z
    .enum(["elevenlabs", "openai"])
    .optional()
    .describe(
      "Force a provider. Default: ElevenLabs when its key is set (exact captions), else OpenAI.",
    ),
  out_path: z
    .string()
    .optional()
    .describe(
      "Where to save the MP3. Defaults to assets/voice/<timestamp>.mp3 under the workspace.",
    ),
});

type GenerateSpeechArgs = z.infer<typeof GenerateSpeechParams>;

export type CaptionWord = { text: string; start: number; end: number };

/** Group ElevenLabs character timings into words. Whitespace closes a word. */
export function wordsFromCharacterTimings(
  characters: readonly string[],
  starts: readonly number[],
  ends: readonly number[],
): CaptionWord[] {
  const words: CaptionWord[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i] ?? "";
    if (/\s/.test(ch)) {
      if (text) words.push({ text, start, end });
      text = "";
      continue;
    }
    if (!text) start = starts[i] ?? end;
    text += ch;
    end = ends[i] ?? start;
  }
  if (text) words.push({ text, start, end });
  return words.map((w) => ({ ...w, start: round(w.start), end: round(w.end) }));
}

/**
 * Spread words across a known duration in proportion to their length, with a
 * small pause weight after punctuation. Only an estimate: say so in captions.
 */
export function estimateWordTimings(text: string, duration: number): CaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length || !(duration > 0)) return [];
  const weight = (w: string) => w.length + 1 + (/[.,;:!?]$/.test(w) ? 3 : 0);
  const total = tokens.reduce((sum, w) => sum + weight(w), 0);
  let cursor = 0;
  return tokens.map((w) => {
    const start = (cursor / total) * duration;
    cursor += weight(w);
    const end = ((cursor - (/[.,;:!?]$/.test(w) ? 3 : 0)) / total) * duration;
    return { text: w, start: round(start), end: round(end) };
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** MP3 duration from frame headers is fragile; Motion already ships ffprobe, so the caller passes it in. */
export type ProbeDuration = (file: string, signal: AbortSignal) => Promise<number | null>;

function defaultOutPath(cwd: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(cwd, "assets", "voice", `${stamp}.mp3`);
}

export function createGenerateSpeechTool(
  cwd: string,
  probeDuration: ProbeDuration,
  env: NodeJS.ProcessEnv = process.env,
): AgentTool<typeof GenerateSpeechParams> {
  return {
    name: "generate_speech",
    description:
      "Generate a voiceover MP3 plus a word-timed caption file (<name>.words.json) for a Motion " +
      "video. Use only when the user wants narration or a voice. Time scenes and captions from " +
      "the returned word timings; when `timing` is 'estimated', keep captions loose (phrase-level) " +
      "and say so at delivery. Never voice invented facts or a real person's identity.",
    parameters: GenerateSpeechParams,
    async execute(args: GenerateSpeechArgs, context: ToolContext): Promise<string> {
      if (context.signal.aborted) return "Speech generation aborted before start.";
      const elevenKey = env.ELEVENLABS_API_KEY?.trim();
      const openaiKey = env.OPENAI_API_KEY?.trim();
      const provider = args.provider ?? (elevenKey ? "elevenlabs" : openaiKey ? "openai" : null);
      if (
        !provider ||
        (provider === "elevenlabs" && !elevenKey) ||
        (provider === "openai" && !openaiKey)
      ) {
        return (
          "No voice provider is configured. Set ELEVENLABS_API_KEY (exact caption timing) or " +
          "OPENAI_API_KEY. No request was sent. Tell the user; do not substitute a silent video " +
          "without saying so."
        );
      }
      const outPath = args.out_path ? resolvePath(cwd, args.out_path) : defaultOutPath(cwd);
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]);
      try {
        let audio: Buffer;
        let words: CaptionWord[];
        let timing: "exact" | "estimated";
        if (provider === "elevenlabs") {
          const voice = encodeURIComponent(args.voice ?? DEFAULT_ELEVENLABS_VOICE);
          const res = await fetch(`${ELEVENLABS_ENDPOINT}/${voice}/with-timestamps`, {
            method: "POST",
            headers: { "xi-api-key": elevenKey!, "Content-Type": "application/json" },
            body: JSON.stringify({ text: args.text, model_id: DEFAULT_ELEVENLABS_MODEL }),
            signal,
          });
          if (!res.ok) return `ElevenLabs error ${res.status}: ${(await res.text()).slice(0, 500)}`;
          const body = (await res.json()) as {
            audio_base64?: string;
            alignment?: {
              characters: string[];
              character_start_times_seconds: number[];
              character_end_times_seconds: number[];
            };
          };
          if (!body.audio_base64) return "ElevenLabs returned no audio.";
          audio = Buffer.from(body.audio_base64, "base64");
          const a = body.alignment;
          words = a
            ? wordsFromCharacterTimings(
                a.characters,
                a.character_start_times_seconds,
                a.character_end_times_seconds,
              )
            : [];
          timing = a ? "exact" : "estimated";
        } else {
          const res = await fetch(OPENAI_SPEECH_ENDPOINT, {
            method: "POST",
            headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_OPENAI_MODEL,
              voice: args.voice ?? "alloy",
              input: args.text,
              ...(args.direction ? { instructions: args.direction } : {}),
              response_format: "mp3",
            }),
            signal,
          });
          if (!res.ok)
            return `OpenAI speech error ${res.status}: ${(await res.text()).slice(0, 500)}`;
          audio = Buffer.from(await res.arrayBuffer());
          words = [];
          timing = "estimated";
        }
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, audio);
        const duration = await probeDuration(outPath, signal);
        if (timing === "estimated" && duration) words = estimateWordTimings(args.text, duration);
        const wordsPath = outPath.replace(/\.[^.]+$/, "") + ".words.json";
        await writeFile(
          wordsPath,
          `${JSON.stringify({ version: 1, provider, timing, duration, words }, null, 2)}\n`,
        );
        return JSON.stringify({
          ok: true,
          provider,
          audio: path.relative(cwd, outPath),
          words: path.relative(cwd, wordsPath),
          duration,
          timing,
          wordCount: words.length,
        });
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        return `Speech generation failed: ${String(error).slice(0, 500)}`;
      }
    },
  };
}
