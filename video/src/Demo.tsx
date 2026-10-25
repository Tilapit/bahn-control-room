import { AbsoluteFill, Audio, Img, Sequence, interpolate, staticFile, useCurrentFrame, Easing } from "remotion"
import { loadFont } from "@remotion/google-fonts/Inter"
import { scenes, type Part, type Scene } from "./script"
import boxesJson from "../public/shots/boxes.json"
import voDurations from "./vo-durations.json"

const { fontFamily } = loadFont()
const FPS = 30
const FADE = 12
const C = { bg: "#FAF8F3", green: "#1F5C45", ink: "#1B1B1B", muted: "#6B6A66", line: "#E4E0D6" }
type Box = { x: number; y: number; width: number; height: number }
const boxes = boxesJson as unknown as Record<string, Record<string, Box | null>>

// Scene length: 0.8 s after the last word (each ElevenLabs clip ends in ~0.35 s of silence, measured); without audio, 168 s shared by text length.
const audio = voDurations as (number | null)[]
const hasAudio = scenes.every((_, i) => typeof audio[i] === "number")
const chars = scenes.map((s) => s.vo.length)
const sum = chars.reduce((a, b) => a + b, 0)
const seconds = scenes.map((_, i) => (hasAudio ? (audio[i] as number) - 0.35 + 0.8 : Math.max(7, (chars[i] / sum) * 168)))
const frames = seconds.map((s) => Math.round(s * FPS))
const starts = frames.map((_, i) => frames.slice(0, i).reduce((a, b) => a + b, 0) - i * FADE)
export const totalFrames = starts[starts.length - 1] + frames[frames.length - 1]

// Frame within a scene where a phrase is spoken (estimated from its position in the text).
function at(scene: Scene, length: number, phrase: string): number {
  if (!phrase) return 0
  const i = scene.vo.indexOf(phrase)
  if (i < 0) throw new Error(`Phrase not in narration: ${phrase}`)
  const speech = length - 0.8 * FPS
  return Math.round((i / scene.vo.length) * speech)
}

const fade = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, start + FADE, end - FADE, end], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

export const Demo = () => (
  <AbsoluteFill style={{ background: C.bg, fontFamily, color: C.ink }}>
    {scenes.map((scene, i) => (
      <Sequence key={i} from={starts[i]} durationInFrames={frames[i]}>
        <SceneView scene={scene} length={frames[i]} first={i === 0} last={i === scenes.length - 1} />
        {hasAudio && <Audio src={staticFile(`vo/scene-${i + 1}.mp3`)} />}
      </Sequence>
    ))}
  </AbsoluteFill>
)

