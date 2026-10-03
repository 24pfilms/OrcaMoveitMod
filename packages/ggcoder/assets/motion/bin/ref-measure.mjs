#!/usr/bin/env node
// GG Motion reference measurement: the exact, offline half of reference
// analysis. Decodes the video once and measures what a vision model samples too
// coarsely to see: cut times, shot lengths, the pacing curve, motion energy per
// shot, each shot's main colours and, with a beat grid, how many cuts land on
// the beat. Every number here is measured from pixels; nothing is described.
//
// Usage: node ref-measure.mjs <video> [--beats beats.json] [--threshold 0.3]
//          [--target <seconds> [--target-beats beats.json]]   pacing transplant plan
//          [--compare reference.json]                         gap report against a reference
// Prints one JSON object on stdout.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { alignCuts, parseBeatGrid, parseSceneChanges } from "./beat-sync.mjs";
import { mediaBinaries } from "./media-binaries.mjs";

const run = promisify(execFile);
/** A shot shorter than this is a flash frame or detector noise, not an edit. */
const MIN_SHOT = 0.12;
/** Palettes cost one decode each; past this many shots the pacing is the story. */
const MAX_PALETTES = 60;
const PACING_SEGMENTS = 6;

const round = (n, places = 3) => Number(n.toFixed(places));

/** Per-frame mean absolute difference (0–255 luma) from `metadata=print` output. */
export function parseEnergy(text) {
  const frames = [];
  let time = null;
  for (const line of String(text).split(/\r?\n/)) {
    const t = /pts_time:([0-9.]+)/.exec(line);
    if (t) {
      time = Number(t[1]);
      continue;
    }
    const y = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line);
    if (y && time !== null) {
      frames.push({ time, value: Number(y[1]) });
      time = null;
    }
  }
  return frames;
}

/** Shots between cuts; cuts closer than MIN_SHOT to the previous boundary are merged away. */
export function shotsFromCuts(cuts, duration) {
  const bounds = [0];
  for (const cut of [...cuts].sort((a, b) => a.time - b.time)) {
    if (cut.time - bounds[bounds.length - 1] >= MIN_SHOT && duration - cut.time >= MIN_SHOT)
      bounds.push(cut.time);
  }
  bounds.push(duration);
  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const cut = cuts.find((c) => c.time === bounds[i]);
    shots.push({
      index: i,
      start: round(bounds[i]),
      end: round(bounds[i + 1]),
      length: round(bounds[i + 1] - bounds[i]),
      cutStrength: cut ? round(cut.score) : null,
    });
  }
  return shots;
}

/** Mean frame-to-frame change inside each shot, scaled 0–1, ignoring the cut frame itself. */
export function energyPerShot(shots, frames, fps) {
  const skip = 1.5 / fps;
  return shots.map((shot) => {
    const inside = frames.filter((f) => f.time > shot.start + skip && f.time < shot.end - skip / 3);
    if (!inside.length) return null;
    const mean = inside.reduce((sum, f) => sum + f.value, 0) / inside.length;
    // ~25 mean luma difference per frame is already violent motion at 320 px wide.
    return round(Math.min(1, mean / 25), 2);
  });
}

/** Average shot length in equal slices of the timeline: how the edit speeds up or slows down. */
export function pacingCurve(shots, duration, segments = PACING_SEGMENTS) {
  const curve = [];
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * duration;
    const b = ((s + 1) / segments) * duration;
    const touching = shots.filter((shot) => shot.end > a && shot.start < b);
    const lengths = touching.map((shot) => shot.length);
    curve.push(
      lengths.length ? round(lengths.reduce((x, y) => x + y, 0) / lengths.length, 2) : null,
    );
  }
  return curve;
}

