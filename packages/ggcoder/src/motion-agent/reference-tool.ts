import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import type { MotionBundle } from "../core/skills.js";
import { inside, motionPath } from "./motion-review.js";

/**
 * Reference analysis: measure a reference video exactly with FFmpeg
 * (`ref-measure.mjs`), describe it shot by shot with Gemini video vision, and
 * reconcile the two. Numbers come only from measurement; words only from the
 * model. Gemini samples about one frame per second, so it never supplies timing
 * when a measurement exists.
 */
const exec = promisify(execFile);
const GEMINI_ROOT = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-flash-latest";
/** Inline request bodies are capped near 20 MB; base64 adds a third. */
const INLINE_MAX_BYTES = 14 * 1024 * 1024;
const UPLOAD_WAIT_MS = 5 * 60_000;

const CAMERA_MOVES = [
  "static",
  "push-in",
  "pull-out",
  "pan-left",
  "pan-right",
  "tilt-up",
  "tilt-down",
  "truck",
  "dolly",
  "crane-up",
  "crane-down",
  "orbit",
  "zoom-in",
  "zoom-out",
  "handheld",
  "rack-focus",
  "drone",
  "other",
] as const;
const MOVING = new Set<string>(CAMERA_MOVES.filter((m) => m !== "static" && m !== "rack-focus"));
const TRANSITIONS = [
  "cut",
  "match-cut",
  "whip",
  "dissolve",
  "fade",
  "wipe",
  "morph",
  "zoom",
  "light-leak",
  "glitch",
  "none",
  "other",
] as const;

const parameters = z.object({
  source: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      "Reference video: a workspace path (measured exactly, then described) or a public " +
        "YouTube URL (described only; timings are then approximate).",
    ),
  beats: z
    .string()
    .max(1000)
    .optional()
    .describe("Beat grid of the source's music, to measure how many cuts land on the beat."),
  compare: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "Path to an earlier .reference.json. Treats `source` as YOUR render: measures it the " +
        "same way and returns a gap report against that reference. No Gemini call.",
    ),
  targetDuration: z
    .number()
    .positive()
    .max(3600)
    .optional()
    .describe("Seconds. Adds a pacing plan: the reference's cut rhythm mapped onto this length."),
  targetBeats: z
    .string()
    .max(1000)
    .optional()
    .describe("Beat grid of YOUR music; pacing-plan cuts snap to beats within 0.15 s."),
  threshold: z
    .number()
    .min(0.05)
    .max(0.9)
    .optional()
    .describe(
      "Cut sensitivity (default 0.3; lower catches softer edits). With `compare`, defaults to " +
        "the reference's own threshold so both are measured the same way.",
    ),
  describe: z
    .boolean()
    .optional()
    .describe("Default true. false = measurement only (free, offline)."),
  focus: z
    .string()
    .max(500)
    .optional()
    .describe("What to study closely, e.g. 'camera moves in the opening' or 'text animation'."),
  out: z
    .string()
    .max(1000)
    .optional()
    .describe("Where to write the JSON. Default: reference/<name>.reference.json."),
});
type Params = z.infer<typeof parameters>;

const shotSchema = z
  .object({
    index: z.number().int().min(0),
    start: z.string().optional(),
    end: z.string().optional(),
    shotSize: z.string().optional(),
    camera: z.string().optional(),
    cameraDetail: z.string().optional(),
    subject: z.string().optional(),
    subjectMotion: z.string().optional(),
    scene: z.string().optional(),
    overlays: z.array(z.object({ text: z.string(), at: z.string().optional() })).optional(),
    transitionOut: z.string().optional(),
    mood: z.string().optional(),
  })
  .passthrough();
export const describedSchema = z
  .object({
    format: z.string().optional(),
    summary: z.string().optional(),
    hook: z.string().optional(),
    whyItWorks: z.array(z.string()).optional(),
    editFollows: z.string().optional(),
    typography: z.string().optional(),
    colorGrade: z.string().optional(),
    audio: z.string().optional(),
    shots: z.array(shotSchema).default([]),
  })
  .passthrough();
