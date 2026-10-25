import { Composition } from "remotion"
import { Demo, totalFrames } from "./Demo"

export const Root = () => (
  <Composition id="Demo" component={Demo} durationInFrames={totalFrames} fps={30} width={1920} height={1080} />
)
