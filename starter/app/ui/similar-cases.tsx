"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import type { SimilarCase } from "@/lib/learning"
import { OUTCOME_WORDS } from "@/lib/reasons"

const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)).replace(",", "")

/**
 * "Similar past cases": up to 3 earlier decisions on the same kind of proposal, each with what people decided, why,
 * and whether it worked. Fetched for one card; nothing is shown when there are none.
 */
export function SimilarCases({ cardId }: { cardId: string }) {
  const [cases, setCases] = useState<SimilarCase[] | null>(null)
  useEffect(() => {
    let live = true
    fetch(`/api/cards/${encodeURIComponent(cardId)}/similar`).then((response) => response.ok ? response.json() : { cases: [] })
      .then((body: { cases?: SimilarCase[] }) => { if (live) setCases(body.cases ?? []) }).catch(() => { if (live) setCases([]) })
    return () => { live = false }
  }, [cardId])
  if (!cases?.length) return null
  return <section className="similar" aria-label="Similar past cases">
    <h3>Similar past cases</h3>
    <ul>
      {cases.map((item) => <li key={item.id}>
        {item.reference ? <Link className="link" href={`/orders/${item.reference}`}>{item.reference}</Link> : <span>An order</span>}
        <span className="faint"> · {day(item.decidedAt)}{item.origin === "seeded" ? " · demo history" : ""}</span>
        <span className="similar-line">{item.proposal}: {item.verdict}{item.reasonText ? ` (“${item.reasonText}”)` : ""}
          {item.outcome ? <> · <b className={`outcome ${item.outcome}`}>{OUTCOME_WORDS[item.outcome]}</b></>
            : <span className="faint"> · {item.verdict.startsWith("rejected") ? "nothing was carried out" : "outcome not checked yet"}</span>}</span>
      </li>)}
    </ul>
  </section>
}
