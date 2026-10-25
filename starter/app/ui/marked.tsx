/** Text with «marked» words (the words someone searched for), highlighted. */
export function Marked({ text }: { text: string }) {
  return <>{text.split(/(«[^»]*»)/).map((part, index) => part.startsWith("«") && part.endsWith("»") ? <mark key={index}>{part.slice(1, -1)}</mark> : part)}</>
}