/** Up to three dominant colours from raw RGB pixels, coarsely bucketed so noise doesn't split them. */
export function dominantColours(rgb, count = 3) {
  const buckets = new Map();
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const key = ((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4);
    const entry = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    entry.n++;
    entry.r += rgb[i];
    entry.g += rgb[i + 1];
    entry.b += rgb[i + 2];
    buckets.set(key, entry);
  }
  const hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  const picked = [];
  for (const e of [...buckets.values()].sort((a, b) => b.n - a.n)) {
    const c = [e.r / e.n, e.g / e.n, e.b / e.n];
    // Neighbouring buckets of one surface are the same colour to a viewer.
    if (picked.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < 48)) continue;
    picked.push(c);
    if (picked.length === count) break;
  }
  return picked.map(([r, g, b]) => `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase());
}

/**
 * Pacing transplant: the reference's cut positions as fractions of its length,
 * mapped onto a new duration. With a beat grid, each cut moves to a beat within
 * `snap` seconds; cuts with no beat that close stay where the reference put them.
 */
export function transplantPacing(shots, duration, target, beats = [], snap = 0.15) {
  const cuts = [];
  let snapped = 0;
  for (const shot of shots.slice(1)) {
    let t = (shot.start / duration) * target;
    let onBeat = false;
    if (beats.length) {
      const near = beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best));
      if (Math.abs(near - t) <= snap) {
        t = near;
        onBeat = true;
      }
    }
    const last = cuts.length ? cuts[cuts.length - 1] : 0;
    if (t - last >= MIN_SHOT && target - t >= MIN_SHOT) {
      cuts.push(round(t));
      if (onBeat) snapped++;
    }
  }
  const bounds = [0, ...cuts, target];
  return {
    duration: target,
    cuts,
    shotLengths: bounds.slice(1).map((b, i) => round(b - bounds[i])),
    snappedToBeat: beats.length ? snapped : null,
    note: "Cut positions keep the reference's rhythm; fill them with your own content.",
  };
}

function trend(curve) {
  const values = curve.filter((v) => v !== null);
  if (values.length < 2) return "even";
  const first = values.slice(0, Math.ceil(values.length / 2));
  const second = values.slice(Math.floor(values.length / 2));
  const a = first.reduce((x, y) => x + y, 0) / first.length;
  const b = second.reduce((x, y) => x + y, 0) / second.length;
  if (b > a * 1.35) return "slows down";
  if (a > b * 1.35) return "speeds up";
  return "stays even";
}

function averageEnergy(shots) {
  const values = shots.map((s) => s.motionEnergy).filter((v) => typeof v === "number");
  return values.length ? round(values.reduce((x, y) => x + y, 0) / values.length, 2) : null;
}

/**
 * Gap report between a measured reference and a measured render. Rates are per
 * second of video, so a 15 s cut-down compares fairly with a 60 s original.
 * Each finding says what differs, by how much, and what to change.
 */
export function compareMeasurements(reference, mine) {
  const findings = [];
  const r = reference.summary;
  const m = mine.summary;
  const add = (area, ref, yours, gap, fix) =>
    findings.push({ area, reference: ref, yours, gap, fix });
  const ratio = m.averageShot / r.averageShot;
  if (ratio > 1.3 || ratio < 0.77)
    add(
      "Shot length",
      r.averageShot,
      m.averageShot,
      `Your shots are ${ratio > 1 ? "longer" : "shorter"} on average (${m.averageShot} s against ${r.averageShot} s).`,
      ratio > 1
        ? `Split long shots or cut sooner: aim for about ${round(r.averageShot, 1)} s per shot.`
        : `Hold shots longer: aim for about ${round(r.averageShot, 1)} s per shot.`,
    );
  if (r.firstCut !== null && (m.firstCut === null || m.firstCut > r.firstCut * 1.5 + 0.2))
    add(
      "Hook",
      r.firstCut,
      m.firstCut,
      m.firstCut === null
        ? "Your video never cuts; the reference changes picture within its opening."
        : `Your first change of picture comes at ${m.firstCut} s; the reference's at ${r.firstCut} s.`,
      `Bring the first cut or reveal forward to about ${round(r.firstCut, 1)} s.`,
    );
  if (r.cutsInFirst3s - m.cutsInFirst3s >= 2)
    add(
      "Opening density",
      r.cutsInFirst3s,
      m.cutsInFirst3s,
      `The reference cuts ${r.cutsInFirst3s} times in its first 3 s; you cut ${m.cutsInFirst3s} times.`,
      "Open with quicker changes, then settle.",
    );
  const rt = trend(r.pacingCurve);
  const mt = trend(m.pacingCurve);
  if (rt !== mt)
    add(
      "Pacing shape",
      rt,
      mt,
      `Over its length the reference ${rt}; yours ${mt}.`,
      rt === "slows down"
        ? "Cut faster early and give the last third longer holds."
        : rt === "speeds up"
          ? "Start with longer shots and tighten the cuts toward the end."
          : "Keep shot lengths steady instead of changing pace.",
    );
  const re = averageEnergy(reference.shots);
  const me = averageEnergy(mine.shots);
  if (re !== null && me !== null && Math.abs(re - me) >= 0.08)
    add(
      "Motion amount",
      re,
      me,
      `On-screen movement averages ${me} against the reference's ${re} (0 = still, 1 = constant change).`,
      me < re
        ? "Add camera or element movement inside shots."
        : "Calm movement inside shots; let frames settle.",
    );
  const rb = reference.rhythm?.ok ? reference.rhythm.onBeatRatio : null;
  const mb = mine.rhythm?.ok ? mine.rhythm.onBeatRatio : null;
  const skipped = [];
  if (re === null || me === null) skipped.push("motion amount: no measurable frames inside shots");
  if (rb === null || mb === null)
    skipped.push(
      "cuts on beat: needs `beats` for the reference's music when it was analysed and for yours now",
    );
  if (rb !== null && mb !== null && rb - mb >= 0.2)
    add(
      "Cuts on the beat",
      rb,
      mb,
      `${Math.round(rb * 100)}% of the reference's cuts land on a beat; ${Math.round(mb * 100)}% of yours do.`,
      "Move major cuts to the nearest beat (motion_check lists the offsets).",
    );
  return {
    ok: true,
    matches: findings.length === 0,
    findings,
    compared: [
      "shot length",
      "hook",
      "opening density",
      "pacing shape",
      ...(re !== null && me !== null ? ["motion amount"] : []),
      ...(rb !== null && mb !== null ? ["cuts on beat"] : []),
    ],
    notCompared: skipped,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(shots, duration) {
  const lengths = shots.map((s) => s.length);
  const cuts = shots.slice(1).map((s) => s.start);
  return {
    shots: shots.length,
    cutsPerMinute: round((cuts.length / duration) * 60, 1),
    averageShot: round(duration / shots.length, 2),
    medianShot: round(median(lengths), 2),
    shortestShot: round(Math.min(...lengths), 2),
    longestShot: round(Math.max(...lengths), 2),
    firstCut: cuts.length ? cuts[0] : null,
    cutsInFirst3s: cuts.filter((t) => t < 3).length,
    pacingCurve: pacingCurve(shots, duration),
  };
}

async function probe(ffprobe, video) {
  const { stdout } = await run(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate,r_frame_rate,width,height,duration:format=duration",
      "-of",
      "json",
      video,
    ],
    { windowsHide: true },
  );
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0];
  const rate = (value) => {
    const [num, den] = String(value ?? "0/1")
      .split("/")
      .map(Number);
    return den ? num / den : 0;
  };
  // Streamed WebM reports avg_frame_rate 0/0; r_frame_rate still holds the nominal rate.
  const fps = rate(stream?.avg_frame_rate) || rate(stream?.r_frame_rate);
  if (!stream || !(fps > 0)) throw new Error("Unreadable video metadata");
  // The video stream's own length, never the container's: music often runs past the picture.
  // Either may be missing (streamed WebM); measureReference then uses the last decoded frame.
  const streamDuration = Number(stream.duration);
  const formatDuration = Number(info.format?.duration);
  return {
    fps: round(fps, 3),
    streamDuration: streamDuration > 0 ? streamDuration : null,
    formatDuration: formatDuration > 0 ? formatDuration : null,
    width: stream.width,
    height: stream.height,
  };
}

