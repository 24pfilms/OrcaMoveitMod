# Motion upgrades

This repo is [gg-framework](https://github.com/KenKaiii/gg-framework) at
upstream commit `db99030`, plus six upgrades to Motion, its video agent.
Everything is in one commit, so `git show HEAD~1` shows the full change.

- **Craft score**: a seven-part quality score with one round of fixes
- **Look preview**: three stills to approve before a long video is finished
- **Beat sync**: checks whether the cuts land on the music's beat
- **Voiceover**: a spoken script with captions timed to each word
- **Mood music**: tracks listed and picked by mood
- **Generated footage**: paid video clips, only after you agree to the cost

How to use them: [HOW-TO.md](HOW-TO.md).

Some ideas came from [OpenMontage](https://github.com/calesthio/OpenMontage).
No OpenMontage code was copied.

Upstream license: MIT (see `/LICENSE`).

## One change from upstream

GitHub won't accept a push that contains a client secret, and upstream embeds
the Gemini CLI's public Google sign-in keys. This fork removes them. To sign in
with Gemini, set `GGCODER_GEMINI_OAUTH_CLIENT_ID` and
`GGCODER_GEMINI_OAUTH_CLIENT_SECRET` to your own Google OAuth client.
