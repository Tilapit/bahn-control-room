export default function Loading() {
  return <main className="content wide" aria-busy="true" aria-label="Loading">
    <div className="skeleton" style={{ marginBottom: 24 }}><div className="sk title" style={{ width: 160 }} /><div className="sk w40" /></div>
    <div className="sk" style={{ height: 44, maxWidth: 680, borderRadius: 12, marginBottom: 16 }} />
    {Array.from({ length: 10 }, (_, index) => <div className="sk-row" key={index}><div className="sk w60" /><div className="sk w30" /></div>)}
  </main>
}