/**
 * The picture's real length: the last decoded frame's end on the same timeline
 * the cuts come from, else the video stream's duration, else the container's.
 */
export function pictureDuration(frames, fps, streamDuration, formatDuration) {
  if (frames.length) {
    const last = Math.max(...frames.map((f) => f.time));
    const measured = last + 1 / fps;
    return streamDuration ? Math.min(streamDuration, measured) : measured;
  }
  return streamDuration ?? formatDuration ?? null;
}

async function palette(ffmpeg, video, time) {
  const { stdout } = await run(
    ffmpeg,
    [
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      video,
      "-frames:v",
      "1",
      "-vf",
      "scale=48:27",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1024 * 1024, windowsHide: true },
  );
  return dominantColours(stdout);
}

export async function measureReference(videoPath, { beats, threshold = 0.3 } = {}) {
  const video = resolve(videoPath);
  const { ffmpeg, ffprobe } = await mediaBinaries();
  const meta = await probe(ffprobe, video);
  // Relative metadata paths with cwd in a temp folder: Windows drive colons break filtergraphs.
  const work = await mkdtemp(join(tmpdir(), "gg-ref-"));
  try {
    await run(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-i",
        video,
        "-an",
        "-filter_complex",
        `[0:v]scale=320:-2,split=2[s][m];` +
          `[s]select='gt(scene,${threshold})',metadata=print:file=cuts.txt[o1];` +
          `[m]tblend=all_mode=difference,signalstats,` +
          `metadata=print:key=lavfi.signalstats.YAVG:file=energy.txt[o2]`,
        "-map",
        "[o1]",
        "-f",
        "null",
        "-",
        "-map",
        "[o2]",
        "-f",
        "null",
        "-",
      ],
      { cwd: work, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    const cuts = parseSceneChanges(await readFile(join(work, "cuts.txt"), "utf-8"));
    const frames = parseEnergy(await readFile(join(work, "energy.txt"), "utf-8"));
    const length = pictureDuration(frames, meta.fps, meta.streamDuration, meta.formatDuration);
    if (!(length > 0)) throw new Error("Video has no decodable frames");
    const duration = round(length);
    const shots = shotsFromCuts(
      cuts.filter((c) => c.time < duration),
      duration,
    );
    const energy = energyPerShot(shots, frames, meta.fps);
    for (const [i, shot] of shots.entries()) {
      shot.motionEnergy = energy[i];
      shot.palette =
        i < MAX_PALETTES ? await palette(ffmpeg, video, (shot.start + shot.end) / 2) : null;
    }
    let rhythm = null;
    if (beats) {
      const grid = parseBeatGrid(JSON.parse(await readFile(resolve(beats), "utf-8")));
      const boundaries = shots.slice(1).map((s) => ({ time: s.start, score: s.cutStrength ?? 0 }));
      rhythm = alignCuts(boundaries, grid);
    }
    return {
      version: 1,
      kind: "measured",
      source: {
        file: video,
        fps: meta.fps,
        duration,
        width: meta.width,
        height: meta.height,
      },
      threshold,
      summary: summarize(shots, duration),
      shots,
      rhythm,
      notes: [
        "Cuts come from a pixel scene-change score; slow dissolves and match cuts can be missed.",
        "motionEnergy mixes camera and subject motion; it is not a camera-move measurement.",
      ],
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(argv) {
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const video = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  if (!video)
    throw new Error(
      "usage: ref-measure.mjs <video> [--beats f] [--threshold n] [--target s] [--compare f]",
    );
  const threshold = Number(value("threshold") ?? 0.3);
  if (!(threshold > 0 && threshold < 1)) throw new Error("--threshold must be in (0, 1)");
  const result = await measureReference(video, { beats: value("beats"), threshold });
  const target = value("target");
  if (target !== undefined) {
    const seconds = Number(target);
    if (!(seconds > 0)) throw new Error("--target must be a positive number of seconds");
    const grid = value("target-beats")
      ? parseBeatGrid(JSON.parse(await readFile(resolve(value("target-beats")), "utf-8"))).beats
      : [];
    result.plan = transplantPacing(result.shots, result.source.duration, seconds, grid);
  }
  const compare = value("compare");
  if (compare) {
    const reference = JSON.parse(await readFile(resolve(compare), "utf-8"));
    if (!reference.summary || !Array.isArray(reference.shots))
      throw new Error(
        "That reference has no measurements (YouTube-only?); analyse a local copy first",
      );
    result.comparison = compareMeasurements(reference, result);
  }
  return result;
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
