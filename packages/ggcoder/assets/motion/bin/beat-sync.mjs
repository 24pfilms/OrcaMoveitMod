#!/usr/bin/env node
// GG Motion beat sync: find the rendered video's visual cuts and big reveals
// (FFmpeg scene-change score on decoded pixels) and measure how far each one
// lands from the music's beat grid. Advisory evidence for the craft score, not
// a pass/fail gate: a cut may sit off the beat on purpose.
//
// Usage: node beat-sync.mjs <video.mp4> <beats.json> [--threshold 0.3] [--tolerance 0.1]
// beats.json may be any grid Motion already produces:
//   - a bundled cues file (`beats: [{ time }]`, `strongCues: [{ time }]`)
//   - score-synth's tempo-map.json (`beats: [seconds]`, `bars: [seconds]`)
//   - `hf beats` output or a plain array of seconds / `{ time }` / `{ t }`
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ffmpegBinary } from "./media-binaries.mjs";

const run = promisify(execFile);

function seconds(entry) {
  if (typeof entry === "number") return entry;
  if (entry && typeof entry === "object") {
    const value = entry.time ?? entry.t;
    if (typeof value === "number") return value;
  }
  return Number.NaN;
}

function grid(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(seconds).filter((t) => Number.isFinite(t) && t >= 0))].sort(
    (a, b) => a - b,
  );
}

/** Normalize every supported beat file into `{ beats, strong }` sorted second grids. */
export function parseBeatGrid(json) {
  if (Array.isArray(json)) return { beats: grid(json), strong: [] };
  if (!json || typeof json !== "object") return { beats: [], strong: [] };
  const beats = grid(json.beats);
  // Strong cues from analysed tracks; bar downbeats from score-synth.
  const strong = grid(json.strongCues ?? json.bars ?? []);
  return { beats, strong };
}

/** Scene-change times from `metadata=print` output; never infers a cut from silence. */
export function parseSceneChanges(text) {
  const cuts = [];
  let pending = null;
  for (const line of String(text).split(/\r?\n/)) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    if (time) {
      pending = Number(time[1]);
      continue;
    }
    const score = /lavfi\.scene_score=([0-9.]+)/.exec(line);
    if (score && pending !== null) {
      cuts.push({ time: pending, score: Number(score[1]) });
      pending = null;
    }
  }
  return cuts;
}

function nearest(sorted, t) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const after = sorted[lo];
  const before = sorted[lo - 1];
  return before !== undefined && Math.abs(before - t) <= Math.abs(after - t) ? before : after;
}

/**
 * Offset of each cut from its nearest beat. The strongest third of cuts are
 * "major": they also name the nearest strong cue, where a big reveal reads best.
 */
export function alignCuts(cuts, beatGrid, tolerance = 0.1) {
  const { beats, strong } = beatGrid;
  if (!beats.length) return { ok: false, error: "Beat grid is empty; rhythm is unverified" };
  const scores = cuts.map((c) => c.score).sort((a, b) => b - a);
  const majorCut = scores[Math.max(0, Math.ceil(scores.length / 3) - 1)] ?? Infinity;
  const events = cuts.map((cut) => {
    const beat = nearest(beats, cut.time);
    const offset = Number((cut.time - beat).toFixed(3));
    const major = cut.score >= majorCut;
    return {
      time: Number(cut.time.toFixed(3)),
      score: Number(cut.score.toFixed(3)),
      kind: major ? "major" : "cut",
      nearestBeat: Number(beat.toFixed(3)),
      ...(major && strong.length
        ? { nearestStrong: Number(nearest(strong, cut.time).toFixed(3)) }
        : {}),
      offset,
      onBeat: Math.abs(offset) <= tolerance,
    };
  });
  const onBeat = events.filter((e) => e.onBeat).length;
  return {
    ok: true,
    tolerance,
    cuts: events.length,
    onBeat,
    onBeatRatio: events.length ? Number((onBeat / events.length).toFixed(2)) : null,
    offBeat: events.filter((e) => !e.onBeat),
    note:
      "Advisory. Move a reveal toward its nearest beat only when that helps the story; " +
      "reading holds and deliberate off-beat accents stay.",
  };
}

async function main(argv) {
  const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const [videoArg, beatsArg] = positional;
  if (!videoArg || !beatsArg) {
    throw new Error(
      "usage: beat-sync.mjs <video.mp4> <beats.json> [--threshold 0.3] [--tolerance 0.1]",
    );
  }
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    const value = i >= 0 ? Number(argv[i + 1]) : fallback;
    if (!Number.isFinite(value) || value <= 0 || value >= 1)
      throw new Error(`--${name} must be in (0, 1)`);
    return value;
  };
  const threshold = flag("threshold", 0.3);
  const tolerance = flag("tolerance", 0.1);
  const beatGrid = parseBeatGrid(JSON.parse(await readFile(resolve(beatsArg), "utf-8")));
  const ffmpeg = await ffmpegBinary();
  const { stdout } = await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      resolve(videoArg),
      "-an",
      "-vf",
      `select='gt(scene,${threshold})',metadata=print:file=-`,
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  return alignCuts(parseSceneChanges(stdout), beatGrid, tolerance);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
