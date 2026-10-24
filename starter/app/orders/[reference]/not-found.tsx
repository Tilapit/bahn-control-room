import Link from "next/link"

export default function NotFound() {
  return <main className="content narrow"><div className="empty">
    <h2>There is no order with that reference.</h2>
    <p>Check the reference, or <Link className="link" href="/orders">search all orders</Link>.</p>
  </div></main>
}