export type Described = z.infer<typeof describedSchema>;
type DescribedShot = z.infer<typeof shotSchema>;

export type MeasuredShot = {
  index: number;
  start: number;
  end: number;
  length: number;
  cutStrength: number | null;
  motionEnergy: number | null;
  palette: string[] | null;
};
export type Measured = {
  version: 1;
  kind: "measured";
  source: { file: string; fps: number; duration: number; width: number; height: number };
  summary: Record<string, unknown>;
  shots: MeasuredShot[];
  rhythm: unknown;
  plan?: unknown;
  comparison?: unknown;
};

/** Gemini's response schema (OpenAPI subset). Kept beside the zod parser it must match. */
export const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    format: { type: "STRING" },
    summary: { type: "STRING" },
    hook: { type: "STRING" },
    whyItWorks: { type: "ARRAY", items: { type: "STRING" } },
    editFollows: { type: "STRING", enum: ["music", "voice", "action", "mixed", "none"] },
    typography: { type: "STRING" },
    colorGrade: { type: "STRING" },
    audio: { type: "STRING" },
    shots: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          index: { type: "INTEGER" },
          start: { type: "STRING" },
          end: { type: "STRING" },
          shotSize: { type: "STRING", enum: ["ECU", "CU", "MCU", "MS", "WS", "EWS", "graphic"] },
          camera: { type: "STRING", enum: [...CAMERA_MOVES] },
          cameraDetail: { type: "STRING" },
          subject: { type: "STRING" },
          subjectMotion: { type: "STRING" },
          scene: { type: "STRING" },
          overlays: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { text: { type: "STRING" }, at: { type: "STRING" } },
              required: ["text"],
            },
          },
          transitionOut: { type: "STRING", enum: [...TRANSITIONS] },
          mood: { type: "STRING" },
        },
        required: ["index", "shotSize", "camera", "transitionOut"],
      },
    },
  },
  required: ["summary", "hook", "whyItWorks", "editFollows", "shots"],
} as const;

export function isYouTubeUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return (
      url.protocol === "https:" &&
      /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** Denser sampling for short references, where single frames matter; cost stays bounded. */
export function chooseFps(duration: number | null): number {
  if (duration === null) return 1;
  if (duration <= 20) return 5;
  if (duration <= 60) return 3;
  if (duration <= 180) return 2;
  return 1;
}

export function buildPrompt(measured: Measured | null, focus?: string): string {
  const lines = [
    "You are a film editor and motion designer breaking down a reference video so another",
    "designer can learn its craft. Describe only what is visible or audible. Never guess.",
    "",
  ];
  if (measured) {
    lines.push(
      "The shots below were measured from the pixels and are exact. Describe each one by its",
      "index. Do not merge, split, add or retime shots; leave start/end empty.",
      ...measured.shots.map(
        (s) => `Shot ${s.index}: ${s.start.toFixed(2)}s to ${s.end.toFixed(2)}s`,
      ),
    );
  } else {
    lines.push(
      "Split the video into shots yourself. Give each shot start and end as MM:SS.s.",
      "Your timing is approximate; say so in the summary if cuts are faster than you can see.",
    );
  }
  lines.push(
    "",
    "For every shot: shot size; the camera move (the one that dominates) and in cameraDetail",
    "its direction, speed and ease (e.g. 'slow push, accelerates, settles over the last 0.5s');",
    "subject; subject motion; scene and point of view; every on-screen text with when it",
    "appears; how the shot ends (transitionOut); mood.",
    "Overall: format; a one-sentence summary; the hook (what happens in the first 3 seconds",
    "and why it holds attention); whyItWorks (3-5 specific, checkable craft reasons, each",
    "naming a time or shot); what the edit follows (editFollows); typography; colour grade;",
    "audio (music, voice, sound effects and how they relate to the picture).",
  );
  if (focus) lines.push("", `Pay closest attention to: ${focus}`);
  return lines.join("\n");
}

/** "01:02.5" | "1:02" | "62.5" | "62.5s" → seconds; null when unreadable. */
export function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.trim().replace(/s$/, "");
  const parts = text.split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

export type Conflict = { shot: number | null; issue: string };

/**
 * Attach descriptions to measured shots. Measurement wins every disagreement;
 * each disagreement is listed rather than silently resolved.
 */
export function reconcile(
  measured: Measured | null,
  described: Described | null,
): { shots: Record<string, unknown>[]; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  if (!measured) {
    const shots = (described?.shots ?? []).map((d) => ({
      index: d.index,
      start: parseTimestamp(d.start),
      end: parseTimestamp(d.end),
      timing: "described",
      described: d,
    }));
    if (shots.length)
      conflicts.push({
        shot: null,
        issue: "No local file, so shot timing is the model's estimate at about 1 frame per second.",
      });
    return { shots, conflicts };
  }
  const byIndex = new Map<number, DescribedShot>();
  for (const d of described?.shots ?? []) {
    if (d.index >= measured.shots.length)
      conflicts.push({ shot: d.index, issue: "Described a shot that measurement did not find." });
    else if (byIndex.has(d.index))
      conflicts.push({ shot: d.index, issue: "Described twice; the first description is kept." });
    else byIndex.set(d.index, d);
  }
  const shots = measured.shots.map((m) => {
    const d = byIndex.get(m.index) ?? null;
    if (described && !d)
      conflicts.push({ shot: m.index, issue: "Measured shot was not described." });
    if (d?.camera && m.motionEnergy !== null) {
      if (MOVING.has(d.camera) && m.motionEnergy < 0.01)
        conflicts.push({
          shot: m.index,
          issue: `Described as ${d.camera}, but the pixels barely change (energy ${m.motionEnergy}). Treat as static or a very slow move.`,
        });
      if (d.camera === "static" && m.motionEnergy > 0.35)
        conflicts.push({
          shot: m.index,
          issue: `Described as static, but the picture changes a lot (energy ${m.motionEnergy}); the camera or subject is moving.`,
        });
    }
    return { ...m, timing: "measured", described: d };
  });
  return { shots, conflicts };
}

type GeminiPart = Record<string, unknown>;

function videoMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".avi") return "video/x-msvideo";
  return "video/mp4";
}

