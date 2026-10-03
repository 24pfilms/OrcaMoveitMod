# How to use the Motion upgrades

This guide explains the six new Motion features: what each one does, how to
turn it on and how to use it. It also covers what each one can't do yet.

Motion is the part of GG that makes short videos. You describe the video you
want, and Motion plans it, builds it, checks it and gives you an MP4 file.
These upgrades change how Motion plans, checks and finishes a video.

---

## Before you start

### 1. Get the code

This repository already has the upgrades applied. Clone it and build it:

```bash
git clone https://github.com/24pfilms/OrcaMoveitMod
cd OrcaMoveitMod
pnpm install
pnpm build
```

### 2. Check that it works

```bash
cd packages/ggcoder
npx tsc --noEmit -p .
npx vitest run src/motion-agent src/tools/generate-speech.test.ts
```

All tests should pass. When this guide was written, 179 tests passed.

### 3. Add your keys (only for the features you want)

Some features call paid online services, and each one needs a key. Put the keys
in the environment that runs GG, such as your shell profile or a `.env` file
that GG loads.

| Feature | Key you need | Where to get it |
|---------|--------------|-----------------|
| Voiceover with exact captions | `ELEVENLABS_API_KEY` | elevenlabs.io → Profile → API keys |
| Voiceover (backup choice) | `OPENAI_API_KEY` | platform.openai.com → API keys |
| Generated video clips | `FAL_KEY` and `GG_VIDEO_MODEL` | fal.ai → Dashboard → Keys |

`GG_VIDEO_MODEL` is the name of the fal.ai video model you want to use, written
the way fal.ai shows it, for example `fal-ai/some-model/image-to-video`. Pick one
from fal.ai's model list. Models change often, so the patch doesn't choose one
for you.

Features 1, 2, 3 and 5 need no keys.

---

## Feature 1: Craft score

**What it does.** After Motion renders a video and the technical check passes,
it scores the video on seven things:

| Score | The question it answers |
|-------|------------------------|
| Hook | In the first 1.5 seconds, can a viewer with the sound off tell what the video is about? |
| Hierarchy | In each frame, is there one clear thing to read first? |
| Motion purpose | Does each movement explain, connect or reveal something? |
| Variety | Do the scenes change their layout to fit the content, or is every scene the same layout? |
| Rhythm | Do cuts land on the beat or the voice, and does text stay long enough to read? |
| Discipline | Do the colours and fonts follow the plan in every frame? |
| Ending | Does the video end on one clear thing? |

Each score runs from 0 to 5. Motion gives a score only when it can point to a
frame or a time. If it can't see something, such as rhythm in a silent video,
it leaves that score blank instead of guessing.

**What happens next.** Any score of 2 or lower must come with a fix that says
where the problem is, why it matters and exactly what to change. Motion makes
those fixes, renders again and checks again. This happens once. After that one
round, Motion delivers the video and tells you about any weak spot it couldn't
fix.

**How to use it.** You don't have to do anything; it runs on every new video.
After delivery, open the project's `frame.md` file and find the `Craft:` line:

```text
Craft: hook 4 · hierarchy 4 · purpose 3 · variety 3 · rhythm 4 · discipline 5 · ending 4 (round 1)
```

Use these numbers to ask for changes. "Raise the variety score" is a clear
request Motion can act on.

**Limits.** Motion scores its own work. It only sees still frames, not the video
playing, so watch the video yourself before you share it.

---

## Feature 2: Look preview

**What it does.** For longer or higher-stakes videos, Motion shows you three
still frames before it finishes the whole video. You either approve the look or
ask for a different feel.

**When it happens.** It happens when:

- the video is 30 seconds or longer, or
- it's for a launch, a brand or a paid ad.

It doesn't happen when:

- the video is short,
- you're editing an existing video,
- you gave a detailed brief or shot list, or
- you told Motion not to stop and ask.

**How to use it.** When the card appears, pick one:

- **Looks right, finish it**: Motion builds the rest in the same style.
- **Change the feel**: say what's wrong in your own words, such as "too dark"
  or "feels like a bank ad, I want it friendlier". Motion changes the look
  before building more.

You see the preview only once per video, and Motion won't ask a second time.

---

## Feature 3: Beat sync

**What it does.** When a video has music, Motion now checks whether the cuts in
the finished file land on the beat. It finds each cut by comparing frames, then
measures how far each cut is from the nearest beat.

**How to use it.** It turns on by itself when the video has music with a beat
map. Motion passes the beat map to its check tool and gets back a `rhythm`
report like this:

```json
{ "cuts": 12, "onBeat": 9, "onBeatRatio": 0.75,
  "offBeat": [{ "time": 3.33, "nearestBeat": 3.5, "offset": -0.17 }] }
```

This means 9 of 12 cuts are within a tenth of a second of a beat. The cut at
3.33 seconds is 0.17 seconds early.

Motion uses this report for the Rhythm score in Feature 1. It moves an
off-beat cut only when the move also helps the story.

**Run it yourself.** You can check any video against any beat map:

```bash
node packages/ggcoder/assets/motion/bin/beat-sync.mjs my-video.mp4 beats.json
```

Optional settings:

- `--tolerance 0.1` sets how close, in seconds, counts as "on the beat".
- `--threshold 0.3` sets how big a visual change counts as a cut. Lower it to
  catch softer transitions.

The beat map can be a cues file from the music folder, the `tempo-map.json`
that Motion's music composer writes, the output of `hf beats`, or a plain list
of times in seconds.

