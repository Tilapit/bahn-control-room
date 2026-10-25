# Bahn Control Room — demo video

Remotion project, 1920x1080, 30 fps. Output: `out/bahn-control-room-demo.mp4` (not committed).

- `node scripts/shots.mts` then `node scripts/shots-extra.mts`: light-theme screenshots of the running app
  (http://localhost:3001, read-only) into `public/shots/`, with element boxes in `public/shots/boxes.json`.
  Boxes for the source chips, "(quotes, not booked)", the trace rows, the Sources sections, the
  permissions intro, the How it works diagram and the Who column were measured by hand from the
  2x screenshots, because no single element matched.
- `npx tsx scripts/tts.ts`: one ElevenLabs mp3 per scene into `public/vo/` (needs `ELEVENLABS_API_KEY`,
  optional `ELEVENLABS_VOICE_ID`, in `video/.env`); writes `src/vo-durations.json` so each scene lasts
  audio + 0.8 s. Without it, the 168 s are shared by narration length and the video is silent.
- `src/script.ts`: narration, captions and highlights per scene, anchored to phrases in the narration.
- `npm run studio` (port 3100), `npm run render`.
