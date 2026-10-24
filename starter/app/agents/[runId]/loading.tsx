export default function Loading() {
  return <main className="content narrow" aria-busy="true" aria-label="Loading">
    <div className="skeleton" style={{ marginBottom: 24 }}><div className="sk w20" /><div className="sk title" /><div className="sk w80" /><div className="sk w40" /></div>
    {Array.from({ length: 8 }, (_, index) => <div className="sk-row" key={index}><div className="sk w60" /></div>)}
  </main>
}
