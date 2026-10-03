import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { findMotionBundle, type MotionBundle } from "../core/skills.js";
import {
  buildPrompt,
  chooseFps,
  createReferenceTool,
  isYouTubeUrl,
  parseTimestamp,
  reconcile,
  type Measured,
} from "./reference-tool.js";

const run = promisify(execFile);
const context = () => ({ signal: new AbortController().signal, toolCallId: "ref" });

type MeasureModule = {
  shotsFromCuts: (cuts: { time: number; score: number }[], duration: number) => Measured["shots"];
  pacingCurve: (
    shots: { start: number; end: number; length: number }[],
    d: number,
    n?: number,
  ) => (number | null)[];
  dominantColours: (rgb: Uint8Array, count?: number) => string[];
  transplantPacing: (
    shots: { start: number }[],
    duration: number,
    target: number,
    beats?: number[],
  ) => { cuts: number[]; shotLengths: number[]; snappedToBeat: number | null };
  compareMeasurements: (
    a: unknown,
    b: unknown,
  ) => { matches: boolean; findings: { area: string }[] };
};

let bundle: MotionBundle;
let measure: MeasureModule;
beforeAll(async () => {
  const found = await findMotionBundle();
  if (!found) throw new Error("motion bundle missing");
  bundle = found;
  measure = (await import(path.join(bundle.root, "bin", "ref-measure.mjs"))) as MeasureModule;
});

let tmp = "";
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gg-ref-")));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Three solid-colour shots: 0–1 s, 1–2.5 s, 2.5–4 s. */
async function makeVideo(file: string, lengths = [1, 1.5, 1.5]): Promise<void> {
  const colours = ["red", "blue", "green", "white"];
  const inputs = lengths.flatMap((d, i) => [
    "-f",
    "lavfi",
    "-i",
    `color=${colours[i]}:s=160x90:d=${d}:r=30`,
  ]);
  const chain = lengths.map((_, i) => `[${i}]`).join("") + `concat=n=${lengths.length}:v=1[v]`;
  await run("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    chain,
    "-map",
    "[v]",
    file,
  ]);
}

describe("ref-measure helpers", () => {
  it("drops flash-frame cuts and keeps shot boundaries exact", () => {
    const shots = measure.shotsFromCuts(
      [
        { time: 1, score: 0.9 },
        { time: 1.05, score: 0.5 },
        { time: 2.5, score: 0.8 },
      ],
      4,
    );
    expect(shots.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 2.5],
      [2.5, 4],
    ]);
    expect(shots[1]!.cutStrength).toBe(0.9);
  });

  it("averages shot length per slice of the timeline", () => {
    const shots = measure.shotsFromCuts([{ time: 1, score: 1 }], 4);
    expect(measure.pacingCurve(shots, 4, 2)).toEqual([2, 3]);
  });

  it("merges near-identical colours", () => {
    const rgb = new Uint8Array([250, 0, 0, 252, 2, 0, 0, 0, 250, 251, 1, 1]);
    expect(measure.dominantColours(rgb)).toEqual(["#FB0100", "#0000FA"]);
  });

  it("maps the reference rhythm onto a new length and snaps to nearby beats", () => {
    const plan = measure.transplantPacing(
      [{ start: 0 }, { start: 1 }, { start: 3 }],
      4,
      8,
      [2.1, 5.9],
    );
    expect(plan.cuts).toEqual([2.1, 5.9]);
    expect(plan.shotLengths).toEqual([2.1, 3.8, 2.1]);
    expect(plan.snappedToBeat).toBe(2);
  });

  it("reports gaps with a fix, and nothing when the edits match", () => {
    const summary = (
      averageShot: number,
      firstCut: number,
      cutsInFirst3s: number,
      curve: number[],
    ) => ({
      averageShot,
      firstCut,
      cutsInFirst3s,
      pacingCurve: curve,
    });
    const reference = { summary: summary(1, 0.5, 4, [0.5, 0.5, 2, 2]), shots: [], rhythm: null };
    const slow = { summary: summary(3, 3, 0, [3, 3, 3, 3]), shots: [], rhythm: null };
    const result = measure.compareMeasurements(reference, slow);
    expect(result.findings.map((f) => f.area)).toEqual([
      "Shot length",
      "Hook",
      "Opening density",
      "Pacing shape",
    ]);
    expect(measure.compareMeasurements(reference, reference).matches).toBe(true);
  });
});

