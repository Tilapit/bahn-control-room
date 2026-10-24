export default function Loading() {
  return <main className="content narrow" aria-busy="true" aria-label="Loading">
    <div className="skeleton" style={{ marginBottom: 24 }}><div className="sk title" style={{ width: 120 }} /><div className="sk w80" /></div>
    {Array.from({ length: 8 }, (_, index) => <div className="sk-row" key={index}><div className="sk w60" /><div className="sk w30" /></div>)}
  </main>
}