**Limits.** This report never fails a video. A cut can be off the beat on
purpose, and the report leaves that choice to Motion and to you. Very slow
fades may not count as cuts.

---

## Feature 4: Voiceover

**What it does.** Motion can write a script, turn it into spoken audio and put
captions on screen that match each word.

**How to use it.**

1. Add `ELEVENLABS_API_KEY` (best) or `OPENAI_API_KEY`. See "Before you
   start".
2. Ask for a video that has narration, such as "a 45-second explainer with a
   voice". If your request doesn't make it clear, Motion asks
   **"Should someone talk in it?"** and gives three choices:
   - **Yes, a voice explains it**
   - **No voice, text only**
   - **I'll record it myself**: Motion leaves gaps for your voice and adjusts
     the timing when you send the recording.
3. Motion writes the script, records it once and times every scene to the
   voice.

**What you get.** Two files appear in the project's `assets/voice/` folder:

- `<name>.mp3`: the spoken audio.
- `<name>.words.json`: each word with its start and end time.

**Two providers, two levels of accuracy.**

| Provider | Caption timing | Notes |
|----------|----------------|-------|
| ElevenLabs | Exact: comes from the audio itself | Used first if its key is set |
| OpenAI | Estimated from word length | You can describe the delivery, such as "warm and slow". Motion shows whole phrases on screen instead of single words, because the timing is a guess. |

**Tips for a better voice.**

- Write numbers the way you want them said: "twenty twenty-six", not "2026".
- Keep sentences short. A sentence that is easy to read can still be hard to
  say out loud.
- Motion turns the music down under the voice so the words stay clear.

**Limits.** Motion won't copy a real person's voice or speak facts that it
can't trace to a source.

---

## Feature 5: Mood music

**What it does.** The music folder now has a list, `library.json`, that tags
every track with its mood, energy, speed (beats per minute), length and beat
map. Motion picks music by mood instead of by file name.

**How to use it.** Nothing changes in how you ask. When you answer
"How should it feel?", Motion finds a track with that mood. If none matches,
Motion composes an original track with its built-in music composer.

**Add your own tracks.**

1. Copy the MP3 into `packages/ggcoder/assets/motion/assets/music/`.
2. Make its beat map with `hf beats` and save it as
   `cues/<track-name>.music-cues.json`.
3. Add an entry to `library.json`:

   ```json
   {
     "file": "quiet-morning.mp3",
     "title": "Quiet Morning",
     "moods": ["calm", "tender"],
     "energy": "low",
     "bpm": 72,
     "duration": 95,
     "cues": "cues/quiet-morning.music-cues.json",
     "license": "the exact license name"
   }
   ```

4. Keep the license file beside the track. Only add music you are allowed to
   use.

**What's missing.** All five current tracks are upbeat business music. The
first tracks to add are calm, tender, serious and cinematic ones.

---

## Feature 6: Generated video clips

**What it does.** Motion can create a short real-world clip of 2 to 10 seconds,
such as coffee pouring or a city street at night, when the shot can't be
built with shapes and text.

**How to use it.**

1. Add `FAL_KEY` and `GG_VIDEO_MODEL`. See "Before you start".
2. Ask for it plainly, for example "use a generated shot of rain on a window
   for the opening".
3. Motion first asks you to agree to the cost. The tool won't run until you say
   yes. Each clip costs money and can take one to five minutes.
4. Motion usually makes a still image in the video's colours first, then
   animates that image. Starting from an image keeps the colours and framing
   consistent with the rest of the video.

**What you get.** An MP4 in `assets/generated/`, placed into the video.

**What Motion won't generate:**

- text, logos, charts or app screens, which Motion draws itself so they stay
  sharp and correct,
- real people,
- footage presented as real when it isn't.

**Limits.** Results depend on the model you chose. Look at the clip before you
publish the video.

---

## The new lines in `frame.md`

Each video project keeps a short plan in `frame.md`. Three lines are new:

```text
Taste: variety 6 · motion 4 · density 3; avoid: stock purple gradients, a centred headline in every scene
Audio: music/quiet-morning.mp3 + cues/quiet-morning.music-cues.json
Craft: hook 4 · hierarchy 4 · purpose 3 · variety 3 · rhythm 4 · discipline 5 · ending 4 (round 1)
```

- **Taste** sets three dials from 1 to 10:
  - **variety**: how much the look changes from scene to scene.
  - **motion**: how much things move.
  - **density**: how much is on screen at once.

  The "avoid" list names specific things this video must not look like.
- **Audio** records which music or voice the video uses and where its timing
  comes from.
- **Craft** holds the scores from Feature 1.

You can edit these lines yourself. For example, change `motion 4` to
`motion 7`, then ask Motion to "rebuild to match the taste line".

---

## Quick troubleshooting

| Problem | Likely cause | Fix |
|---------|--------------|-----|
| "No voice provider is configured" | No voice key set | Add `ELEVENLABS_API_KEY` or `OPENAI_API_KEY`, then restart GG |
| "Generated footage is not configured" | `FAL_KEY` or `GG_VIDEO_MODEL` missing | Add both, then restart GG |
| Captions drift away from the voice | OpenAI voice with estimated timing | Switch to ElevenLabs for exact timing |
| No `rhythm` report after the check | The video has no music, or no beat map was given | Add music with a cues file, or run `beat-sync.mjs` yourself |
| Beat sync finds no cuts | Transitions are slow fades | Run it with `--threshold 0.15` |
| No look preview appeared | Video is under 30 seconds, or you gave a detailed brief | Expected. Ask "show me the look first" if you want one anyway |
