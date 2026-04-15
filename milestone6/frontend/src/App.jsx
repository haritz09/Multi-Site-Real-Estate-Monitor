import { useState, useEffect } from 'react'
function App() {
  const [stats, setStats] = useState({ total_active: 0, recent_changes: [], histogram: [] });
  const [listings, setListings] = useState([]);
  const [changes, setChanges] = useState([]);
  const [sortConfig, setSortConfig] = useState({ key: 'last_seen', direction: 'desc' });
  const [changesPage, setChangesPage] = useState(1);

  const CHANGES_PER_PAGE = 6;
  const totalChangePages = Math.ceil(changes.length / CHANGES_PER_PAGE) || 1;
  const displayedChanges = changes.slice((changesPage - 1) * CHANGES_PER_PAGE, changesPage * CHANGES_PER_PAGE);

  useEffect(() => {
    fetch('/api/stats').then(r => r.json()).then(setStats).catch(console.error);
    fetch('/api/listings').then(r => r.json()).then(setListings).catch(console.error);
    fetch('/api/changes').then(r => r.json()).then(setChanges).catch(console.error);
  }, []);

  const handleSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') direction = 'desc';
    setSortConfig({ key, direction });
  };

  const sortedListings = [...listings].sort((a, b) => {
    let valA = a[sortConfig.key];
    let valB = b[sortConfig.key];
    if (sortConfig.key === 'price_num') {
      valA = parseFloat(valA || 0); valB = parseFloat(valB || 0);
    }
    if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
    if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const maxHistogramCount = stats.histogram?.length > 0 ? Math.max(...stats.histogram.map(b => b.count)) : 1;

  return (
    <div className="dashboard-container">
      <header className="header">
        <h1>IPARRALDE REALS</h1>
        <p style={{ marginTop: '1rem', fontWeight: '700' }}>Real Estate Analytics Terminal v1.0</p>
      </header>

      <section className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats.total_active}</div>
          <div className="stat-label">Total Active</div>
        </div>
        {stats.recent_changes?.map(c => (
          <div className="stat-card" key={c.change_type}>
            <div className="stat-value">{c.count}</div>
            <div className="stat-label">{c.change_type} (Since last run)</div>
          </div>
        ))}
        {stats.histogram?.length > 0 && (
          <div className="stat-card" style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column' }}>
            <div className="stat-label" style={{ marginBottom: '1rem' }}>Price Histogram</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', height: '100px' }}>
              {stats.histogram.map(b => (
                <div key={b.range} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
                  <div style={{ width: '100%', height: `${Math.max((b.count / maxHistogramCount) * 100, 2)}%`, background: 'var(--text-color)', border: '2px solid black', boxSizing: 'border-box' }}></div>
                  <div style={{ fontSize: '0.7rem', marginTop: '5px' }}>{b.range}</div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 'bold' }}>{b.count}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="listing-grid">
        <section className="main-content">
          <h2>[ Active Inventory ]</h2>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th onClick={() => handleSort('siteId')}>Site {sortConfig.key==='siteId'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                  <th onClick={() => handleSort('title')}>Title {sortConfig.key==='title'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                  <th onClick={() => handleSort('location')}>LOCATION {sortConfig.key==='location'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                  <th onClick={() => handleSort('price_num')}>Price {sortConfig.key==='price_num'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                  <th onClick={() => handleSort('first_seen')}>First Seen {sortConfig.key==='first_seen'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                </tr>
              </thead>
              <tbody>
                {sortedListings.map(l => (
                  <tr key={l.id}>
                    <td><strong>{l.siteId}</strong></td>
                    <td><a href={l.url} target="_blank" rel="noreferrer" title={l.id}>{l.title}</a></td>
                    <td>{l.location}</td>
                    <td><strong style={{ fontSize: '1.2rem', color: 'var(--accent-color)' }}>{l.price}</strong></td>
                    <td style={{ fontSize: '0.8rem' }}>{l.first_seen?.split('T')[0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="feed-container">
          <div className="feed-header">Recent Events</div>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div style={{ flex: 1, overflowY: 'auto' }}>
               {displayedChanges.map(c => {
                const diff = c.diff_json || {};
                return (
                <div className="feed-item" key={c.change_id}>
                  <div><span className={`badge ${c.change_type}`}>{c.change_type}</span></div>
                  <div><a href={c.url} target="_blank" rel="noreferrer"><strong>{c.title}</strong></a></div>
                  {c.change_type === 'price_changed' && (
                    <div style={{ background: 'var(--bg-color)', border: '1px solid black', padding: '0.5rem', marginTop: '0.5rem' }}>
                      Price: <del>{diff.old_price}</del> ➔ <strong>{diff.new_price}</strong>
                    </div>
                  )}
                  {c.change_type === 'new' && diff.new_price && (
                    <div style={{ background: 'var(--bg-color)', border: '1px solid black', padding: '0.5rem', marginTop: '0.5rem' }}>
                      New Listing: <strong>{diff.new_price}</strong>
                    </div>
                  )}
                  <div className="timestamp">{new Date(c.created_at).toLocaleString()}</div>
                </div>
               )})}
            </div>
            {changes.length > CHANGES_PER_PAGE && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', borderTop: '2px solid black', paddingTop: '1rem' }}>
                <button 
                  disabled={changesPage === 1} 
                  onClick={() => setChangesPage(p => p - 1)}
                  style={{ background: 'var(--bg-color)', color: changesPage === 1 ? '#999' : 'var(--text-color)', border: '2px solid black', padding: '0.3rem 0.6rem', cursor: changesPage === 1 ? 'not-allowed' : 'pointer', fontWeight: 'bold', fontFamily: 'inherit' }}
                >
                  PREV
                </button>
                <span style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>{changesPage} / {totalChangePages}</span>
                <button 
                  disabled={changesPage >= totalChangePages} 
                  onClick={() => setChangesPage(p => p + 1)}
                  style={{ background: 'var(--bg-color)', color: changesPage >= totalChangePages ? '#999' : 'var(--text-color)', border: '2px solid black', padding: '0.3rem 0.6rem', cursor: changesPage >= totalChangePages ? 'not-allowed' : 'pointer', fontWeight: 'bold', fontFamily: 'inherit' }}
                >
                  NEXT
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
export default App;
