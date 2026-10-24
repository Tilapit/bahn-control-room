import type { SVGProps } from "react"

// A small stroke icon set at text size. Icons mark a kind of thing; words carry the meaning.
const PATHS: Record<string, string> = {
  inbox: "M2.5 9.2 4 3.5h8l1.5 5.7v3.3h-11z M2.5 9.2h3.3l.8 1.6h2.8l.8-1.6h3.3",
  bot: "M4 6h8v7H4z M8 3.2V6 M6.4 9.4h.1 M9.6 9.4h.1 M2 9v2 M14 9v2",
  list: "M5.5 4h8 M5.5 8h8 M5.5 12h8 M2.5 4h.1 M2.5 8h.1 M2.5 12h.1",
  settings: "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z M8 1.8v1.6 M8 12.6v1.6 M14.2 8h-1.6 M3.4 8H1.8 M12.4 3.6l-1.1 1.1 M4.7 11.3l-1.1 1.1 M12.4 12.4l-1.1-1.1 M4.7 4.7 3.6 3.6",
  search: "M7 11.5A4.5 4.5 0 1 0 7 2.5a4.5 4.5 0 0 0 0 9Z M10.3 10.3 13.5 13.5",
  arrow: "M3 8h10 M9.2 4.2 13 8l-3.8 3.8",
  chevron: "M6 3.5 10.5 8 6 12.5",
  car: "M2.4 10.6V8.2l1.5-3.3h8.2l1.5 3.3v2.4H2.4Z M4.4 12.8v-2.2 M11.6 12.8v-2.2 M4.6 8.6h.1 M11.3 8.6h.1",
  route: "M3.5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z M12.5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z M3.5 10.5V7.5a2 2 0 0 1 2-2h5.5",
  driver: "M8 8.2A2.9 2.9 0 1 0 8 2.4a2.9 2.9 0 0 0 0 5.8Z M2.8 14c.5-2.9 2.6-4.3 5.2-4.3s4.7 1.4 5.2 4.3",
  building: "M3 13.5V3.5h7v10 M10 7.5h3v6 M5.2 6h.1 M7.6 6h.1 M5.2 8.6h.1 M7.6 8.6h.1 M5.2 11.2h.1 M7.6 11.2h.1 M1.8 13.5h12.4",
  ferry: "M2.3 10.4 8 12.5l5.7-2.1-1.1 3H3.4l-1.1-3Z M4.3 9.6V5.8h7.4v3.8 M8 5.8V3.4",
  clock: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z M8 4.8V8l2.2 1.4",
  check: "M3 8.4l3.2 3.1L13 4.8",
}

export function Icon({ name, size = 16, className, ...rest }: { name: string; size?: number } & SVGProps<SVGSVGElement>) {
  const d = PATHS[name] ?? PATHS.chevron
  return <svg
    viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    className={`icon${className ? ` ${className}` : ""}`} {...rest}
  ><path d={d} /></svg>
}
