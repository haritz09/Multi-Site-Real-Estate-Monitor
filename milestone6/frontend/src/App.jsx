import { useState, useEffect } from 'react'

const FAVORITES_STORAGE_KEY = 'iparralde-favorites';

function readFavoritesFromStorage() {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeFavoritesToStorage(favorites) {
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
}

function Sparkline({ points, fallbackPrice }) {
  const safePoints = Array.isArray(points)
    ? points.filter((p) => Number.isFinite(Number(p?.price))).map((p) => Number(p.price))
    : [];

  // If there is no historical change yet, use current listing price so we still render a meaningful mini-chart.
  const values = safePoints.length > 0
    ? safePoints
    : (Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? [fallbackPrice] : []);

  if (values.length === 0) {
    return <span style={{ fontSize: '0.75rem' }}>-</span>;
  }

  // Duplicate single-point series to avoid rendering only an isolated dot.
  const series = values.length === 1 ? [values[0], values[0]] : values;
  let min = Math.min(...series);
  let max = Math.max(...series);

  // Increase legibility when prices changed very little relative to total value.
  if (max !== min) {
    const range = max - min;
    const minVisualRange = Math.max(max * 0.015, 2500);
    if (range < minVisualRange) {
      const mid = (max + min) / 2;
      min = mid - minVisualRange / 2;
      max = mid + minVisualRange / 2;
    }
  }

  const width = 120;
  const height = 36;
  const pad = 4;

  const toX = (idx) => pad + (idx / (series.length - 1)) * (width - pad * 2);
  const toY = (v) => {
    if (max === min) return height / 2;
    return pad + (1 - (v - min) / (max - min)) * (height - pad * 2);
  };

  const plotPoints = series.map((v, idx) => `${toX(idx)},${toY(v)}`).join(' ');
  const color = series[series.length - 1] < series[0] ? '#d62828' : 'var(--text-color)';

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="120" height="36" aria-label="price-history-sparkline">
      <line
        x1={pad}
        y1={height - pad}
        x2={width - pad}
        y2={height - pad}
        stroke="rgba(0,0,0,0.22)"
        strokeWidth="1"
      />
      <polyline
        points={plotPoints}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={toX(series.length - 1)}
        cy={toY(series[series.length - 1])}
        r="2.6"
        fill={color}
      />
    </svg>
  );
}

