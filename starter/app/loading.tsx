export default function Loading() {
  return <main className="content narrow" aria-busy="true" aria-label="Loading">
    <div className="page-head"><div className="skeleton" style={{ width: 360 }}><div className="sk title" style={{ width: 120 }} /><div className="sk w80" /></div></div>
    <div className="queue">
      {[0, 1, 2, 3, 4].map((index) => <div className="sk-row" key={index}>
        <div className="sk title" /><div className="sk w60" /><div className="sk w40" />
      </div>)}
    </div>
  </main>
}
