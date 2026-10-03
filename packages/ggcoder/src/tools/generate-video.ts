import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";

/**
 * Short generated footage for Motion (b-roll, a hero shot, a texture) through
 * fal.ai's queue API, so any hosted text/image-to-video model works without a
 * provider-specific client. The model id comes from the call or
 * `GG_VIDEO_MODEL`; nothing is hard-wired, because the best model changes monthly.
 *
 * Generated clips are paid and slow (often 1–5 minutes): the tool refuses to run
 * without an explicit confirmation flag the agent may only set after the user
 * agreed to generated footage.
 */
const QUEUE_ROOT = "https://queue.fal.run";
const POLL_MS = 5_000;
const MAX_WAIT_MS = 10 * 60_000;

const GenerateVideoParams = z.object({
  prompt: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "Shot description: subject, action, camera move, light, lens. One shot per call; " +
        "no on-screen text (Motion sets type itself).",
    ),
  image: z
    .string()
    .optional()
    .describe(
      "Optional first frame (path to a generate_image result or a user image) for " +
        "image-to-video. Strongly preferred: it keeps brand, palette and framing under control.",
    ),
  duration: z.number().min(2).max(10).optional().describe("Seconds. Default 5."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional().describe("Match the video's shape."),
  model: z
    .string()
    .regex(/^[\w.-]+\/[\w./-]+$/)
    .optional()
    .describe("fal.ai model id. Default: GG_VIDEO_MODEL."),
  user_confirmed_cost: z
    .literal(true)
    .describe("Set only after the user agreed to paid generated footage for this video."),
  out_path: z.string().optional().describe("Defaults to assets/generated/<timestamp>.mp4."),
});

type GenerateVideoArgs = z.infer<typeof GenerateVideoParams>;

type QueueSubmit = { request_id?: string; status_url?: string; response_url?: string };
type QueueStatus = { status?: string };
type QueueResult = { video?: { url?: string }; videos?: { url?: string }[] };

function mediaType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function createGenerateVideoTool(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentTool<typeof GenerateVideoParams> {
  return {
    name: "generate_video",
    description:
      "Generate one short footage clip (2–10 s) for a Motion video from a shot prompt, ideally " +
      "from a first-frame image. Paid and slow: only after the user agreed to generated footage " +
      "(set user_confirmed_cost). Use for real-world b-roll or a hero shot that HTML/3D can't " +
      "draw; never for text, UI, logos, charts or real people. Place the MP4 as a <video> in " +
      "the composition and check it renders.",
    parameters: GenerateVideoParams,
    async execute(args: GenerateVideoArgs, context: ToolContext): Promise<string> {
      if (context.signal.aborted) return "Video generation aborted before start.";
      const key = env.FAL_KEY?.trim();
      const model = args.model ?? env.GG_VIDEO_MODEL?.trim();
      if (!key || !model) {
        return (
          "Generated footage is not configured: set FAL_KEY and GG_VIDEO_MODEL (a fal.ai " +
          "text/image-to-video model id). No request was sent. Build the shot in HTML/3D or " +
          "ask the user for footage instead."
        );
      }
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(MAX_WAIT_MS)]);
      const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
      try {
        const input: Record<string, unknown> = {
          prompt: args.prompt,
          duration: String(args.duration ?? 5),
          ...(args.aspect_ratio ? { aspect_ratio: args.aspect_ratio } : {}),
        };
        if (args.image) {
          const imagePath = resolvePath(cwd, args.image);
          const bytes = await readFile(imagePath).catch(() => null);
          if (!bytes) return `Could not read the image at ${args.image}.`;
          input.image_url = `data:${mediaType(imagePath)};base64,${bytes.toString("base64")}`;
        }
        const submit = await fetch(`${QUEUE_ROOT}/${model}`, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
          signal,
        });
        if (!submit.ok)
          return `fal.ai error ${submit.status}: ${(await submit.text()).slice(0, 500)}`;
        const queued = (await submit.json()) as QueueSubmit;
        if (!queued.status_url || !queued.response_url) return "fal.ai returned no queue handle.";

        for (;;) {
          await sleep(POLL_MS, signal);
          const status = await fetch(queued.status_url, { headers, signal });
          if (!status.ok) return `fal.ai status error ${status.status}`;
          const state = ((await status.json()) as QueueStatus).status;
          if (state === "COMPLETED") break;
          if (state !== "IN_QUEUE" && state !== "IN_PROGRESS")
            return `fal.ai request ended with status ${state ?? "unknown"}.`;
        }

        const result = await fetch(queued.response_url, { headers, signal });
        if (!result.ok)
          return `fal.ai result error ${result.status}: ${(await result.text()).slice(0, 500)}`;
        const body = (await result.json()) as QueueResult;
        const url = body.video?.url ?? body.videos?.[0]?.url;
        if (!url) return "fal.ai finished but returned no video URL.";
        const download = await fetch(url, { signal });
        if (!download.ok) return `Could not download the clip (${download.status}).`;

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outPath = args.out_path
          ? resolvePath(cwd, args.out_path)
          : path.join(cwd, "assets", "generated", `${stamp}.mp4`);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, Buffer.from(await download.arrayBuffer()));
        return JSON.stringify({
          ok: true,
          model,
          video: path.relative(cwd, outPath),
          requestId: queued.request_id,
          note: "Generated footage: inspect a few frames before placing it; never present it as real.",
        });
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        if (signal.aborted)
          return `Video generation did not finish within ${MAX_WAIT_MS / 60_000} minutes.`;
        return `Video generation failed: ${String(error).slice(0, 500)}`;
      }
    },
  };
}