async function uploadToGemini(file: string, key: string, signal: AbortSignal): Promise<GeminiPart> {
  const bytes = await fs.readFile(file);
  const mimeType = videoMime(file);
  const start = await fetch(`${GEMINI_ROOT}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: path.basename(file) } }),
    signal,
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new Error(`Gemini upload start failed (${start.status})`);
  const done = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
    signal,
  });
  if (!done.ok) throw new Error(`Gemini upload failed (${done.status})`);
  let info = ((await done.json()) as { file?: { name?: string; uri?: string; state?: string } })
    .file;
  if (!info?.name || !info.uri) throw new Error("Gemini upload returned no file handle");
  const deadline = Date.now() + UPLOAD_WAIT_MS;
  while (info?.state === "PROCESSING") {
    if (Date.now() > deadline) throw new Error("Gemini is still processing the upload");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const poll = await fetch(`${GEMINI_ROOT}/v1beta/${info.name}`, {
      headers: { "x-goog-api-key": key },
      signal,
    });
    if (!poll.ok) throw new Error(`Gemini file status failed (${poll.status})`);
    info = (await poll.json()) as { name?: string; uri?: string; state?: string };
  }
  if (info?.state && info.state !== "ACTIVE")
    throw new Error(`Gemini could not process the video (${info.state})`);
  return { fileData: { fileUri: info!.uri, mimeType } };
}

async function describeWithGemini(
  source: { file?: string; url?: string },
  measured: Measured | null,
  focus: string | undefined,
  key: string,
  model: string,
  signal: AbortSignal,
): Promise<{ described: Described; fps: number }> {
  const fps = chooseFps(measured?.source.duration ?? null);
  let media: GeminiPart;
  if (source.url) media = { fileData: { fileUri: source.url } };
  else {
    const size = (await fs.stat(source.file!)).size;
    media =
      size <= INLINE_MAX_BYTES
        ? {
            inlineData: {
              mimeType: videoMime(source.file!),
              data: (await fs.readFile(source.file!)).toString("base64"),
            },
          }
        : await uploadToGemini(source.file!, key, signal);
  }
  const res = await fetch(
    `${GEMINI_ROOT}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ ...media, videoMetadata: { fps } }, { text: buildPrompt(measured, focus) }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: GEMINI_RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      }),
      signal,
    },
  );
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini returned no description");
  return { described: describedSchema.parse(JSON.parse(text)), fps };
}

