export default function Loading() {
  return <main className="content narrow" aria-busy="true" aria-label="Loading">
    <div className="page-head"><div className="skeleton" style={{ width: 380 }}><div className="sk title" style={{ width: 110 }} /><div className="sk w80" /></div></div>
    <div className="skeleton" style={{ marginBottom: 16, gridTemplateColumns: "repeat(3, 90px)" }}><div className="sk" /><div className="sk" /><div className="sk" /></div>
    {Array.from({ length: 6 }, (_, index) => <div className="sk-row" key={index}><div className="sk w30" /><div className="sk w80" /><div className="sk w40" /></div>)}
  </main>
}