function SceneView({ scene, length, first, last }: { scene: Scene; length: number; first: boolean; last: boolean }) {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, FADE, length - FADE, length], [first ? 1 : 0, 1, 1, last ? 1 : 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const partStarts = scene.parts.map((p) => at(scene, length, p.at))
  const capStarts = scene.captions.map((c) => at(scene, length, c.at))
  return (
    <AbsoluteFill style={{ opacity }}>
      {scene.parts.map((p, i) => {
        const start = Math.max(0, partStarts[i] - (i ? FADE / 2 : 0))
        const end = i + 1 < scene.parts.length ? partStarts[i + 1] + FADE / 2 : length
        return (
          <Sequence key={i} from={start} durationInFrames={end - start}>
            <AbsoluteFill style={{ opacity: i ? fade(frame - start, 0, end - start + (i + 1 < scene.parts.length ? 0 : FADE)) : interpolate(frame, [end - FADE, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
              <PartView part={p.part} scene={scene} length={length} offset={start} span={end - start} />
            </AbsoluteFill>
          </Sequence>
        )
      })}
      {scene.label && <div style={{ position: "absolute", left: 120, top: 34, fontSize: 24, fontWeight: 500, color: C.muted, letterSpacing: 0.2 }}>{scene.label}</div>}
      {scene.captions.map((c, i) => {
        const start = capStarts[i]
        const end = i + 1 < scene.captions.length ? capStarts[i + 1] : length
        const o = fade(frame, start, end)
        if (o <= 0) return null
        return (
          <div key={i} style={{ position: "absolute", left: 120, bottom: 40, fontSize: 44, fontWeight: 600, letterSpacing: -0.5, opacity: o, transform: `translateY(${(1 - o) * 8}px)` }}>
            {c.text}
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

function PartView({ part, scene, length, offset, span }: { part: Part; scene: Scene; length: number; offset: number; span: number }) {
  switch (part.kind) {
    case "title":
      return <Title />
    case "slide":
      return <Slide lines={part.lines} />
    case "diagram":
      return <Diagram span={span} />
    case "shot":
      return <Shot img={part.img} span={span} highlights={part.highlights.map((h) => ({ box: boxes[part.img]?.[h.box] ?? null, at: at(scene, length, h.at) - offset }))} />
    case "demo":
      return <RealVsDemo />
    case "built":
      return <Built lines={part.lines.map((l) => ({ text: l.text, at: at(scene, length, l.at) - offset }))} />
    case "end":
      return <EndCard />
  }
}

function Title() {
  const frame = useCurrentFrame()
  const a = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" })
  const b = interpolate(frame, [18, 32], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 200 }}>
      <div style={{ width: 64, height: 6, background: C.green, borderRadius: 3, marginBottom: 40, opacity: a }} />
      <div style={{ fontSize: 112, fontWeight: 700, letterSpacing: -3, opacity: a }}>Bahn Control Room</div>
      <div style={{ fontSize: 48, color: C.muted, marginTop: 24, opacity: b }}>Agents do the legwork. People make the judgement calls.</div>
    </AbsoluteFill>
  )
}

function Slide({ lines }: { lines: string[] }) {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 200, paddingRight: 200 }}>
      {lines.map((l, i) => {
        const o = interpolate(frame, [i * 30, i * 30 + 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        return (
          <div key={i} style={{ fontSize: 68, fontWeight: i === lines.length - 1 ? 700 : 500, letterSpacing: -1.5, lineHeight: 1.25, marginBottom: 18, opacity: o, color: i === lines.length - 1 ? C.green : C.ink }}>
            {l}
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

// Screenshot in a rounded frame; the camera eases toward each highlight in turn (max 1.25x).
const FRAME = { x: 192, y: 92, w: 1536, h: 864 } // 16:9-ish window onto a 1440x900 page (scale 1.0667 → 960 tall, cropped by camera)
function Shot({ img, highlights, span }: { img: string; highlights: { box: Box | null; at: number }[]; span: number }) {
  const frame = useCurrentFrame()
  const scale0 = FRAME.w / 1440 // page px → frame px at zoom 1
  const pageH = 900 * scale0
  // Camera keyframes in page coordinates.
  type Cam = { cx: number; cy: number; z: number }
  const home: Cam = { cx: 720, cy: 450, z: 1 }
  const keys: { t: number; cam: Cam }[] = [{ t: 0, cam: home }]
  for (const h of highlights) {
    if (!h.box) continue
    const z = Math.min(1.25, Math.max(1.06, Math.min((FRAME.w * 0.8) / (h.box.width * scale0), (FRAME.h * 0.7) / (h.box.height * scale0))))
    keys.push({ t: Math.max(h.at, 1), cam: { cx: h.box.x + h.box.width / 2, cy: h.box.y + h.box.height / 2, z } })
  }
  let cam = keys[0].cam
  for (let i = 1; i < keys.length; i++) {
    const p = interpolate(frame, [keys[i].t, keys[i].t + 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) })
    if (p <= 0) break
    cam = { cx: cam.cx + (keys[i].cam.cx - cam.cx) * p, cy: cam.cy + (keys[i].cam.cy - cam.cy) * p, z: cam.z + (keys[i].cam.z - cam.z) * p }
  }
  // Slow push-in on top of the keyframes, so the picture never sits still.
  const drift = interpolate(frame, [0, span], [0, 0.03])
  const z = Math.min(1.25, cam.z + drift)
  const s = scale0 * z
  // Keep the page covering the window.
  const tx = Math.min(0, Math.max(FRAME.w - 1440 * s, FRAME.w / 2 - cam.cx * s))
  const ty = Math.min(0, Math.max(FRAME.h - 900 * s, FRAME.h / 2 - cam.cy * s))
  const active = [...highlights].reverse().find((h) => h.box && frame >= h.at)
  const hlOpacity = active ? interpolate(frame, [active.at, active.at + 15], [0, 1], { extrapolateRight: "clamp" }) : 0
  const enter = interpolate(frame, [0, 18], [0.985, 1], { extrapolateRight: "clamp" })
  const pad = 6
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: FRAME.x, top: FRAME.y, width: FRAME.w, height: Math.min(FRAME.h, pageH), borderRadius: 18, overflow: "hidden", boxShadow: "0 24px 60px rgba(40,35,20,0.14), 0 2px 8px rgba(40,35,20,0.08)", transform: `scale(${enter})`, background: "#fff" }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: 1440, height: 900, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${s})` }}>
          <Img src={staticFile(`shots/${img}.png`)} style={{ width: 1440, height: 900, display: "block" }} />
          {active?.box && (
            <div style={{ position: "absolute", left: active.box.x - pad, top: active.box.y - pad, width: active.box.width + pad * 2, height: active.box.height + pad * 2, borderRadius: 10, border: `${3 / s}px solid ${C.green}`, boxShadow: `0 0 0 4000px rgba(20,20,10,${0.12 * hlOpacity})`, opacity: hlOpacity }} />
          )}
        </div>
      </div>
    </AbsoluteFill>
  )
}

// The pipeline: boxes appear left to right while a dot travels along the arrows.
const STEPS = [
  ["Message or signal", "reads every message"],
  ["Classifier · Haiku", "reads every message"],
  ["Code: urgency, routing, rules", "no model, no cost"],
  ["Investigator · Sonnet → Opus", "asks, looks up, proposes"],
  ["Verifier · Haiku", "checks every fact"],
  ["For you", "only what needs you"],
  ["Person decides", "approve, reply or take over"],
  ["Executor · code", "does only what was approved"],
]
STEPS[0][1] = "driver chat, support, email, GPS"
function Diagram({ span }: { span: number }) {
  const frame = useCurrentFrame()
  const W = 196, H = 132, GAP = 30, X0 = (1920 - (STEPS.length * W + (STEPS.length - 1) * GAP)) / 2, Y = 330
  const per = Math.min(36, (span * 0.6) / STEPS.length)
  const shown = (i: number) => interpolate(frame, [i * per, i * per + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const dotT = (frame % Math.round(per * STEPS.length)) / per
  const dotStep = Math.min(STEPS.length - 2, Math.floor(dotT))
  const dotP = dotT - Math.floor(dotT)
  const dotX = X0 + dotStep * (W + GAP) + W + dotP * GAP
  const side = (delay: number) => interpolate(frame, [STEPS.length * per + delay, STEPS.length * per + delay + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const inv = X0 + 3 * (W + GAP)
  const person = (i: number) => i === 6
  const isCode = (i: number) => i === 2 || i === 7 || i === 0
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 120, top: 150, fontSize: 52, fontWeight: 700, letterSpacing: -1.2 }}>From a message to a decision</div>
      {STEPS.map(([name, sub], i) => (
        <div key={i}>
          <div style={{ position: "absolute", left: X0 + i * (W + GAP), top: Y, width: W, height: H, borderRadius: 14, border: `2px ${isCode(i) ? "dashed" : "solid"} ${person(i) ? C.green : "#BDB7A8"}`, background: person(i) ? "#E3EEE8" : "#fff", opacity: shown(i), transform: `translateY(${(1 - shown(i)) * 10}px)`, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 12, fontSize: 23, fontWeight: 650, lineHeight: 1.2 }}>
            {name}
          </div>
          <div style={{ position: "absolute", left: X0 + i * (W + GAP) - 6, top: Y + H + 16, width: W + 12, textAlign: "center", fontSize: 19, color: C.muted, lineHeight: 1.3, opacity: shown(i) }}>{sub}</div>
          {i < STEPS.length - 1 && <div style={{ position: "absolute", left: X0 + i * (W + GAP) + W + 4, top: Y + H / 2 - 1, width: GAP - 8, height: 2, background: "#9C9686", opacity: shown(i + 1) }} />}
        </div>
      ))}
      <div style={{ position: "absolute", left: dotX - 7, top: Y + H / 2 - 7, width: 14, height: 14, borderRadius: 7, background: C.green, opacity: shown(1) }} />
      {/* Monitor feeds the Investigator; Driver support takes routine questions from routing. */}
      <div style={{ position: "absolute", left: inv + W / 2 - 1, top: Y + H + 70, width: 2, height: 64, background: "#9C9686", opacity: side(0) }} />
      <div style={{ position: "absolute", left: inv - 70, top: Y + H + 134, width: W + 140, borderRadius: 14, border: "2px dashed #BDB7A8", background: "#fff", padding: "18px 16px", textAlign: "center", fontSize: 22, fontWeight: 600, opacity: side(0) }}>
        Monitor · code
        <div style={{ fontSize: 18, fontWeight: 400, color: C.muted, marginTop: 6 }}>GPS, bookings, disruption feeds</div>
      </div>
      <div style={{ position: "absolute", left: X0 + 2 * (W + GAP) - 150, top: Y + H + 134, width: W + 60, borderRadius: 14, border: "2px solid #BDB7A8", background: "#fff", padding: "18px 16px", textAlign: "center", fontSize: 22, fontWeight: 600, opacity: side(20) }}>
        Driver support · Sonnet
        <div style={{ fontSize: 18, fontWeight: 400, color: C.muted, marginTop: 6 }}>routine driver questions</div>
      </div>
      <div style={{ position: "absolute", left: 120, top: 860, display: "flex", gap: 36, fontSize: 20, color: C.muted, opacity: side(30) }}>
        <span><Swatch dashed={false} /> a model</span>
        <span><Swatch dashed /> code, no model</span>
        <span><Swatch dashed={false} person /> a person</span>
      </div>
    </AbsoluteFill>
  )
}
const Swatch = ({ dashed, person }: { dashed: boolean; person?: boolean }) => (
  <span style={{ display: "inline-block", width: 28, height: 16, borderRadius: 4, border: `2px ${dashed ? "dashed" : "solid"} ${person ? C.green : "#BDB7A8"}`, background: person ? "#E3EEE8" : "#fff", verticalAlign: -2, marginRight: 8 }} />
)

function RealVsDemo() {
  const frame = useCurrentFrame()
  const o = (d: number) => interpolate(frame, [d, d + 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const col = (title: string, items: string[], d: number, accent: boolean) => (
    <div style={{ flex: 1, opacity: o(d), borderTop: `4px solid ${accent ? C.green : "#BDB7A8"}`, paddingTop: 24 }}>
      <div style={{ fontSize: 34, fontWeight: 700, marginBottom: 20, color: accent ? C.green : C.ink }}>{title}</div>
      {items.map((t, i) => <div key={i} style={{ fontSize: 26, lineHeight: 1.35, marginBottom: 12, color: C.ink }}>{t}</div>)}
    </div>
  )
  return (
    <AbsoluteFill style={{ padding: "150px 120px 0" }}>
      <div style={{ display: "flex", gap: 64 }}>
        {col("From Bahn's dataset", ["100 orders", "Every message, GPS point, booking, alert and document", "Bahn's own agent proposals"], 10, false)}
        {col("Real", ["The agents' reasoning and tool use (recorded runs of Claude models)", "The rules, urgency, ownership and timeline", "The tests"], 60, true)}
        {col("Simulated for the demo", ["Driver and site replies", "Repair shops, ferry and train options", "Disruption notices", "Colleagues Anna and Mikko", "900 synthetic orders for scale", "The demo clock at 21 Oct 12:58"], 110, false)}
      </div>
      <div style={{ position: "absolute", left: 120, right: 120, bottom: 70, fontSize: 30, color: C.muted, opacity: o(170), borderTop: `1px solid ${C.line}`, paddingTop: 28 }}>
        Runs from a fresh clone without an API key, using recorded agent runs. With a key, agents run live.
      </div>
    </AbsoluteFill>
  )
}

function Built({ lines }: { lines: { text: string; at: number }[] }) {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "0 120px" }}>
      {lines.map((l, i) => {
        const o = interpolate(frame, [l.at, l.at + 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        return (
          <div key={i} style={{ display: "flex", gap: 28, alignItems: "baseline", marginBottom: 34, opacity: o, transform: `translateY(${(1 - o) * 10}px)` }}>
            <span style={{ fontSize: 28, fontWeight: 700, color: C.green, width: 30 }}>{i + 1}</span>
            <span style={{ fontSize: 42, fontWeight: 500, letterSpacing: -0.6, lineHeight: 1.25 }}>{l.text}</span>
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

function EndCard() {
  return (
    <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 200, background: C.bg }}>
      <div style={{ width: 64, height: 6, background: C.green, borderRadius: 3, marginBottom: 40 }} />
      <div style={{ fontSize: 104, fontWeight: 700, letterSpacing: -3 }}>Bahn Control Room</div>
      <div style={{ fontSize: 38, color: C.green, marginTop: 24, fontWeight: 600 }}>github.com/Tilapit/bahn-control-room</div>
      <div style={{ fontSize: 44, color: C.muted, marginTop: 40 }}>Agents do the legwork. People make the judgement calls.</div>
    </AbsoluteFill>
  )
}
