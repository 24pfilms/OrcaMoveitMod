# Reference video analysis: research and ideas

The goal: give Motion a reference video and get back the parts that make it
work, such as edit timing, camera moves, easing, transitions and type rhythm.
They should come back in a form Motion can build with, not as a written review.

This page covers four things: what Gemini can and can't do with video, a design
that works around its weak spots, use cases ranked by value, and a build plan.

---

## 1. What Gemini can do with video (October 2026)

| Fact | Detail |
|------|--------|
| Inputs | Uploaded files, inline video, and **public YouTube URLs** passed directly |
| Default sampling | **1 frame per second**, plus audio |
| Custom sampling | `videoMetadata.fps`, from just above 0 up to 24 |
| Clipping | `videoMetadata.startOffset` / `endOffset`, so you can study one shot at a time |
| Cost | About 300 tokens per second of video at default resolution, about 100 at low resolution. Each frame costs 258 tokens (66 at low resolution); audio costs 32 tokens per second |
| Length | About 1 hour at default resolution, 3 hours at low, on 1M-context models |
| Timestamps | `MM:SS` in prompts and answers when sampling at 1 fps or slower |

**The weak spot.** At 1 fps, Gemini can't see a cut that lasts less than a
second, and it can't measure an ease curve. One developer reported that raising
fps on Gemini 3.1 Pro didn't improve detail; Google closed that issue without a
fix. So **don't trust Gemini for timing.** Use it for meaning: what the camera
is doing, why a shot works, what kind of transition it is.

**What FFmpeg on your own machine can do.** These filters are in the
FFmpeg build here:

- `scdet` / scene score: cut times, accurate to one frame (already used in
  `beat-sync.mjs`).
- `vidstabdetect`: frame-to-frame camera motion (pan, tilt, rotation, zoom).
  A quick test on a synthetic pan picked up the right direction but gave noisy
  numbers, so this needs filtering and calibration before it's trusted.
- `mestimate`: motion vectors, a second way to measure motion.
- `signalstats`: brightness and saturation per frame, for spotting flashes,
  fades and colour shifts.
- `hf beats`: the beat grid of the reference's audio.

---

## 2. The design: measure with FFmpeg, describe with Gemini, then compare

```
reference.mp4 / YouTube URL
        │
        ├─► FFmpeg pass (exact, cheap, offline)
        │     cuts · shot lengths · camera motion curves · motion energy
        │     brightness/colour per shot · loudness · beat grid
        │
        ├─► Gemini pass, shot by shot (clipped with offsets, higher fps on short shots)
        │     shot size · camera move name · subject · transition type
        │     on-screen text + its timing · mood · "why this works"
        │
        └─► Reconcile
              Gemini's labels are attached to FFmpeg's measured shots.
              Where they disagree (Gemini says "static", FFmpeg measures a pan),
              the measurement wins and the conflict is listed, not hidden.
                        │
                        ▼
                 reference.json  →  Motion uses it to plan, build and check
```

Why this split matters: every number in the output comes from a measurement,
and every word comes from Gemini. Motion can see which is which.

---

## 3. Use cases, ranked by value

### Tier 1: worth building first

**1. Pacing transplant.** "Make mine cut like this."
FFmpeg measures the shot-length curve: for example, it starts with 0.6 s
shots, slows to 2.4 s in the middle, then ends on a 3 s hold. Motion keeps that
curve and fills it with your content, scaled to your length. You get the
reference's rhythm without copying any of its images.

**2. Gap report: your render compared with the reference.**
Run the same analysis on your own export and compare the two side by side:

> Your average shot is 2.8 s; the reference's is 1.4 s. Your first cut lands at
> 2.1 s; theirs lands at 0.5 s. They put 70% of cuts on the beat; you put 30%.
> They push in on 6 of 9 shots; you never move the camera.

This turns "make it feel more like that" into specific changes, and it plugs
straight into the craft score's Rhythm and Variety ratings.

**3. Camera move cloning.**
Turn the measured camera curve (position, zoom and rotation over time) into
keyframes. In Motion, those become GSAP or `three.mjs` camera animations. The
same data gives the move's ease shape, for example "slow start, fast middle,
long settle", which the next idea turns into a reusable ease.

**4. Arch Viz Hammer: checking camera paths, the product's main risk.**
Your PRD says the product only works if a video model follows a planned
camera path and keeps the building stable (Section 1.4). This analysis can
measure that directly:

- Measure the camera motion in each AI-generated clip.
- Compare it with the Shot Control Package's `camera.samples`, then score how
  closely the path was followed (direction, speed and timing).
- Measure **shape stability**: after allowing for camera motion, how much do the
  building's edges still move? A high number means the building is warping.

This gives Phase 0 an objective pass/fail number for each provider instead of a
judgment by eye. It also works the other way: analyse a real architectural
film you admire and turn its camera move into Shot Control Package samples for
a Blender blockout.

### Tier 2: high value, more work

**5. Ease fingerprints.** Fit each measured move to a cubic-bezier curve and
save it as a named ease, such as `ref-push-settle: cubic-bezier(.2,.0,.1,1)`. Over
time you build an ease library taken from real work you like.

**6. Transition harvest.** Gemini labels each cut (hard cut, whip pan, match
cut, morph, wipe, light leak), and FFmpeg gives each one an exact time and
length. Save the good ones as Motion library pieces with notes on how they work.