function referenceName(source: string): string {
  if (!isYouTubeUrl(source)) return path.basename(source, path.extname(source));
  const url = new URL(source);
  const id = (url.searchParams.get("v") || url.pathname.split("/").pop() || "").replace(
    /[^\w-]/g,
    "",
  );
  return `youtube-${id || "video"}`;
}

/**
 * Write inside the workspace only. The textual check stops `..`; the real-path
 * check on the folder and O_NOFOLLOW on the file stop symlink escapes.
 */
async function writeReference(base: string, source: string, out: string | undefined, text: string) {
  const target = path.resolve(
    base,
    out ?? path.join("reference", `${referenceName(source)}.reference.json`),
  );
  if (!inside(base, target)) throw new Error("Output path escapes the workspace");
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (!inside(base, await fs.realpath(path.dirname(target))))
    throw new Error("Output folder is a symlink out of the workspace");
  const handle = await fs.open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
  return target;
}

const MAX_CONFLICTS_SHOWN = 20;

/** Bounded tool result that stays valid JSON: long lists are cut, never the string. */
function compactSummary(doc: Record<string, unknown>): string {
  const cap = (list: unknown[], n: number, what: string) =>
    list.length > n ? [...list.slice(0, n), `…${list.length - n} more ${what} in the file`] : list;
  let shotsShown = 12;
  for (;;) {
    const text = JSON.stringify(doc, (key, value) =>
      key === "shots" && Array.isArray(value)
        ? cap(value, shotsShown, "shots")
        : key === "conflicts" && Array.isArray(value)
          ? cap(value, MAX_CONFLICTS_SHOWN, "conflicts")
          : value,
    );
    if (text.length <= 14_000 || shotsShown === 0) return text;
    shotsShown = Math.floor(shotsShown / 2);
  }
}