function App() {
  const [stats, setStats] = useState({ total_active: 0, recent_changes: [], histogram: [] });
  const [listings, setListings] = useState([]);
  const [changes, setChanges] = useState([]);
  const [priceHistory, setPriceHistory] = useState({});
  // Favorites are persisted client-side to keep watchlist independent from backend schema.
  const [favorites, setFavorites] = useState(() => readFavoritesFromStorage());

  // Filters only use fields that already exist in listings_current.
  const [filters, setFilters] = useState({
    text: '',
    site: 'all',
    minPrice: '',
    maxPrice: '',
    favoritesOnly: false
  });

  const [sortConfig, setSortConfig] = useState({ key: 'last_seen', direction: 'desc' });
  const [changesPage, setChangesPage] = useState(1);

  const CHANGES_PER_PAGE = 6;
  const totalChangePages = Math.ceil(changes.length / CHANGES_PER_PAGE) || 1;
  const displayedChanges = changes.slice((changesPage - 1) * CHANGES_PER_PAGE, changesPage * CHANGES_PER_PAGE);

  useEffect(() => {
    fetch('/api/stats').then(r => r.json()).then(setStats).catch(console.error);
    fetch('/api/listings').then(r => r.json()).then(setListings).catch(console.error);
    fetch('/api/changes').then(r => r.json()).then(setChanges).catch(console.error);
    fetch('/api/history').then(r => r.json()).then(setPriceHistory).catch(console.error);
  }, []);

  useEffect(() => {
    writeFavoritesToStorage(favorites);
  }, [favorites]);

  const toggleFavorite = (listingId) => {
    setFavorites((prev) => prev.includes(listingId)
      ? prev.filter((id) => id !== listingId)
      : [...prev, listingId]
    );
  };

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') direction = 'desc';
    setSortConfig({ key, direction });
  };

  const availableSites = [...new Set(listings.map((l) => l.siteId).filter(Boolean))].sort();

  const filteredListings = listings.filter((l) => {
    const search = filters.text.trim().toLowerCase();
    const matchesText = !search || [l.title, l.location, l.siteId].some((v) => (v || '').toLowerCase().includes(search));
    const matchesSite = filters.site === 'all' || l.siteId === filters.site;

    const min = filters.minPrice === '' ? null : Number(filters.minPrice);
    const max = filters.maxPrice === '' ? null : Number(filters.maxPrice);
    // DB stores price_num in cents, but filter inputs are in euros.
    const priceNumEuros = Number(l.price_num || 0) / 100;
    const matchesMin = min === null || (!Number.isNaN(min) && priceNumEuros >= min);
    const matchesMax = max === null || (!Number.isNaN(max) && priceNumEuros <= max);

    const matchesFavorites = !filters.favoritesOnly || favorites.includes(l.id);

    return matchesText && matchesSite && matchesMin && matchesMax && matchesFavorites;
  });

  const sortedListings = [...filteredListings].sort((a, b) => {
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
                  <div style={{ display: 'flex', alignItems: 'flex-end', width: '100%', flex: 1 }}>
                    <div style={{ width: '100%', height: `${Math.max((b.count / maxHistogramCount) * 100, 2)}%`, background: 'var(--text-color)', border: '2px solid black', boxSizing: 'border-box' }}></div>
                  </div>
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
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '0.5rem', marginBottom: '1rem' }}>
            {/* Search uses existing textual fields only (title/location/site). */}
            <input
              value={filters.text}
              onChange={(e) => updateFilter('text', e.target.value)}
              placeholder="Search title / location / site"
              style={{ border: '2px solid black', padding: '0.5rem', fontFamily: 'inherit', fontWeight: '700' }}
            />
            <input
              type="number"
              min="0"
              value={filters.minPrice}
              onChange={(e) => updateFilter('minPrice', e.target.value)}
              placeholder="Min Price"
              style={{ border: '2px solid black', padding: '0.5rem', fontFamily: 'inherit', fontWeight: '700' }}
            />
            <input
              type="number"
              min="0"
              value={filters.maxPrice}
              onChange={(e) => updateFilter('maxPrice', e.target.value)}
              placeholder="Max Price"
              style={{ border: '2px solid black', padding: '0.5rem', fontFamily: 'inherit', fontWeight: '700' }}
            />
            <select
              value={filters.site}
              onChange={(e) => updateFilter('site', e.target.value)}
              style={{ border: '2px solid black', padding: '0.5rem', fontFamily: 'inherit', fontWeight: '700', background: 'white' }}
            >
              <option value="all">All Sites</option>
              {availableSites.map((site) => (
                <option key={site} value={site}>{site}</option>
              ))}
            </select>
            <button
              onClick={() => updateFilter('favoritesOnly', !filters.favoritesOnly)}
              style={{
                border: '2px solid black',
                padding: '0.5rem 0.7rem',
                fontFamily: 'inherit',
                fontWeight: '700',
                background: filters.favoritesOnly ? 'black' : 'white',
                color: filters.favoritesOnly ? 'white' : 'black',
                cursor: 'pointer'
              }}
            >
              ★ Favorites
            </button>
          </div>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Fav</th>
                  <th onClick={() => handleSort('siteId')}>Site {sortConfig.key==='siteId'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                  <th onClick={() => handleSort('title')}>Title {sortConfig.key==='title'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                  <th onClick={() => handleSort('location')}>LOCATION {sortConfig.key==='location'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                  <th onClick={() => handleSort('price_num')}>Price {sortConfig.key==='price_num'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                  <th>History</th>
                  <th onClick={() => handleSort('first_seen')}>First Seen {sortConfig.key==='first_seen'?(sortConfig.direction==='asc'?'↑':'↓'):''}</th>
                </tr>
              </thead>
              <tbody>
                {sortedListings.map(l => (
                  <tr key={l.id}>
                    <td>
                      <button
                        onClick={() => toggleFavorite(l.id)}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1rem' }}
                        title="Toggle favorite"
                        aria-label="toggle-favorite"
                      >
                        {favorites.includes(l.id) ? '★' : '☆'}
                      </button>
                    </td>
                    <td><strong>{l.siteId}</strong></td>
                    <td><a href={l.url} target="_blank" rel="noreferrer" title={l.id}>{l.title}</a></td>
                    <td>{l.location}</td>
                    <td><strong style={{ fontSize: '1.2rem', color: 'var(--accent-color)' }}>{l.price}</strong></td>
                    <td style={{ minWidth: '130px' }}>
                      {/* Sparkline shows chronological price evolution from listing_changes. */}
                      <Sparkline points={priceHistory[l.id] || []} fallbackPrice={Number(l.price_num || 0) / 100} />
                    </td>
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
