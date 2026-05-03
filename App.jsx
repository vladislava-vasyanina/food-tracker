import { useState, useEffect, useRef } from 'react'

// ─── constants ────────────────────────────────────────────────────────────────
const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-sonnet-4-20250514'
const FAT_KCAL = 7700
const KEY = import.meta.env.VITE_ANTHROPIC_KEY || ''

const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': KEY,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
}

// ─── storage (localStorage) ───────────────────────────────────────────────────
const db = {
  get: (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null } catch { return null } },
  set: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)) } catch(e) { console.error(e) } },
  listKeys: (prefix) => {
    const keys = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) keys.push(k)
    }
    return keys
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().split('T')[0]
const fmtDate = (d) => new Date(d + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' })

const calcK = (p, g) => ({
  kcal: +((p.per100g.kcal * g / 100).toFixed(1)),
  protein: +((p.per100g.protein * g / 100).toFixed(1)),
  fat: +((p.per100g.fat * g / 100).toFixed(1)),
  carbs: +((p.per100g.carbs * g / 100).toFixed(1)),
  fiber: +(((p.per100g.fiber || 0) * g / 100).toFixed(1)),
})

const sumK = (items = []) => items.reduce(
  (a, i) => ({ kcal: a.kcal + (i.kbzhu?.kcal || 0), protein: a.protein + (i.kbzhu?.protein || 0), fat: a.fat + (i.kbzhu?.fat || 0), carbs: a.carbs + (i.kbzhu?.carbs || 0), fiber: a.fiber + (i.kbzhu?.fiber || 0) }),
  { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 }
)

// ─── API helpers ──────────────────────────────────────────────────────────────
async function fetchPageHTML(url) {
  // Try multiple CORS proxies in sequence
  const proxies = [
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ]
  for (const proxy of proxies) {
    try {
      const r = await fetch(proxy, { signal: AbortSignal.timeout(10000) })
      if (!r.ok) continue
      const data = await r.json().catch(() => null)
      // allorigins returns { contents: '...' }
      if (data?.contents) return data.contents
      // corsproxy returns raw text
      const text = await r.text().catch(() => null)
      if (text && text.length > 100) return text
    } catch { continue }
  }
  throw new Error('Could not fetch page')
}

async function parseURL(url) {
  // Step 1: fetch raw HTML via CORS proxy
  const html = await fetchPageHTML(url)

  // Strip heavy tags to save tokens, keep text content
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .slice(0, 12000) // limit to ~3k tokens

  // Step 2: ask Claude to extract nutrition facts from HTML text
  const r = await fetch(API, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Extract nutrition facts from this supermarket product page text. The URL was: ${url}\n\nPage text:\n${stripped}\n\nReturn ONLY valid JSON, no markdown, no extra text:\n{"name":"product name in original language","brand":"brand name or empty string","per100g":{"kcal":0,"protein":0,"fat":0,"carbs":0,"fiber":0},"url":"${url}"}\n\nIf you cannot find nutrition info, still return valid JSON with zeros.`
      }]
    })
  })
  if (!r.ok) throw new Error(`API HTTP ${r.status}`)
  const d = await r.json()
  const text = d.content.filter(b => b.type === 'text').map(b => b.text).join('')
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s === -1 || e === -1) throw new Error('No JSON in response')
  const parsed = JSON.parse(text.slice(s, e + 1))
  if (!parsed.name) throw new Error('No product name found')
  return { ...parsed, id: crypto.randomUUID() }
}

async function aiMatch(query, products) {
  const list = products.map((p, i) => `${i}. ${p.name}${p.brand ? ' (' + p.brand + ')' : ''}`).join('\n')
  const r = await fetch(API, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      model: MODEL, max_tokens: 50,
      messages: [{ role: 'user', content: `User typed: "${query}"\n\nProducts:\n${list}\n\nReturn ONLY the index number of the best match (consider synonyms, abbreviations, translations). Just one integer, or -1 if no match.` }]
    })
  })
  if (!r.ok) throw new Error()
  const d = await r.json()
  const idx = parseInt(d.content.filter(b => b.type === 'text').map(b => b.text).join('').trim())
  return (isNaN(idx) || idx < 0) ? null : products[idx] || null
}

// ─── small components ─────────────────────────────────────────────────────────
function Tag({ type, label, value }) {
  return (
    <div className={`tag ${type}`}>
      <span className="tag-label">{label}</span>
      <span className="tag-val">{value}</span>
    </div>
  )
}

function BarRow({ label, value, target, colorClass }) {
  const pct = Math.min(100, Math.round(value / target * 100))
  const over = value > target
  const barColor = over ? 'var(--red)' : colorClass === 'protein' ? 'var(--green)' : colorClass === 'fat' ? 'var(--amber)' : colorClass === 'carbs' ? 'var(--red)' : 'var(--blue)'
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
        <span style={{ color: 'var(--text2)' }}>{label}</span>
        <span style={{ color: over ? 'var(--red)' : barColor, fontWeight: 500 }}>
          {typeof value === 'number' && value % 1 !== 0 ? value.toFixed(1) : Math.round(value)}
          <span style={{ color: 'var(--text3)', fontWeight: 400 }}> / {target} ({pct}%)</span>
        </span>
      </div>
      <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 3 }} />
      </div>
    </div>
  )
}

// ─── PRODUCTS TAB ─────────────────────────────────────────────────────────────
function ProductsTab({ products, onSave }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [m, setM] = useState({ name: '', brand: '', kcal: '', protein: '', fat: '', carbs: '', fiber: '' })

  const addURL = async () => {
    if (!url.trim()) return
    setBusy(true); setErr('')
    try {
      const p = await parseURL(url.trim())
      await onSave([...products, p]); setUrl('')
    } catch { setErr('Не удалось загрузить данные. Проверь ссылку и попробуй снова.') }
    setBusy(false)
  }

  const addManual = async () => {
    if (!m.name || !m.kcal) return
    const p = { id: crypto.randomUUID(), name: m.name, brand: m.brand || '', url: '', per100g: { kcal: +m.kcal || 0, protein: +m.protein || 0, fat: +m.fat || 0, carbs: +m.carbs || 0, fiber: +m.fiber || 0 } }
    await onSave([...products, p])
    setM({ name: '', brand: '', kcal: '', protein: '', fat: '', carbs: '', fiber: '' }); setShowManual(false)
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>
        Вставь ссылку на продукт из Intermarché или другого магазина — КБЖУ добавятся автоматически
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && addURL()} placeholder="https://intermarche.pt/product/..." disabled={busy} />
        <button onClick={addURL} disabled={busy || !url.trim()} className="primary" style={{ flexShrink: 0 }}>
          {busy ? 'Загружаю...' : 'Добавить'}
        </button>
      </div>

      {err && <p style={{ fontSize: 13, color: 'var(--red)', marginBottom: 10 }}>{err}</p>}

      <button onClick={() => setShowManual(!showManual)} style={{ fontSize: 13, marginBottom: 14 }}>
        {showManual ? 'Скрыть форму' : '+ Добавить вручную'}
      </button>

      {showManual && (
        <div className="surface" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 10, color: 'var(--text2)' }}>Все значения на 100г</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <input placeholder="Название *" value={m.name} onChange={e => setM({ ...m, name: e.target.value })} />
            <input placeholder="Бренд" value={m.brand} onChange={e => setM({ ...m, brand: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 10 }}>
            {[['kcal', 'Ккал *'], ['protein', 'Белки г'], ['fat', 'Жиры г'], ['carbs', 'Углев. г'], ['fiber', 'Клетч. г']].map(([k, lbl]) => (
              <input key={k} type="number" placeholder={lbl} value={m[k]} onChange={e => setM({ ...m, [k]: e.target.value })} style={{ width: '100%' }} />
            ))}
          </div>
          <button onClick={addManual} disabled={!m.name || !m.kcal} className="primary">Сохранить</button>
        </div>
      )}

      {products.length === 0
        ? <p style={{ color: 'var(--text3)', fontSize: 14, textAlign: 'center', padding: '2rem 0' }}>Продуктов пока нет. Добавь первый!</p>
        : (
          <>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>{products.length} продуктов · на 100г</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {products.map(p => (
                <div key={p.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                    {p.brand && <div style={{ fontSize: 12, color: 'var(--text2)' }}>{p.brand}</div>}
                    {p.url && <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--blue)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>↗ Ссылка на магазин</a>}
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                    <Tag type="kcal" label="ккал" value={p.per100g.kcal} />
                    <Tag type="protein" label="Б" value={p.per100g.protein} />
                    <Tag type="fat" label="Ж" value={p.per100g.fat} />
                    <Tag type="carbs" label="У" value={p.per100g.carbs} />
                  </div>
                  <button onClick={() => onSave(products.filter(x => x.id !== p.id))} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 20, padding: '0 4px', flexShrink: 0 }}>×</button>
                </div>
              ))}
            </div>
          </>
        )}
    </div>
  )
}

// ─── LOG TAB ──────────────────────────────────────────────────────────────────
function LogTab({ products, dayData, onSave }) {
  const [date, setDate] = useState(todayStr())
  const [q, setQ] = useState('')
  const [grams, setGrams] = useState('')
  const [sel, setSel] = useState(null)
  const [matching, setMatching] = useState(false)
  const [matchErr, setMatchErr] = useState('')
  const [open, setOpen] = useState(false)

  const log = dayData[date] || { items: [], burned: 0 }

  const fuzzy = q.length > 1
    ? products.filter(p => p.name.toLowerCase().includes(q.toLowerCase()) || (p.brand && p.brand.toLowerCase().includes(q.toLowerCase()))).slice(0, 6)
    : []

  const pick = (p) => { setSel(p); setQ(`${p.name}${p.brand ? ' (' + p.brand + ')' : ''}`); setOpen(false); setMatchErr('') }

  const doAI = async () => {
    if (!q.trim() || !products.length) return
    setMatching(true); setMatchErr('')
    try { const match = await aiMatch(q, products); match ? pick(match) : setMatchErr('Не нашлось совпадения. Попробуй иначе.') }
    catch { setMatchErr('Ошибка AI поиска.') }
    setMatching(false)
  }

  const add = async () => {
    const g = parseFloat(grams)
    if (!sel || isNaN(g) || g <= 0) return
    const item = { id: crypto.randomUUID(), productId: sel.id, productName: sel.name, brand: sel.brand || '', grams: g, kbzhu: calcK(sel, g), time: new Date().toTimeString().slice(0, 5) }
    await onSave(date, { ...log, items: [...log.items, item] })
    setQ(''); setGrams(''); setSel(null); setMatchErr('')
  }

  const del = (id) => onSave(date, { ...log, items: log.items.filter(i => i.id !== id) })

  const totals = sumK(log.items)
  const pg = parseFloat(grams)
  const hasPreview = sel && !isNaN(pg) && pg > 0

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: 'auto', fontSize: 14 }} />
      </div>

      <div className="surface" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text2)', marginBottom: 10 }}>Добавить приём пищи</p>
        {products.length === 0
          ? <p style={{ fontSize: 13, color: 'var(--text3)' }}>Сначала добавь продукты во вкладке «Продукты»</p>
          : <>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <input value={q} onChange={e => { setQ(e.target.value); setSel(null); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 180)}
                placeholder="Начни вводить название..." style={{ width: '100%' }} />
              {open && fuzzy.length > 0 && !sel && (
                <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, right: 0, background: 'var(--bg)', border: '0.5px solid var(--border2)', borderRadius: 8, zIndex: 50, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', overflow: 'hidden' }}>
                  {fuzzy.map(p => (
                    <div key={p.id} onMouseDown={() => pick(p)} style={{ padding: '9px 14px', cursor: 'pointer', fontSize: 13, borderBottom: '0.5px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 500 }}>{p.name} {p.brand && <span style={{ color: 'var(--text2)', fontWeight: 400 }}>{p.brand}</span>}</span>
                      <span style={{ color: 'var(--text3)', fontSize: 11, flexShrink: 0, marginLeft: 8 }}>{p.per100g.kcal} ккал/100г</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {!sel && <button onClick={doAI} disabled={matching || !q.trim()} style={{ fontSize: 13 }}>{matching ? 'Ищу...' : 'AI поиск ↗'}</button>}
              {sel && <div style={{ fontSize: 13, color: 'var(--green)', flex: 1 }}>✓ {sel.name}</div>}
              <input type="number" value={grams} onChange={e => setGrams(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="граммы" style={{ width: 95 }} />
              <button onClick={add} disabled={!sel || !grams} className="primary">Добавить</button>
            </div>
            {matchErr && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{matchErr}</p>}
            {hasPreview && (
              <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
                {pg}г →{' '}
                <span style={{ color: 'var(--blue)', fontWeight: 500 }}>{Math.round(sel.per100g.kcal * pg / 100)} ккал</span>
                {` · Б ${(sel.per100g.protein * pg / 100).toFixed(1)}г · Ж ${(sel.per100g.fat * pg / 100).toFixed(1)}г · У ${(sel.per100g.carbs * pg / 100).toFixed(1)}г`}
              </p>
            )}
          </>}
      </div>

      {log.items.length > 0 && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
            {log.items.map(item => (
              <div key={item.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ fontSize: 11, color: 'var(--text3)', minWidth: 34 }}>{item.time}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.productName}</span>
                <span style={{ color: 'var(--text2)', flexShrink: 0 }}>{item.grams}г</span>
                <span style={{ fontWeight: 500, flexShrink: 0, minWidth: 60, textAlign: 'right' }}>{Math.round(item.kbzhu.kcal)} ккал</span>
                <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>Б{item.kbzhu.protein} Ж{item.kbzhu.fat} У{item.kbzhu.carbs}</span>
                <button onClick={() => del(item.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 18, padding: '0 2px' }}>×</button>
              </div>
            ))}
          </div>
          <div className="surface" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13, alignItems: 'center' }}>
            <span style={{ fontWeight: 500 }}>Итого:</span>
            <span style={{ fontWeight: 500, color: 'var(--blue)' }}>{Math.round(totals.kcal)} ккал</span>
            <span style={{ color: 'var(--green)' }}>Б {totals.protein.toFixed(1)}г</span>
            <span style={{ color: 'var(--amber)' }}>Ж {totals.fat.toFixed(1)}г</span>
            <span style={{ color: 'var(--red)' }}>У {totals.carbs.toFixed(1)}г</span>
          </div>
        </>
      )}
    </div>
  )
}

// ─── TODAY TAB ────────────────────────────────────────────────────────────────
function TodayTab({ dayData, onSave, targets }) {
  const date = todayStr()
  const log = dayData[date] || { items: [], burned: 0 }
  const [burnedInput, setBurnedInput] = useState(String(log.burned || ''))
  const [saved, setSaved] = useState(false)

  useEffect(() => { setBurnedInput(String(log.burned || '')) }, [date])

  const totals = sumK(log.items)
  const kcal = Math.round(totals.kcal)
  const burned = log.burned || 0
  const balance = kcal - burned
  const isDeficit = burned > 0 && balance < 0

  const saveBurned = async () => {
    await onSave(date, { ...log, burned: parseFloat(burnedInput) || 0 })
    setSaved(true); setTimeout(() => setSaved(false), 1500)
  }

  const pP = kcal > 0 ? Math.round(totals.protein * 4 / kcal * 100) : 0
  const pF = kcal > 0 ? Math.round(totals.fat * 9 / kcal * 100) : 0
  const pC = kcal > 0 ? Math.round(totals.carbs * 4 / kcal * 100) : 0

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 16 }}>
        {new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 18 }}>
        {[
          { label: 'Съедено', val: kcal, unit: 'ккал', accent: false },
          { label: 'Сожжено', val: burned, unit: 'ккал', accent: false },
          { label: isDeficit ? 'Дефицит' : 'Баланс', val: Math.abs(balance), unit: 'ккал', accent: isDeficit },
        ].map(c => (
          <div key={c.label} className={c.accent ? '' : 'surface'} style={c.accent ? { background: 'var(--green-bg)', borderRadius: 'var(--radius)', padding: '12px 8px', textAlign: 'center' } : { padding: '12px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: c.accent ? 'var(--green)' : 'var(--text2)', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 26, fontWeight: 600, color: c.accent ? 'var(--green)' : 'var(--text)', lineHeight: 1 }}>{c.val}</div>
            <div style={{ fontSize: 11, color: c.accent ? 'var(--green)' : 'var(--text3)', marginTop: 3 }}>{c.unit}</div>
          </div>
        ))}
      </div>

      <div className="surface" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text2)', marginBottom: 14 }}>Прогресс по целям</p>
        <BarRow label="Калории" value={kcal} target={targets.kcal} colorClass="kcal" />
        <BarRow label="Белки, г" value={totals.protein} target={targets.protein} colorClass="protein" />
        <BarRow label="Жиры, г" value={totals.fat} target={targets.fat} colorClass="fat" />
        <BarRow label="Углеводы, г" value={totals.carbs} target={targets.carbs} colorClass="carbs" />
      </div>

      {kcal > 0 && (
        <div className="surface" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text2)', marginBottom: 14 }}>Состав калорий</p>
          <div style={{ display: 'flex' }}>
            {[{ label: 'Белки', pct: pP, col: 'var(--green)' }, { label: 'Жиры', pct: pF, col: 'var(--amber)' }, { label: 'Углев.', pct: pC, col: 'var(--red)' }].map((mc, i) => (
              <div key={mc.label} style={{ flex: 1, textAlign: 'center', borderRight: i < 2 ? '0.5px solid var(--border)' : 'none', padding: '0 8px' }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: mc.col }}>{mc.pct}%</div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{mc.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Сожжённые калории</p>
        <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>Введи данные из Apple Watch или другого трекера</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="number" value={burnedInput} onChange={e => setBurnedInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveBurned()} placeholder="0" style={{ width: 110 }} />
          <span style={{ fontSize: 13, color: 'var(--text2)' }}>ккал</span>
          <button onClick={saveBurned}>{saved ? '✓ Сохранено' : 'Сохранить'}</button>
        </div>
      </div>

      {log.items.length > 0 && (
        <div>
          <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text2)', marginBottom: 8 }}>Съедено сегодня</p>
          {log.items.map(item => (
            <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '0.5px solid var(--border)', fontSize: 13 }}>
              <span style={{ fontSize: 11, color: 'var(--text3)', minWidth: 34 }}>{item.time}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.productName}</span>
              <span style={{ color: 'var(--text2)' }}>{item.grams}г</span>
              <span style={{ fontWeight: 500 }}>{Math.round(item.kbzhu.kcal)} ккал</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── MONTH TAB ────────────────────────────────────────────────────────────────
function MonthTab({ dayData }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())

  const monthName = new Date(year, month, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const days = Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1).toISOString().split('T')[0])

  const dayRows = days.map(d => {
    const log = dayData[d] || { items: [], burned: 0 }
    const t = sumK(log.items)
    return { date: d, consumed: +t.kcal.toFixed(1), burned: log.burned || 0, deficit: +((log.burned || 0) - t.kcal).toFixed(1), hasData: log.items.length > 0 || (log.burned || 0) > 0 }
  })

  const withData = dayRows.filter(r => r.hasData)
  const n = withData.length || 1
  const totalConsumed = +withData.reduce((a, r) => a + r.consumed, 0).toFixed(1)
  const totalBurned = +withData.reduce((a, r) => a + r.burned, 0).toFixed(1)
  const totalDeficit = +(totalBurned - totalConsumed).toFixed(1)
  const weightLoss = totalDeficit > 0 ? +(totalDeficit / FAT_KCAL).toFixed(3) : 0
  const avrConsumed = +(totalConsumed / n).toFixed(1)
  const avrBurned = +(totalBurned / n).toFixed(1)
  const avrDeficit = +(totalDeficit / n).toFixed(1)
  const tdee10 = Math.round(avrBurned * 0.10)
  const tdee20 = Math.round(avrBurned * 0.20)
  const inRange = avrDeficit >= tdee10 && avrDeficit <= tdee20
  const tooLow = avrDeficit < tdee10

  const defColor = inRange ? 'var(--green)' : tooLow ? 'var(--amber)' : 'var(--red)'
  const defBg = inRange ? 'var(--green-bg)' : tooLow ? 'var(--amber-bg)' : 'var(--red-bg)'
  const defBorder = inRange ? '#639922' : tooLow ? '#BA7517' : '#A32D2D'
  const defLabel = inRange ? 'В норме ✓' : tooLow ? 'Слишком мало' : 'Слишком много'

  const prevM = () => { if (month === 0) { setMonth(11); setYear(y => y - 1) } else setMonth(m => m - 1) }
  const nextM = () => { if (month === 11) { setMonth(0); setYear(y => y + 1) } else setMonth(m => m + 1) }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <button onClick={prevM} style={{ padding: '5px 12px' }}>‹</button>
        <span style={{ flex: 1, textAlign: 'center', fontWeight: 600, fontSize: 15, textTransform: 'capitalize' }}>{monthName}</span>
        <button onClick={nextM} style={{ padding: '5px 12px' }}>›</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'Всего съедено', val: totalConsumed, unit: 'ккал' },
          { label: 'Всего сожжено', val: totalBurned, unit: 'ккал' },
          { label: 'Итог. дефицит', val: totalDeficit, unit: 'ккал', col: totalDeficit > 0 ? 'var(--green)' : '' },
          { label: 'Потеря веса ≈', val: weightLoss, unit: 'кг', col: weightLoss > 0 ? 'var(--green)' : '' },
        ].map(c => (
          <div key={c.label} className="surface" style={{ textAlign: 'center', padding: '14px 8px' }}>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 5 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: c.col || 'var(--text)', lineHeight: 1 }}>{c.val}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{c.unit}</div>
          </div>
        ))}
      </div>

      <div style={{ background: defBg, borderRadius: 'var(--radius)', padding: '1rem 1.25rem', marginBottom: 16, border: `1.5px solid ${defBorder}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <p style={{ fontSize: 14, fontWeight: 500, color: defColor }}>Средний дефицит</p>
          <span style={{ fontSize: 12, fontWeight: 600, color: defColor, background: 'rgba(255,255,255,0.5)', borderRadius: 6, padding: '3px 10px' }}>{defLabel}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: 13, textAlign: 'center' }}>
          {[{ label: 'Средн. потрачено', val: avrBurned }, { label: 'Средн. дефицит', val: avrDeficit, bold: true }, { label: 'Средн. съедено', val: avrConsumed }].map(c => (
            <div key={c.label}>
              <div style={{ fontSize: 11, color: defColor, marginBottom: 4 }}>{c.label}</div>
              <div style={{ fontSize: c.bold ? 22 : 17, fontWeight: c.bold ? 600 : 400, color: defColor }}>{c.val}</div>
              <div style={{ fontSize: 10, color: defColor, opacity: 0.7 }}>ккал</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: `0.5px solid ${defBorder}`, display: 'flex', justifyContent: 'space-around', fontSize: 12 }}>
          <span style={{ color: defColor }}>10% TDEE = <strong>{tdee10} ккал</strong></span>
          <span style={{ color: defColor }}>20% TDEE = <strong>{tdee20} ккал</strong></span>
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
        1 кг жира = 7 700 ккал · Данных за {withData.length} из {daysInMonth} дней
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '35%' }} /><col style={{ width: '22%' }} /><col style={{ width: '22%' }} /><col style={{ width: '21%' }} />
          </colgroup>
          <thead>
            <tr style={{ borderBottom: '0.5px solid var(--border2)' }}>
              {['Дата', 'Съедено', 'Сожжено', 'Дефицит'].map((h, i) => (
                <th key={h} style={{ padding: '7px 4px', textAlign: i === 0 ? 'left' : 'right', fontWeight: 500, color: 'var(--text2)', fontSize: 11 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dayRows.map(r => {
              const isToday = r.date === todayStr()
              const def = r.deficit
              const defCol = r.burned > 0 && def > 0 ? 'var(--green)' : r.burned > 0 && def < 0 ? 'var(--red)' : 'var(--text3)'
              return (
                <tr key={r.date} style={{ borderBottom: '0.5px solid var(--border)', background: isToday ? 'var(--bg2)' : '' }}>
                  <td style={{ padding: '7px 4px', fontWeight: isToday ? 600 : 400, color: isToday ? 'var(--text)' : 'var(--text2)', fontSize: 12 }}>
                    {fmtDate(r.date)}
                    {isToday && <span style={{ fontSize: 10, color: 'var(--blue)', marginLeft: 4 }}>сегодня</span>}
                  </td>
                  <td style={{ padding: '7px 4px', textAlign: 'right', color: r.consumed ? 'var(--text)' : 'var(--text3)' }}>{r.consumed || '—'}</td>
                  <td style={{ padding: '7px 4px', textAlign: 'right', color: r.burned ? 'var(--text)' : 'var(--text3)' }}>{r.burned || '—'}</td>
                  <td style={{ padding: '7px 4px', textAlign: 'right', fontWeight: 500, color: defCol }}>{r.burned ? (def > 0 ? `+${def}` : def) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────
function SettingsTab({ targets, onSaveTargets }) {
  const [t, setT] = useState({ ...targets })
  const [saved, setSaved] = useState(false)

  const save = () => {
    onSaveTargets(t)
    setSaved(true); setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 18 }}>
        Установи свои дневные цели по КБЖУ
      </p>
      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 14 }}>Дневные цели</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[['kcal', 'Калории (ккал)'], ['protein', 'Белки (г)'], ['fat', 'Жиры (г)'], ['carbs', 'Углеводы (г)']].map(([k, lbl]) => (
            <div key={k}>
              <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>{lbl}</label>
              <input type="number" value={t[k]} onChange={e => setT({ ...t, [k]: +e.target.value })} style={{ width: '100%' }} />
            </div>
          ))}
        </div>
        <button onClick={save} className="primary" style={{ marginTop: 14 }}>{saved ? '✓ Сохранено' : 'Сохранить'}</button>
      </div>
      <div className="surface">
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>О приложении</p>
        <p style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>
          КБЖУ Трекер — персональный дневник питания.<br />
          Данные хранятся в браузере (localStorage).<br />
          Парсинг продуктов и AI поиск работают через Claude API.<br />
          1 кг жира = 7 700 ккал.
        </p>
      </div>
    </div>
  )
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
const DEFAULT_TARGETS = { kcal: 1800, protein: 90, fat: 60, carbs: 180 }
const TABS = [
  { id: 'today', label: 'Сегодня' },
  { id: 'log', label: 'Записать' },
  { id: 'month', label: 'Месяц' },
  { id: 'products', label: 'Продукты' },
  { id: 'settings', label: 'Настройки' },
]

export default function App() {
  const [tab, setTab] = useState('today')
  const [products, setProducts] = useState([])
  const [dayData, setDayData] = useState({})
  const [targets, setTargets] = useState(DEFAULT_TARGETS)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const prods = db.get('products') || []
    setProducts(prods)
    const tgts = db.get('targets')
    if (tgts) setTargets(tgts)
    const days = {}
    db.listKeys('day:').forEach(k => { const d = db.get(k); if (d) days[k.replace('day:', '')] = d })
    setDayData(days)
    setReady(true)
  }, [])

  const saveProducts = (p) => { setProducts(p); db.set('products', p) }
  const saveDayData = (date, data) => { setDayData(prev => ({ ...prev, [date]: data })); db.set(`day:${date}`, data) }
  const saveTargets = (t) => { setTargets(t); db.set('targets', t) }

  if (!ready) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh', color: 'var(--text2)', fontSize: 14 }}>
      Загрузка...
    </div>
  )

  return (
    <div style={{ maxWidth: 540, margin: '0 auto', minHeight: '100dvh', background: 'var(--bg)' }}>
      {/* header */}
      <div style={{ padding: '18px 20px 0', borderBottom: '0.5px solid var(--border)' }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 14 }}>КБЖУ Трекер</h1>
        <div style={{ display: 'flex', gap: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: '8px 14px', border: 'none', borderBottom: `2px solid ${tab === t.id ? 'var(--text)' : 'transparent'}`,
              background: 'transparent', color: tab === t.id ? 'var(--text)' : 'var(--text2)',
              fontWeight: tab === t.id ? 600 : 400, cursor: 'pointer', fontSize: 13, marginBottom: -1, flexShrink: 0
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* content */}
      <div style={{ padding: '20px 20px 80px' }}>
        {tab === 'today' && <TodayTab dayData={dayData} onSave={saveDayData} targets={targets} />}
        {tab === 'log' && <LogTab products={products} dayData={dayData} onSave={saveDayData} />}
        {tab === 'month' && <MonthTab dayData={dayData} />}
        {tab === 'products' && <ProductsTab products={products} onSave={saveProducts} />}
        {tab === 'settings' && <SettingsTab targets={targets} onSaveTargets={saveTargets} />}
      </div>
    </div>
  )
}
