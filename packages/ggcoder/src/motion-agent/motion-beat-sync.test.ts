import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseBeatGrid, parseSceneChanges, alignCuts } = (await import(
  path.join(here, "..", "..", "assets", "motion", "bin", "beat-sync.mjs")
)) as {
  parseBeatGrid: (json: unknown) => { beats: number[]; strong: number[] };
  parseSceneChanges: (text: string) => { time: number; score: number }[];
  alignCuts: (
    cuts: { time: number; score: number }[],
    grid: { beats: number[]; strong: number[] },
    tolerance?: number,
  ) => Record<string, unknown>;
};

describe("beat-sync", () => {
  it("reads every beat grid Motion produces", () => {
    expect(
      parseBeatGrid({ beats: [{ time: 1 }, { time: 0.5 }], strongCues: [{ time: 1 }] }),
    ).toEqual({
      beats: [0.5, 1],
      strong: [1],
    });
    expect(parseBeatGrid({ beats: [0, 0.5], bars: [0] })).toEqual({ beats: [0, 0.5], strong: [0] });
    expect(parseBeatGrid([{ t: 2 }, 1, "x"])).toEqual({ beats: [1, 2], strong: [] });
  });

  it("parses FFmpeg scene metadata pairs only", () => {
    const text = [
      "frame:0    pts:30    pts_time:1",
      "lavfi.scene_score=0.912",
      "frame:1    pts:62    pts_time:2.066667",
      "lavfi.scene_score=0.41",
      "lavfi.scene_score=0.99",
    ].join("\n");
    expect(parseSceneChanges(text)).toEqual([
      { time: 1, score: 0.912 },
      { time: 2.066667, score: 0.41 },
    ]);
  });

  it("measures offsets and flags the strongest cuts as major", () => {
    const report = alignCuts(
      [
        { time: 1.02, score: 0.4 },
        { time: 3.33, score: 0.9 },
        { time: 2.0, score: 0.5 },
      ],
      { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], strong: [0, 2, 4] },
    );
    expect(report).toMatchObject({ ok: true, cuts: 3, onBeat: 2, onBeatRatio: 0.67 });
    expect(report.offBeat).toEqual([
      expect.objectContaining({ time: 3.33, kind: "major", nearestBeat: 3.5, nearestStrong: 4 }),
    ]);
  });

  it("refuses an empty grid instead of passing", () => {
    expect(alignCuts([{ time: 1, score: 1 }], { beats: [], strong: [] })).toMatchObject({
      ok: false,
    });
  });
});