describe("analyze_reference helpers", () => {
  it("recognises only https YouTube hosts", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/abc")).toBe(true);
    expect(isYouTubeUrl("https://notyoutube.com.evil/x")).toBe(false);
    expect(isYouTubeUrl("clips/ref.mp4")).toBe(false);
  });

  it("samples short references more densely", () => {
    expect([chooseFps(10), chooseFps(45), chooseFps(120), chooseFps(600), chooseFps(null)]).toEqual(
      [5, 3, 2, 1, 1],
    );
  });

  it("parses model timestamps", () => {
    expect(parseTimestamp("01:02.5")).toBe(62.5);
    expect(parseTimestamp("2.25s")).toBe(2.25);
    expect(parseTimestamp("x")).toBeNull();
  });

  it("gives Gemini the measured shots and forbids retiming them", () => {
    const measured = {
      shots: [{ index: 0, start: 0, end: 1.25 }],
      source: { duration: 1.25 },
    } as unknown as Measured;
    const prompt = buildPrompt(measured, "the camera");
    expect(prompt).toContain("Shot 0: 0.00s to 1.25s");
    expect(prompt).toContain("Do not merge, split, add or retime shots");
    expect(prompt).toContain("Pay closest attention to: the camera");
  });

  it("lets measurement win and lists every disagreement", () => {
    const measured = {
      shots: [
        {
          index: 0,
          start: 0,
          end: 1,
          length: 1,
          cutStrength: null,
          motionEnergy: 0,
          palette: null,
        },
        { index: 1, start: 1, end: 2, length: 1, cutStrength: 1, motionEnergy: 0.6, palette: null },
        { index: 2, start: 2, end: 3, length: 1, cutStrength: 1, motionEnergy: 0.1, palette: null },
      ],
    } as unknown as Measured;
    const { shots, conflicts } = reconcile(measured, {
      shots: [
        { index: 0, camera: "push-in" },
        { index: 1, camera: "static" },
        { index: 7, camera: "orbit" },
      ],
    });
    expect(shots).toHaveLength(3);
    expect(conflicts.map((c) => c.shot)).toEqual([7, 0, 1, 2]);
  });
});

