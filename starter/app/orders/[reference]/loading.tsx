export default function Loading() {
  return <main className="content wide" aria-busy="true" aria-label="Loading the order">
    <div className="skeleton" style={{ paddingBottom: 20, borderBottom: "1px solid var(--line)" }}>
      <div className="sk w20" /><div className="sk title" style={{ width: 320 }} /><div className="sk w80" /><div className="sk w60" />
    </div>
    <div className="case-grid">
      <div className="skeleton">{Array.from({ length: 7 }, (_, index) => <div className="sk-row" key={index}><div className="sk w40" /><div className="sk w80" /></div>)}</div>
      <div className="skeleton">{Array.from({ length: 6 }, (_, index) => <div key={index} style={{ display: "grid", gap: 6, marginBottom: 12 }}><div className="sk w30" /><div className="sk w60" /></div>)}</div>
    </div>
  </main>
}
