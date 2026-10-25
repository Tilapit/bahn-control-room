"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

/** Says which reference was not found, so a typo is visible, and leads back to the order list. */
export default function NotFound() {
  const reference = decodeURIComponent(usePathname()?.split("/").pop() ?? "")
  return <main className="content narrow">
    <nav className="crumbs" aria-label="Breadcrumb"><Link href="/orders">Orders</Link><span>/</span><span>{reference || "Not found"}</span></nav>
    <div className="empty">
      <h2>There is no order {reference ? <>“{reference}”</> : "with that reference"}.</h2>
      <p>Check the reference, or <Link className="link" href={`/orders${reference ? `?q=${encodeURIComponent(reference.replace(/^CD-/i, ""))}` : ""}`}>search all orders</Link>.</p>
    </div>
  </main>
}