describe("analyze_reference tool", () => {
  it("measures, describes with Gemini and writes a reconciled reference", async () => {
    await makeVideo(path.join(tmp, "ref.mp4"));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.contents[0].parts[0].videoMetadata.fps).toBe(5);
      expect(body.contents[0].parts[0].inlineData.mimeType).toBe("video/mp4");
      expect(body.contents[0].parts[1].text).toContain("Shot 2: 2.50s to 4.00s");
      const described = {
        summary: "Three colour cards.",
        hook: "Red fills the frame at once.",
        whyItWorks: ["Shot 0 is short, so the opening feels quick."],
        editFollows: "none",
        shots: [0, 1, 2].map((index) => ({
          index,
          shotSize: "graphic",
          camera: "static",
          transitionOut: "cut",
        })),
      };
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(described) }] } }],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = createReferenceTool(tmp, bundle, { GEMINI_API_KEY: "test" });
    const result = String(await tool.execute({ source: "ref.mp4", targetDuration: 8 }, context()));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toContain("reference/ref.reference.json");
    const doc = JSON.parse(
      await fs.readFile(path.join(tmp, "reference", "ref.reference.json"), "utf-8"),
    );
    expect(doc.shots.map((s: { start: number }) => s.start)).toEqual([0, 1, 2.5]);
    expect(doc.shots[1].described.camera).toBe("static");
    expect(doc.overall.hook).toBe("Red fills the frame at once.");
    expect(doc.conflicts).toEqual([]);
    expect(doc.plan.cuts).toEqual([2, 5]);
    expect(doc.provenance.described).toEqual({ model: "gemini-flash-latest", fps: 5 });
  });

  it("measures without a key and says why nothing was described", async () => {
    await makeVideo(path.join(tmp, "ref.mp4"));
    vi.stubGlobal("fetch", vi.fn());
    const tool = createReferenceTool(tmp, bundle, {});
    const result = String(await tool.execute({ source: "ref.mp4" }, context()));
    expect(result).toContain("No GEMINI_API_KEY");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("compares a render against a saved reference without calling Gemini", async () => {
    await makeVideo(path.join(tmp, "ref.mp4"), [0.5, 0.5, 0.5, 2.5]);
    await makeVideo(path.join(tmp, "mine.mp4"), [3, 1]);
    vi.stubGlobal("fetch", vi.fn());
    const tool = createReferenceTool(tmp, bundle, { GEMINI_API_KEY: "test" });
    await tool.execute({ source: "ref.mp4", describe: false }, context());
    const gap = JSON.parse(
      String(
        await tool.execute(
          { source: "mine.mp4", compare: "reference/ref.reference.json" },
          context(),
        ),
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(gap.mode).toBe("gap report");
    expect(gap.comparison.findings.map((f: { area: string }) => f.area)).toContain("Hook");
  });

  it("refuses non-YouTube URLs and paths outside the workspace", async () => {
    const tool = createReferenceTool(tmp, bundle, {});
    expect(
      String(await tool.execute({ source: "https://example.com/a.mp4" }, context())),
    ).toContain("Only workspace files");
    expect(String(await tool.execute({ source: "../../etc/passwd" }, context()))).toContain(
      "escapes",
    );
  });
});

describe("analyze_reference review fixes", () => {
  it("measures the picture's length, not a longer audio track's", async () => {
    await makeVideo(path.join(tmp, "v.mp4"), [1, 1]);
    await run("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      path.join(tmp, "v.mp4"),
      "-f",
      "lavfi",
      "-i",
      "sine=d=6",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      path.join(tmp, "long.mp4"),
    ]);
    const tool = createReferenceTool(tmp, bundle, {});
    await tool.execute({ source: "long.mp4", describe: false }, context());
    const doc = JSON.parse(
      await fs.readFile(path.join(tmp, "reference", "long.reference.json"), "utf-8"),
    );
    expect(doc.source_measurement.duration).toBeCloseTo(2, 1);
    expect(doc.shots).toHaveLength(2);
    expect(doc.source_measurement.file).toBeUndefined();
  });

  it("refuses to write through a symlinked output folder", async () => {
    await makeVideo(path.join(tmp, "ref.mp4"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gg-outside-"));
    try {
      await fs.symlink(outside, path.join(tmp, "reference"));
      const tool = createReferenceTool(tmp, bundle, {});
      const result = String(await tool.execute({ source: "ref.mp4", describe: false }, context()));
      expect(result).toContain("symlink out of the workspace");
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("explains YouTube without a key honestly and rejects half-specified plans", async () => {
    const tool = createReferenceTool(tmp, bundle, { GEMINI_API_KEY: "" });
    expect(String(await tool.execute({ source: "https://youtu.be/abc" }, context()))).toContain(
      "nothing can be measured without a local file",
    );
    expect(
      String(await tool.execute({ source: "x.mp4", targetBeats: "b.json" }, context())),
    ).toContain("pass `targetDuration` too");
  });

  it("falls back to GOOGLE_API_KEY when GEMINI_API_KEY is empty", async () => {
    await makeVideo(path.join(tmp, "ref.mp4"));
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createReferenceTool(tmp, bundle, { GEMINI_API_KEY: "", GOOGLE_API_KEY: "g" });
    const result = String(await tool.execute({ source: "ref.mp4" }, context()));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toContain("Description failed");
    expect(JSON.parse(result).note).toContain("Gemini error 500");
  });

  it("reports a broken measurement instead of an empty success", async () => {
    await fs.writeFile(path.join(tmp, "bad.mp4"), "not a video");
    const tool = createReferenceTool(tmp, bundle, {});
    expect(String(await tool.execute({ source: "bad.mp4", describe: false }, context()))).toContain(
      "Measurement failed",
    );
  });

  it("reuses the reference's threshold and says which checks lacked data", async () => {
    await makeVideo(path.join(tmp, "ref.mp4"));
    await makeVideo(path.join(tmp, "mine.mp4"), [2, 2]);
    const tool = createReferenceTool(tmp, bundle, {});
    await tool.execute({ source: "ref.mp4", describe: false, threshold: 0.2 }, context());
    const gap = JSON.parse(
      String(
        await tool.execute(
          { source: "mine.mp4", compare: "reference/ref.reference.json" },
          context(),
        ),
      ),
    );
    expect(gap.comparison.compared).not.toContain("cuts on beat");
    expect(gap.comparison.notCompared.join(" ")).toContain("cuts on beat");
    const saved = JSON.parse(
      await fs.readFile(path.join(tmp, "reference", "ref.reference.json"), "utf-8"),
    );
    expect(saved.source_measurement.threshold).toBe(0.2);
  });

  it("flags a shot described twice", () => {
    const measured = {
      shots: [
        {
          index: 0,
          start: 0,
          end: 1,
          length: 1,
          cutStrength: null,
          motionEnergy: 0.1,
          palette: null,
        },
      ],
    } as unknown as Measured;
    const { conflicts } = reconcile(measured, {
      shots: [
        { index: 0, camera: "static" },
        { index: 0, camera: "orbit" },
      ],
    });
    expect(conflicts).toEqual([
      { shot: 0, issue: "Described twice; the first description is kept." },
    ]);
  });

  it("counts only snapped cuts that survive", () => {
    const plan = measure.transplantPacing([{ start: 0 }, { start: 1 }, { start: 1.02 }], 4, 4, [1]);
    expect(plan.cuts).toEqual([1]);
    expect(plan.snappedToBeat).toBe(1);
  });
});