**7. Style bible from several references.** Analyse 5–10 videos a client
likes. Average their numbers into the `Taste:` line: variety, motion and
density dials, palette discipline, and shot-length range. Also list what all
of them avoid. The client's taste becomes numbers Motion can be held to.

**8. Hook teardown.** Study the first 3 seconds at the highest fps Gemini
allows, alongside FFmpeg's exact cuts: what appears first, when the first text
lands, when the first cut comes, and what the viewer understands by 1.5 s.
This feeds the craft score's Hook rating.

**9. Text-timing analysis.** Gemini reads the on-screen text, and FFmpeg times
when it appears and disappears. Output: words on screen per second, how long
each line stays, and whether text arrives on beats. This answers "how long
should my captions stay up?" with numbers taken from a video that works.

**10. Prompts for generated footage.** Write each reference shot in
video-generation terms (subject, motion, scene, framing, camera), the five-part
breakdown OpenMontage uses. Feed it to `generate_video` with your own subject
in place of theirs.

### Tier 3: useful extras

**11. Sound-to-picture map.** Lay cuts, beats, voice and loudness peaks on one
timeline to show what the edit follows: the music, the voice or neither.
**12. Benchmark library.** Store analyses of top videos by format (product
launch, explainer, real estate tour) and compare new work against the format's
typical numbers.
**13. Colour script.** Pick out the main colour of each shot, then show the
colour changes over time as one strip. Use it to plan palette changes.
**14. Retiming an existing video.** Take your finished video and a new music
track. Measure both, then shift your cuts to the new beat grid with the
smallest moves possible.

---

## 4. Output: `reference.json` (sketch)

```json
{
  "version": 1,
  "source": { "kind": "file|youtube", "duration": 31.2, "fps": 30 },
  "summary": { "shots": 18, "avgShot": 1.73, "cutsOnBeat": 0.72,
               "firstCut": 0.53, "pacingCurve": [0.6, 0.6, 0.9, 1.4, 2.4, 3.0] },
  "shots": [{
    "start": 0.0, "end": 0.53,
    "measured": { "pan": -0.8, "tilt": 0.0, "zoom": 1.06, "roll": 0,
                  "ease": "cubic-bezier(.3,0,.1,1)", "motionEnergy": 0.62,
                  "palette": ["#0E1116", "#F2B33D"] },
    "described": { "shotSize": "CU", "camera": "push-in", "subject": "...",
                   "transitionOut": "whip pan", "text": [{"t": 0.2, "words": "..."}] },
    "conflicts": []
  }],
  "whyItWorks": ["Cuts on every second beat until 6 s, then holds for the reveal"],
  "provenance": { "gemini": "model + fps per shot", "ffmpeg": "filters + thresholds" }
}
```

Motion then writes the parts it uses into `frame.md`. The
`Taste` and `Language` lines come from the summary.

---

## 5. Rules

- **Inspiration, not copying.** Use timing, structure and camera language.
  Never reuse the reference's footage, music, logos or exact layouts. A
  `differences` check confirms the new video changes at least the subject and
  the look.
- **Rights.** Local analysis needs a file you're allowed to use. YouTube URLs
  go to Gemini directly; no downloading tools are added.
- **Honesty.** Every field is tagged as measured or described. A Gemini claim
  that FFmpeg contradicts is reported as a conflict.
- **Cost check before running.** Estimate tokens from the video's length and
  resolution, then show the cost first. A 30-second ad costs only a few cents
  in tokens.

---

## 6. Build plan

**Status:** phases A, B and C are built and tested (`ref-measure.mjs`,
`analyze_reference`, and the gap report used in video-qa's craft score). D and
E are still to do. See Feature 7 in [HOW-TO.md](HOW-TO.md).

| Phase | Deliverable | Needs |
|-------|-------------|-------|
| A | `ref-measure.mjs`: cuts, shot lengths, motion energy, palette, beats → JSON | FFmpeg (bundled) |
| B | `analyze_reference` tool: per-shot Gemini pass with structured output, plus reconcile | `GEMINI_API_KEY` |
| C | Gap report: same analysis on Motion's render, diffed against the reference; wired into the craft score | A + B |
| D | Camera curves: `vidstabdetect`/`mestimate` → filtered pan/tilt/zoom/roll, then ease fitting | Calibration on known test moves |
| E | Arch Viz bridge: compare measured paths with Shot Control Package plans and score shape stability | D + the SCP schema from Arch-Viz_Hammer-V1 |

A and B together give the pacing transplant and the hook teardown. C is the
most useful single feature. E answers your PRD's main open question.

---

## Sources

- [Gemini API: video understanding](https://ai.google.dev/gemini-api/docs/video-understanding)
- [Google Cloud: video understanding (fps, offsets, timestamps)](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding)
- [Gemini media resolution](https://ai.google.dev/gemini-api/docs/media-resolution)
- [python-genai issue #2171: fps above 1 on Gemini 3.1 Pro](https://github.com/googleapis/python-genai/issues/2171)
- [OpenMontage video-reference-analyst skill](https://github.com/calesthio/OpenMontage/blob/main/skills/meta/video-reference-analyst.md)
- [Pixmind AI Video Analyzer (similar product)](https://www.pixmind.io/ai-tools/video-tools/ai-video-analyzer)
- [Vidu Motion Control (reference-driven motion)](https://www.analyticsinsight.net/artificial-intelligence/top-10-ai-video-making-and-motion-tracking-tools-in-2026)
