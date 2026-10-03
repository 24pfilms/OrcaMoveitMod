# Creative rubric

Use once per new video, after `motion_check` passes and before delivery. It
scores the render you just inspected against the plan in `frame.md`; it is not
a second technical check and not a different creative direction. The same agent
scores it from the images `motion_check` already returned. No subagent, no
separate model, no approval card.

## Score seven dimensions, 0–5 (higher is better)

| Dimension | 5 looks like | 0–2 looks like |
|-----------|--------------|----------------|
| **Hook** | The first 1.5 s shows the concept in motion; a muted phone viewer knows what this is about. | A logo sting, an empty background or a title that slides up and sits. |
| **Hierarchy** | Every frame has one obvious thing to read first; secondary text waits its turn. | Two or more elements compete; the eye has no entry point. |
| **Motion purpose** | Each move explains, connects or reveals something; the motif carries between scenes. | Generic drift, fades and pops that would fit any video. |
| **Variety** | Scene grammar changes with the content (scale, framing, density) while the motif anchors it. | Every scene is the same layout with new words: an animated slide deck. |
| **Rhythm** | Cuts and reveals land on the beat or the voice; holds breathe where reading needs them. | Uniform scene lengths, reveals between beats, text gone before it can be read. |
| **Discipline** | Palette and type roles from `Language` hold in every frame. | Off-palette accents, a third font, roles swapped mid-video. |
| **Ending** | Ends on one clear thing: the product, the next step or the feeling. | Fades to nothing, or crams three calls to action. |

Score only from evidence: a frame, a timestamp, a `motion_check` finding or a
line in `frame.md`. A dimension you cannot see in the returned images (rhythm
without audio, for example) is **unscored**, not 5.

## Turn low scores into fixes

For every dimension at 2 or below, write one finding with all three parts:

1. **Where**: scene and timestamp, or the frame it shows in.
2. **Why** it scores low, in one line, tied to `Concept` or `Language`.
3. **Fix**: the concrete change ("move the price reveal from 4.4 s to the strong
   cue at 4.10 s", "drop the subtitle on scene 3; it competes with the stat").
   A finding without a concrete fix is a note for the delivery message, not a fix.

Before fixing, scan the rest of the video for the same problem; fix the whole
class at once.

## One round

- Average ≥ 3.5 and no dimension ≤ 2: deliver.
- Any dimension ≤ 2: apply those fixes only, render, spot-check the changed
  moments, run the full `motion_check` once, rescore. Deliver after this round
  whatever the score; name an unresolved weak spot plainly in the delivery
  message as something you can change next.
- Never use the rubric to add effects, restyle or retime scenes that scored 3+.

Record the scores in `frame.md` on one line so follow-up edits know where the
video stands:

```text
Craft: hook 4 · hierarchy 4 · purpose 3 · variety 3 · rhythm 4 · discipline 5 · ending 4 (round 1)
```

Edits to an existing video rescore only the dimensions the edit touched.
