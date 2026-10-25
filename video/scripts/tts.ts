// Writes one mp3 per scene to public/vo/ with ElevenLabs, then records each length in src/vo-durations.json
// so scene lengths follow the voice. Needs ELEVENLABS_API_KEY (and optionally ELEVENLABS_VOICE_ID) in video/.env.
// Run: npx tsx scripts/tts.ts
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { scenes } from "../src/script"

const env = existsSync(".env") ? Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])) : {}
const key = env.ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_API_KEY
if (!key) { console.log("No ELEVENLABS_API_KEY in video/.env: the video renders without a voice."); process.exit(0) }

async function main() {
  let voice = env.ELEVENLABS_VOICE_ID ?? process.env.ELEVENLABS_VOICE_ID
  if (!voice) {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key! } })
    const { voices } = (await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] }
    const calm = voices.find((v) => /calm|narrat/i.test(JSON.stringify(v.labels ?? {})) && /american|british|english/i.test(JSON.stringify(v.labels ?? {}))) ?? voices[0]
    voice = calm.voice_id
    console.log(`Voice: ${calm.name} (${voice})`)
  }
  // Scene numbers as arguments re-record only those scenes; the others keep their audio.
  const only = process.argv.slice(2).map(Number)
  const durations: number[] = existsSync("src/vo-durations.json") ? JSON.parse(readFileSync("src/vo-durations.json", "utf8")) : []
  for (const [i, scene] of scenes.entries()) {
    if (only.length && !only.includes(i + 1)) continue
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: { "xi-api-key": key!, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: scene.vo, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    })
    if (!res.ok) throw new Error(`Scene ${i + 1}: ${res.status} ${await res.text()}`)
    const file = `public/vo/scene-${i + 1}.mp3`
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    const out = execFileSync("npx", ["remotion", "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim()
    durations[i] = Number(out)
    console.log(file, out)
  }
  writeFileSync("src/vo-durations.json", JSON.stringify(durations))
}
main().catch((e) => { console.error(e); console.log("ElevenLabs failed: rendering without a voice."); writeFileSync("src/vo-durations.json", "[]") })