export function createReferenceTool(
  cwd: string,
  bundle: MotionBundle,
  env: NodeJS.ProcessEnv = process.env,
): AgentTool<typeof parameters> {
  return {
    name: "analyze_reference",
    description:
      "Break down a reference video into what makes it work: exact cuts, shot lengths, pacing " +
      "curve, motion energy and colours per shot (measured), plus shot size, camera move, " +
      "transitions, on-screen text, hook and craft reasons (described by Gemini video vision). " +
      "Writes a .reference.json. With `targetDuration` it adds a pacing plan for your video; " +
      "with `compare` it measures YOUR render and lists the gaps against a saved reference. " +
      "Use references for timing, structure and camera language; never copy their footage, " +
      "music, logos or layouts.",
    parameters,
    executionMode: "sequential",
    async execute(args: Params, context: ToolContext): Promise<string> {
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(600_000)]);
      try {
        const input = parameters.parse(args);
        const youtube = isYouTubeUrl(input.source);
        if (/^[a-z]+:\/\//i.test(input.source) && !youtube)
          return "Only workspace files and public YouTube URLs are supported. Ask the user for the file.";
        if (youtube && (input.compare || input.targetDuration))
          return "Comparison and pacing plans need exact cut times; use a workspace copy of the video.";
        if (input.targetBeats && !input.targetDuration)
          return "`targetBeats` snaps a pacing plan; pass `targetDuration` too.";
        if (input.compare && input.targetDuration)
          return "Use `compare` and `targetDuration` in separate calls: one checks a render, the other plans one.";
        const base = await fs.realpath(cwd);

        let measured: Measured | null = null;
        let file: string | undefined;
        if (!youtube) {
          file = await motionPath(cwd, input.source);
          const argv = [path.join(bundle.root, "bin", "ref-measure.mjs"), file];
          if (input.beats) argv.push("--beats", await motionPath(cwd, input.beats));
          if (input.targetDuration) argv.push("--target", String(input.targetDuration));
          if (input.targetBeats)
            argv.push("--target-beats", await motionPath(cwd, input.targetBeats));
          let threshold = input.threshold;
          if (input.compare) {
            const reference = await motionPath(cwd, input.compare);
            argv.push("--compare", reference);
            if (threshold === undefined) {
              const saved = JSON.parse(await fs.readFile(reference, "utf-8")) as {
                source_measurement?: { threshold?: unknown };
              };
              const t = saved.source_measurement?.threshold;
              if (typeof t === "number") threshold = t;
            }
          }
          if (threshold !== undefined) argv.push("--threshold", String(threshold));
          const { stdout, stderr } = await exec(process.execPath, argv, {
            signal,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          }).catch((error: { stdout?: string; stderr?: string }) => {
            if (signal.aborted) throw error;
            return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
          });
          let parsed: (Measured & { ok?: false; error?: string; threshold?: number }) | null = null;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }
          if (parsed?.ok === false) return `Measurement failed: ${parsed.error}`;
          if (!parsed || !Array.isArray(parsed.shots))
            return `Measurement failed: ${String(stderr).trim().slice(0, 600) || "no result"}`;
          measured = parsed;
        }

        if (input.compare) {
          return JSON.stringify({
            mode: "gap report",
            yours: measured!.summary,
            comparison: measured!.comparison,
            note: "Measured only. Fix the largest gaps that serve this video's plan; ignore the rest.",
          });
        }

        let described: Described | null = null;
        let fps: number | null = null;
        let describeNote: string | null = null;
        const key = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
        const model = env.GG_GEMINI_VISION_MODEL?.trim() || DEFAULT_MODEL;
        if (input.describe === false) describeNote = "Description skipped on request.";
        else if (!key)
          describeNote = youtube
            ? "YouTube links need GEMINI_API_KEY, and nothing can be measured without a local file. Ask the user for the key or the video file."
            : "No GEMINI_API_KEY, so shots are measured but not described. Inspect frames yourself or ask the user to add the key.";
        else {
          try {
            ({ described, fps } = await describeWithGemini(
              youtube ? { url: input.source } : { file },
              measured,
              input.focus,
              key,
              model,
              signal,
            ));
          } catch (error) {
            if (context.signal.aborted) throw error;
            describeNote = `Description failed: ${String(error).slice(0, 400)}`;
          }
        }
        if (youtube && !described) return describeNote ?? "Nothing to analyse.";

        const { shots, conflicts } = reconcile(measured, described);
        const { shots: _describedShots, ...overall } = described ?? { shots: [] };
        const doc = {
          version: 1,
          source: youtube
            ? { kind: "youtube", url: input.source }
            : { kind: "file", path: path.relative(base, file!) },
          summary: measured?.summary ?? null,
          overall: described ? overall : null,
          shots,
          conflicts,
          rhythm: measured?.rhythm ?? null,
          plan: measured?.plan ?? null,
          source_measurement: measured
            ? {
                fps: measured.source.fps,
                duration: measured.source.duration,
                width: measured.source.width,
                height: measured.source.height,
                threshold: (measured as { threshold?: number }).threshold,
              }
            : null,
          provenance: {
            measured: measured
              ? "ref-measure.mjs (FFmpeg scene score, frame difference, palette)"
              : null,
            described: described ? { model, fps } : null,
            note: describeNote,
          },
        };
        const target = await writeReference(
          base,
          input.source,
          input.out,
          `${JSON.stringify(doc, null, 2)}\n`,
        );
        return compactSummary({
          note: describeNote,
          written: path.relative(base, target),
          summary: doc.summary,
          overall: doc.overall,
          plan: doc.plan,
          conflicts,
          shots: shots.map((s) => {
            const d = (s as { described?: DescribedShot | null }).described;
            return {
              index: s.index,
              start: s.start,
              end: s.end,
              ...(d ? { size: d.shotSize, camera: d.camera, out: d.transitionOut } : {}),
            };
          }),
        });
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        return `Reference analysis failed: ${String(error).slice(0, 600)}`;
      }
    },
  };
}
