import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'

// ─── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://jtajdwbytuperojgxlkr.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0YWpkd2J5dHVwZXJvamd4bGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0MTYxODYsImV4cCI6MjA5Mzk5MjE4Nn0.uRhDmXT8QBwW8xMFPq4QAtpg29mlqulZAN2hysoONok'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-sonnet-4-6'
const KEY = import.meta.env.VITE_ANTHROPIC_KEY || ''
const HEADERS = { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
const USDA_KEY = 'rq6dj2oo784IX2OVkwnk8ttUhkjhrk5vFTqQCpaC'
const FAT_KCAL = 7700

// ─── Helpers ──────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().split('T')[0]

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

const rowToProduct = (r) => ({
  id: r.id, name: r.name, nickname: r.nickname || '', brand: r.brand || '', url: r.url || '',
  per100g: { kcal: r.kcal, protein: r.protein, fat: r.fat, carbs: r.carbs, fiber: r.fiber || 0 }
})

const suggestNickname = (name) => { const s = name.split(',')[0].trim(); return s.charAt(0).toUpperCase() + s.slice(1) }

// ─── Image helpers ────────────────────────────────────────────────────────────
async function compressImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const MAX = 1600
      let { width: w, height: h } = img
      if (w > MAX || h > MAX) { const r = Math.min(MAX / w, MAX / h); w = Math.round(w * r); h = Math.round(h * r) }
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

async function parseImage(base64) {
  const r = await fetch(API, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({
      model: MODEL, max_tokens: 500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: 'Extract nutrition facts from this food product image or label. Return ONLY valid JSON (no markdown):\n{"name":"short product name","brand":"brand or empty string","per100g":{"kcal":0,"protein":0,"fat":0,"carbs":0,"fiber":0}}\nAll values per 100g. kcal in kilocalories (divide kJ by 4.184). Return 0 for missing values.' }
      ]}]
    })
  })
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(`API ${r.status}: ${e?.error?.message || 'error'}`) }
  const d = await r.json()
  const text = d.content.filter(b => b.type === 'text').map(b => b.text).join('')
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s === -1 || e === -1) throw new Error('Could not parse response')
  return JSON.parse(text.slice(s, e + 1))
}

async function searchByName(query) {
  const params = new URLSearchParams({ query, api_key: USDA_KEY, pageSize: '20', dataType: 'Foundation,SR Legacy,Branded' })
  const r = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?${params}`, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) throw new Error(`USDA error ${r.status}`)
  const data = await r.json()
  if (!data.foods?.length) return []
  const getN = (ns, id) => { const n = ns?.find(n => n.nutrientId === id || +n.nutrientNumber === id); return n ? +(+n.value || 0).toFixed(1) : 0 }
  return data.foods.map(f => ({
    id: crypto.randomUUID(), name: f.description, brand: f.brandOwner || f.brandName || '', dataType: f.dataType, url: '',
    per100g: { kcal: Math.round(getN(f.foodNutrients, 1008)), protein: getN(f.foodNutrients, 1003), fat: getN(f.foodNutrients, 1004), carbs: getN(f.foodNutrients, 1005), fiber: getN(f.foodNutrients, 1079) }
  })).filter(p => p.name && p.per100g.kcal > 0)
}

async function aiMatch(query, products) {
  const list = products.map((p, i) => `${i}. ${p.nickname || p.name}${p.brand ? ' (' + p.brand + ')' : ''}`).join('\n')
  const r = await fetch(API, { method: 'POST', headers: HEADERS, body: JSON.stringify({ model: MODEL, max_tokens: 50, messages: [{ role: 'user', content: `User typed: "${query}"\n\nProducts:\n${list}\n\nReturn ONLY the index number of the best match. Just one integer, or -1 if no match.` }] }) })
  if (!r.ok) throw new Error()
  const d = await r.json()
  const idx = parseInt(d.content.filter(b => b.type === 'text').map(b => b.text).join('').trim())
  return (isNaN(idx) || idx < 0) ? null : products[idx] || null
}

// ─── Tag component ────────────────────────────────────────────────────────────
function Tag({ type, label, value }) {
  const c = { kcal: ['var(--blue-bg)', 'var(--blue)'], protein: ['var(--green-bg)', 'var(--green)'], fat: ['var(--amber-bg)', 'var(--amber)'], carbs: ['var(--red-bg)', 'var(--red)'] }[type] || ['var(--bg2)', 'var(--text2)']
  return (
    <div style={{ background: c[0], borderRadius: 6, padding: '3px 7px', textAlign: 'center', minWidth: 40 }}>
      <div style={{ fontSize: 9, color: c[1], fontWeight: 500, lineHeight: 1.3 }}>{label}</div>
      <div style={{ fontSize: 12, color: c[1], fontWeight: 500, lineHeight: 1.3 }}>{value}</div>
    </div>
  )
}

// ─── PRODUCTS TAB ─────────────────────────────────────────────────────────────
function ProductsTab({ products, onSave }) {
  const [mode, setMode] = useState('main')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [photoPreview, setPhotoPreview] = useState(null)
  const [draft, setDraft] = useState(null)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchDone, setSearchDone] = useState(false)
  const [pendingProduct, setPendingProduct] = useState(null)
  const [nickname, setNickname] = useState('')
  const [m, setM] = useState({ name: '', nickname: '', brand: '', kcal: '', protein: '', fat: '', carbs: '', fiber: '' })

  const reset = () => { setMode('main'); setErr(''); setPhotoPreview(null); setDraft(null); setSearchQ(''); setSearchResults([]); setSearchDone(false); setPendingProduct(null); setNickname('') }

  const processImageFile = async (file) => {
    if (!file) return
    setErr(''); setDraft(null)
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const rawDataUrl = ev.target.result
      setPhotoPreview(rawDataUrl); setMode('photo'); setBusy(true)
      try {
        const compressed = await compressImage(rawDataUrl)
        const [, base64] = compressed.split(',')
        const result = await parseImage(base64)
        setDraft({ name: result.name || '', nickname: suggestNickname(result.name || ''), brand: result.brand || '', kcal: String(result.per100g?.kcal || ''), protein: String(result.per100g?.protein || ''), fat: String(result.per100g?.fat || ''), carbs: String(result.per100g?.carbs || ''), fiber: String(result.per100g?.fiber || '') })
      } catch (e) { console.error(e); setErr(`Recognition error: ${e.message}`) }
      setBusy(false)
    }
    reader.readAsDataURL(file)
  }

  const savePhoto = async () => {
    if (!draft?.name.trim()) return
    const p = { id: crypto.randomUUID(), name: draft.name.trim(), nickname: (draft.nickname || '').trim(), brand: draft.brand || '', url: '', per100g: { kcal: +draft.kcal || 0, protein: +draft.protein || 0, fat: +draft.fat || 0, carbs: +draft.carbs || 0, fiber: +draft.fiber || 0 } }
    await onSave([...products, p]); reset()
  }

  const doSearch = async () => {
    if (!searchQ.trim()) return
    setBusy(true); setErr(''); setSearchResults([]); setSearchDone(false)
    try { const results = await searchByName(searchQ.trim()); setSearchResults(results); setSearchDone(true) }
    catch { setErr('Search error. Check your internet connection.') }
    setBusy(false)
  }

  const pickResult = (p) => { setPendingProduct(p); setNickname(suggestNickname(p.name)); setMode('nickname') }

  const saveWithNickname = async () => {
    if (!pendingProduct) return
    await onSave([...products, { ...pendingProduct, nickname: nickname.trim() }]); reset()
  }

  const addManual = async () => {
    if (!m.name || !m.kcal) return
    const p = { id: crypto.randomUUID(), name: m.name, nickname: m.nickname || '', brand: m.brand || '', url: '', per100g: { kcal: +m.kcal || 0, protein: +m.protein || 0, fat: +m.fat || 0, carbs: +m.carbs || 0, fiber: +m.fiber || 0 } }
    await onSave([...products, p]); setM({ name: '', nickname: '', brand: '', kcal: '', protein: '', fat: '', carbs: '', fiber: '' }); setMode('main')
  }

  if (mode === 'nickname' && pendingProduct) return (
    <div>
      <button onClick={reset} style={{ fontSize: 13, marginBottom: 14 }}>← Back</button>
      <div className="surface" style={{ marginBottom: 14 }}>
        <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>Found product:</p>
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{pendingProduct.name}</p>
        {pendingProduct.brand && <p style={{ fontSize: 12, color: 'var(--text3)' }}>{pendingProduct.brand}</p>}
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <Tag type="kcal" label="kcal" value={pendingProduct.per100g.kcal} />
          <Tag type="protein" label="P" value={pendingProduct.per100g.protein} />
          <Tag type="fat" label="F" value={pendingProduct.per100g.fat} />
          <Tag type="carbs" label="C" value={pendingProduct.per100g.carbs} />
        </div>
      </div>
      <div className="card">
        <p style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>What will you call it?</p>
        <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12, lineHeight: 1.6 }}>Give it a short name you'll use to find it. E.g.: "Chicken", "Oats", "Greek yogurt"</p>
        <input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="My name..." autoFocus onKeyDown={e => e.key === 'Enter' && saveWithNickname()} style={{ width: '100%', marginBottom: 12, fontSize: 15 }} />
        <button onClick={saveWithNickname} disabled={!nickname.trim()} className="primary" style={{ width: '100%' }}>Add to My Products</button>
      </div>
    </div>
  )

  if (mode === 'photo') return (
    <div>
      <button onClick={reset} style={{ fontSize: 13, marginBottom: 14 }}>← Back</button>
      {photoPreview && <img src={photoPreview} alt="" style={{ width: '100%', maxHeight: 200, objectFit: 'contain', borderRadius: 8, marginBottom: 12, background: 'var(--bg2)' }} />}
      {busy && <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text2)', fontSize: 13 }}>⏳ Reading nutrition data...</div>}
      {err && <div style={{ background: 'var(--red-bg)', borderRadius: 8, padding: '12px 14px', marginBottom: 14 }}><p style={{ fontSize: 13, color: 'var(--red)', margin: 0 }}>{err}</p><p style={{ fontSize: 12, color: 'var(--red)', margin: '6px 0 0', opacity: 0.8 }}>You can fill in the data manually below.</p></div>}
      {(draft || err) && !busy && (
        <div>
          <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: 'var(--text2)' }}>{draft ? 'Review and edit if needed:' : 'Fill in manually:'}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <div><label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Original name *</label><input type="text" value={draft?.name || ''} onChange={e => setDraft(d => ({ ...(d || {}), name: e.target.value }))} placeholder="As on the package" autoFocus style={{ width: '100%' }} /></div>
            <div><label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Brand</label><input type="text" value={draft?.brand || ''} onChange={e => setDraft(d => ({ ...(d || {}), brand: e.target.value }))} placeholder="optional" style={{ width: '100%' }} /></div>
          </div>
          <div style={{ marginBottom: 8 }}><label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>My name (for search)</label><input type="text" value={draft?.nickname || ''} onChange={e => setDraft(d => ({ ...(d || {}), nickname: e.target.value }))} placeholder='E.g.: "Cereal", "Yogurt"' style={{ width: '100%' }} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 8 }}>
            {[['kcal', 'kcal'], ['protein', 'Protein'], ['fat', 'Fat'], ['carbs', 'Carbs'], ['fiber', 'Fiber']].map(([key, lbl]) => (
              <div key={key}><label style={{ fontSize: 10, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>{lbl}</label><input type="number" value={draft?.[key] || ''} onChange={e => setDraft(d => ({ ...(d || {}), [key]: e.target.value }))} style={{ width: '100%' }} /></div>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12 }}>All values per 100g</p>
          <button onClick={savePhoto} disabled={!draft?.name?.trim()} className="primary" style={{ width: '100%' }}>Save Product</button>
        </div>
      )}
    </div>
  )

  if (mode === 'search') return (
    <div>
      <button onClick={reset} style={{ fontSize: 13, marginBottom: 14 }}>← Back</button>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 10 }}>USDA database — free, no tokens used</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <input value={searchQ} onChange={e => setSearchQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && doSearch()} placeholder="banana, chicken breast, avocado..." autoFocus />
        <button onClick={doSearch} disabled={busy || !searchQ.trim()} className="primary" style={{ flexShrink: 0 }}>{busy ? '...' : 'Search'}</button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12 }}>🇺🇸 Same data as Google & Apple Health. Search in English for best results.</p>
      {err && <p style={{ fontSize: 13, color: 'var(--red)', marginBottom: 10 }}>{err}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {searchResults.map(p => (
          <div key={p.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => pickResult(p)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', gap: 6, marginTop: 2 }}>{p.brand && <span>{p.brand}</span>}{(p.dataType === 'Foundation' || p.dataType === 'SR Legacy') && <span style={{ color: 'var(--green)', fontWeight: 500 }}>✓ verified</span>}</div>
            </div>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}><Tag type="kcal" label="kcal" value={p.per100g.kcal} /><Tag type="protein" label="P" value={p.per100g.protein} /><Tag type="fat" label="F" value={p.per100g.fat} /><Tag type="carbs" label="C" value={p.per100g.carbs} /></div>
            <span style={{ fontSize: 20, color: 'var(--text3)', flexShrink: 0 }}>+</span>
          </div>
        ))}
      </div>
      {searchDone && !searchResults.length && <p style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', padding: '1rem 0' }}>Nothing found. Try different keywords.</p>}
    </div>
  )

  if (mode === 'manual') return (
    <div>
      <button onClick={() => setMode('main')} style={{ fontSize: 13, marginBottom: 14 }}>← Back</button>
      <div className="surface">
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 10, color: 'var(--text2)' }}>All values per 100g</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <input placeholder="Original name *" value={m.name} onChange={e => setM({ ...m, name: e.target.value })} />
          <input placeholder="My name (for search)" value={m.nickname || ''} onChange={e => setM({ ...m, nickname: e.target.value })} />
        </div>
        <div style={{ marginBottom: 8 }}><input placeholder="Brand (optional)" value={m.brand} onChange={e => setM({ ...m, brand: e.target.value })} style={{ width: '100%' }} /></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 10 }}>
          {[['kcal', 'kcal *'], ['protein', 'Protein'], ['fat', 'Fat'], ['carbs', 'Carbs'], ['fiber', 'Fiber']].map(([k, lbl]) => (
            <input key={k} type="number" placeholder={lbl} value={m[k]} onChange={e => setM({ ...m, [k]: e.target.value })} style={{ width: '100%' }} />
          ))}
        </div>
        <button onClick={addManual} disabled={!m.name || !m.kcal} className="primary">Save</button>
      </div>
    </div>
  )

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', padding: '1.5rem', marginBottom: 10 }}>
        <div style={{ fontSize: 32, marginBottom: 6 }}>📷</div>
        <p style={{ fontWeight: 500, marginBottom: 4 }}>Add via Photo</p>
        <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 14, lineHeight: 1.6 }}>Take a photo or upload a screenshot — Claude reads the nutrition data automatically</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <label style={{ cursor: 'pointer' }}>
            <span style={{ display: 'inline-block', padding: '9px 18px', borderRadius: 8, background: 'var(--text)', color: 'var(--bg)', fontWeight: 500, fontSize: 13 }}>📸 Camera</span>
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => processImageFile(e.target.files[0])} />
          </label>
          <label style={{ cursor: 'pointer' }}>
            <span style={{ display: 'inline-block', padding: '9px 18px', borderRadius: 8, background: 'var(--bg2)', color: 'var(--text)', fontWeight: 500, fontSize: 13, border: '0.5px solid var(--border2)' }}>🖼 Screenshot</span>
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => processImageFile(e.target.files[0])} />
          </label>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
        <button onClick={() => { setMode('search'); setErr('') }} style={{ padding: '10px', fontSize: 13, textAlign: 'center' }}>🔍 Search<br /><span style={{ fontSize: 11, color: 'var(--text3)' }}>banana, eggs...</span></button>
        <button onClick={() => setMode('manual')} style={{ padding: '10px', fontSize: 13, textAlign: 'center' }}>✏️ Manual<br /><span style={{ fontSize: 11, color: 'var(--text3)' }}>enter values</span></button>
      </div>
      {products.length === 0
        ? <p style={{ color: 'var(--text3)', fontSize: 14, textAlign: 'center', padding: '1rem 0' }}>No products yet</p>
        : <>
          <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>{products.length} products · per 100g</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {products.map(p => (
              <div key={p.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.nickname || p.name}</div>
                  {p.nickname && p.nickname !== p.name && <div style={{ fontSize: 11, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>}
                  {p.brand && <div style={{ fontSize: 12, color: 'var(--text2)' }}>{p.brand}</div>}
                </div>
                <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}><Tag type="kcal" label="kcal" value={p.per100g.kcal} /><Tag type="protein" label="P" value={p.per100g.protein} /><Tag type="fat" label="F" value={p.per100g.fat} /><Tag type="carbs" label="C" value={p.per100g.carbs} /></div>
                <button onClick={() => onSave(products.filter(x => x.id !== p.id))} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 20, padding: '0 4px', flexShrink: 0 }}>×</button>
              </div>
            ))}
          </div>
        </>}
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
  const [editingId, setEditingId] = useState(null)
  const [editGrams, setEditGrams] = useState('')
  const [burnedInput, setBurnedInput] = useState('')
  const [burnedSaved, setBurnedSaved] = useState(false)

  const log = dayData[date] || { items: [], burned: 0 }

  useEffect(() => { setBurnedInput(String(log.burned || '')); setEditingId(null) }, [date])

  const fuzzy = q.length > 0
    ? products.map(p => {
        const qL = q.toLowerCase(), nick = (p.nickname || '').toLowerCase(), name = p.name.toLowerCase(), brand = (p.brand || '').toLowerCase()
        let score = 0
        if (nick.startsWith(qL)) score = 4; else if (nick.includes(qL)) score = 3; else if (name.startsWith(qL)) score = 2; else if (name.includes(qL) || brand.includes(qL)) score = 1
        return { p, score }
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 7).map(x => x.p)
    : []

  const pick = (p) => { setSel(p); setQ(p.nickname || p.name); setOpen(false); setMatchErr('') }

  const doAI = async () => {
    if (!q.trim() || !products.length) return
    setMatching(true); setMatchErr('')
    try { const match = await aiMatch(q, products); match ? pick(match) : setMatchErr('No match found.') }
    catch { setMatchErr('AI search error.') }
    setMatching(false)
  }

  const add = async () => {
    const g = parseFloat(grams)
    if (!sel || isNaN(g) || g <= 0) return
    const item = { id: crypto.randomUUID(), productId: sel.id, productName: sel.nickname || sel.name, brand: sel.brand || '', grams: g, kbzhu: calcK(sel, g), time: new Date().toTimeString().slice(0, 5) }
    await onSave(date, { ...log, items: [...log.items, item] })
    setQ(''); setGrams(''); setSel(null); setMatchErr('')
  }

  const del = (id) => onSave(date, { ...log, items: log.items.filter(i => i.id !== id) })

  const saveEdit = (item) => {
    const g = parseFloat(editGrams)
    if (isNaN(g) || g <= 0) { setEditingId(null); return }
    const origProd = products.find(p => p.id === item.productId)
    const newK = origProd ? calcK(origProd, g) : { kcal: +(item.kbzhu.kcal / item.grams * g).toFixed(1), protein: +(item.kbzhu.protein / item.grams * g).toFixed(1), fat: +(item.kbzhu.fat / item.grams * g).toFixed(1), carbs: +(item.kbzhu.carbs / item.grams * g).toFixed(1), fiber: +((item.kbzhu.fiber || 0) / item.grams * g).toFixed(1) }
    onSave(date, { ...log, items: log.items.map(i => i.id === item.id ? { ...i, grams: g, kbzhu: newK } : i) })
    setEditingId(null)
  }

  const saveBurned = async () => {
    await onSave(date, { ...log, burned: parseFloat(burnedInput) || 0 })
    setBurnedSaved(true); setTimeout(() => setBurnedSaved(false), 1500)
  }

  const totals = sumK(log.items)
  const pg = parseFloat(grams)
  const hasPreview = sel && !isNaN(pg) && pg > 0

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ fontSize: 14, width: 'auto' }} />
      </div>

      <div className="surface" style={{ marginBottom: 14 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text2)', marginBottom: 10 }}>Add food</p>
        {products.length === 0
          ? <p style={{ fontSize: 13, color: 'var(--text3)' }}>Add products in the Products tab first</p>
          : <>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <input value={q} onChange={e => { setQ(e.target.value); setSel(null); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 160)} placeholder="Start typing product name..." style={{ width: '100%', boxSizing: 'border-box' }} />
              {open && fuzzy.length > 0 && !sel && (
                <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0, background: 'var(--bg)', border: '0.5px solid var(--border2)', borderRadius: 8, zIndex: 30, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', overflow: 'hidden' }}>
                  {fuzzy.map(p => (
                    <div key={p.id} onMouseDown={() => pick(p)} style={{ padding: '9px 14px', cursor: 'pointer', fontSize: 13, borderBottom: '0.5px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 500 }}>{p.nickname || p.name}</div>
                        {p.nickname && p.nickname !== p.name && <div style={{ fontSize: 11, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>}
                      </div>
                      <span style={{ color: 'var(--text3)', fontSize: 11, flexShrink: 0, marginLeft: 8 }}>{p.per100g.kcal} kcal/100g</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {!sel && <button onClick={doAI} disabled={matching || !q.trim()} style={{ fontSize: 13 }}>{matching ? 'Searching...' : 'AI Search ↗'}</button>}
              {sel && <div style={{ fontSize: 13, color: 'var(--green)', flex: 1 }}>✓ {sel.nickname || sel.name}</div>}
              <input type="number" value={grams} onChange={e => setGrams(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="grams" style={{ width: 90 }} />
              <button onClick={add} disabled={!sel || !grams} className="primary">Add</button>
            </div>
            {matchErr && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{matchErr}</p>}
            {hasPreview && <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>{pg}g → <span style={{ color: 'var(--blue)', fontWeight: 500 }}>{Math.round(sel.per100g.kcal * pg / 100)} kcal</span> · P {(sel.per100g.protein * pg / 100).toFixed(1)}g · F {(sel.per100g.fat * pg / 100).toFixed(1)}g · C {(sel.per100g.carbs * pg / 100).toFixed(1)}g</p>}
          </>}
      </div>

      {log.items.length > 0 && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
            {log.items.map(item => (
              <div key={item.id} className="card" style={{ fontSize: 13 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', minWidth: 34 }}>{item.time}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.productName}</span>
                  {editingId === item.id
                    ? <input type="number" value={editGrams} onChange={e => setEditGrams(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveEdit(item); if (e.key === 'Escape') setEditingId(null) }} onBlur={() => saveEdit(item)} style={{ width: 70, fontSize: 13 }} autoFocus />
                    : <span onClick={() => { setEditingId(item.id); setEditGrams(String(item.grams)) }} style={{ color: 'var(--text2)', flexShrink: 0, cursor: 'pointer', padding: '2px 8px', borderRadius: 4, border: '0.5px solid var(--border)', fontSize: 12 }} title="Tap to edit">{item.grams}g ✎</span>}
                  <span style={{ fontWeight: 500, flexShrink: 0, minWidth: 58, textAlign: 'right' }}>{Math.round(item.kbzhu.kcal)} kcal</span>
                  <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>P{item.kbzhu.protein} F{item.kbzhu.fat} C{item.kbzhu.carbs}</span>
                  <button onClick={() => del(item.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 18, padding: '0 2px' }}>×</button>
                </div>
              </div>
            ))}
          </div>
          <div className="surface" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13, alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 500 }}>Total:</span>
            <span style={{ fontWeight: 500, color: 'var(--blue)' }}>{Math.round(totals.kcal)} kcal</span>
            <span style={{ color: 'var(--green)' }}>P {totals.protein.toFixed(1)}g</span>
            <span style={{ color: 'var(--amber)' }}>F {totals.fat.toFixed(1)}g</span>
            <span style={{ color: 'var(--red)' }}>C {totals.carbs.toFixed(1)}g</span>
          </div>
        </>
      )}

      {log.items.length === 0 && (
        <p style={{ color: 'var(--text2)', fontSize: 14, textAlign: 'center', padding: '1rem 0' }}>No entries for {date === todayStr() ? 'today' : date}</p>
      )}

      <div className="card">
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Calories Burned</p>
        <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>From Apple Watch or other tracker</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="number" value={burnedInput} onChange={e => setBurnedInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveBurned()} placeholder="0" style={{ width: 100 }} />
          <span style={{ fontSize: 13, color: 'var(--text2)' }}>kcal</span>
          <button onClick={saveBurned}>{burnedSaved ? '✓ Saved' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── TODAY TAB ────────────────────────────────────────────────────────────────
function TodayTab({ dayData, onSave, targets }) {
  const date = todayStr()
  const log = dayData[date] || { items: [], burned: 0 }
  const [burnedInput, setBurnedInput] = useState(String(log.burned || ''))
  const [saved, setSaved] = useState(false)

  const totals = sumK(log.items)
  const kcal = Math.round(totals.kcal)
  const burned = log.burned || 0
  const balance = kcal - burned
  const isDeficit = burned > 0 && balance < 0

  const saveBurned = async () => { await onSave(date, { ...log, burned: parseFloat(burnedInput) || 0 }); setSaved(true); setTimeout(() => setSaved(false), 1500) }

  const pP = kcal > 0 ? Math.round(totals.protein * 4 / kcal * 100) : 0
  const pF = kcal > 0 ? Math.round(totals.fat * 9 / kcal * 100) : 0
  const pC = kcal > 0 ? Math.round(totals.carbs * 4 / kcal * 100) : 0

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 16 }}>{new Date().toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long' })}</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 18 }}>
        {[
          { label: 'Consumed', val: kcal, unit: 'kcal', green: false },
          { label: 'Burned', val: burned, unit: 'kcal', green: false },
          { label: isDeficit ? 'Deficit' : 'Balance', val: Math.abs(balance), unit: 'kcal', green: isDeficit },
        ].map(c => (
          <div key={c.label} style={{ background: c.green ? 'var(--green-bg)' : 'var(--bg2)', borderRadius: 10, padding: '12px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: c.green ? 'var(--green)' : 'var(--text2)', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 26, fontWeight: 600, color: c.green ? 'var(--green)' : 'var(--text)', lineHeight: 1 }}>{c.val}</div>
            <div style={{ fontSize: 11, color: c.green ? 'var(--green)' : 'var(--text3)', marginTop: 3 }}>{c.unit}</div>
          </div>
        ))}
      </div>

      <div className="surface" style={{ marginBottom: 14 }}>
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: 'var(--text2)' }}>Goal Progress</p>
        {[
          { label: 'Protein', key: 'protein', unit: 'g', target: targets.protein, color: 'var(--green)' },
          { label: 'Fat', key: 'fat', unit: 'g', target: targets.fat, color: 'var(--amber)' },
          { label: 'Carbs', key: 'carbs', unit: 'g', target: targets.carbs, color: 'var(--red)' },
          { label: 'Calories', key: 'kcal', unit: '', target: targets.kcal, color: 'var(--blue)' },
        ].map(m => {
          const val = m.key === 'kcal' ? kcal : totals[m.key]
          const pct = Math.min(100, Math.round(val / m.target * 100))
          const over = val > m.target
          return (
            <div key={m.key} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                <span style={{ color: 'var(--text2)' }}>{m.label}</span>
                <span style={{ color: over ? 'var(--red)' : m.color }}>{m.key === 'kcal' ? val : val.toFixed(1)}<span style={{ color: 'var(--text3)', fontWeight: 400 }}> / {m.target}{m.unit} ({pct}%)</span></span>
              </div>
              <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: over ? 'var(--red)' : m.color, borderRadius: 3 }} />
              </div>
            </div>
          )
        })}
      </div>

      {kcal > 0 && (
        <div className="surface" style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: 'var(--text2)' }}>Calorie Breakdown</p>
          <div style={{ display: 'flex' }}>
            {[{ label: 'Protein', pct: pP, col: 'var(--green)' }, { label: 'Fat', pct: pF, col: 'var(--amber)' }, { label: 'Carbs', pct: pC, col: 'var(--red)' }].map((mc, i) => (
              <div key={mc.label} style={{ flex: 1, textAlign: 'center', borderRight: i < 2 ? '0.5px solid var(--border)' : 'none', padding: '0 8px' }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: mc.col }}>{mc.pct}%</div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{mc.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Calories Burned</p>
        <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>From Apple Watch or other tracker</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="number" value={burnedInput} onChange={e => setBurnedInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveBurned()} placeholder="0" style={{ width: 100 }} />
          <span style={{ fontSize: 13, color: 'var(--text2)' }}>kcal</span>
          <button onClick={saveBurned}>{saved ? '✓ Saved' : 'Save'}</button>
        </div>
      </div>

      {log.items.length > 0 && (
        <div>
          <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text2)', marginBottom: 8 }}>Today's meals</p>
          {log.items.map(item => (
            <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '0.5px solid var(--border)', fontSize: 13 }}>
              <span style={{ fontSize: 11, color: 'var(--text3)', minWidth: 34 }}>{item.time}</span>
              <span style={{ flex: 1 }}>{item.productName}</span>
              <span style={{ color: 'var(--text2)' }}>{item.grams}g</span>
              <span style={{ fontWeight: 500 }}>{Math.round(item.kbzhu.kcal)} kcal</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── STATISTICS TAB ───────────────────────────────────────────────────────────
function StatisticsTab({ dayData }) {
  const [period, setPeriod] = useState('month')
  const [tooltip, setTooltip] = useState(null)

  const days = period === 'week' ? 7 : 30
  const now = new Date()
  const dateRange = Array.from({ length: days }, (_, i) => {
    const d = new Date(now); d.setDate(d.getDate() - (days - 1 - i)); return d.toISOString().split('T')[0]
  })

  const points = dateRange.map(date => {
    const log = dayData[date] || { items: [], burned: 0 }
    const consumed = Math.round(sumK(log.items).kcal)
    const burned = log.burned || 0
    return { date, consumed, burned, balance: consumed - burned, hasData: log.items.length > 0 || burned > 0 }
  })

  const withData = points.filter(p => p.hasData)
  const n = withData.length || 1
  const avgConsumed = Math.round(withData.reduce((a, p) => a + p.consumed, 0) / n)
  const avgBurned = Math.round(withData.reduce((a, p) => a + p.burned, 0) / n)
  const totalBalance = withData.reduce((a, p) => a + p.balance, 0)
  const avgBalance = Math.round(totalBalance / n)
  const isDeficit = totalBalance < 0
  const weightChange = +(totalBalance / FAT_KCAL).toFixed(2)

  // Safe corridor: 10–20% deficit of avgBurned
  const corrUp = avgBurned > 0 ? -(avgBurned * 0.10) : -150  // -10% (least deficit = ceiling)
  const corrLo = avgBurned > 0 ? -(avgBurned * 0.20) : -300  // -20% (most deficit = floor)

  // SVG chart
  const CW = 340, CH = 165
  const PAD = { top: 14, right: 14, bottom: 24, left: 42 }
  const plotW = CW - PAD.left - PAD.right
  const plotH = CH - PAD.top - PAD.bottom
  const allVals = [...points.map(p => p.balance), corrLo * 1.3, corrUp * 1.3, 250, -50]
  const minVal = Math.min(...allVals), maxVal = Math.max(...allVals)
  const range = maxVal - minVal || 1
  const toX = (i) => PAD.left + (i / Math.max(days - 1, 1)) * plotW
  const toY = (v) => PAD.top + plotH - ((v - minVal) / range) * plotH
  const zeroY = toY(0), corrUpY = toY(corrUp), corrLoY = toY(corrLo)
  const labelIdxs = [0, Math.floor(days / 2), days - 1]

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[['week', 'Week'], ['month', 'Month']].map(([key, label]) => (
          <button key={key} onClick={() => setPeriod(key)} style={{ flex: 1, padding: '9px', fontWeight: period === key ? 600 : 400, fontSize: 14, background: period === key ? 'var(--text)' : 'var(--bg2)', color: period === key ? 'var(--bg)' : 'var(--text)', border: 'none', borderRadius: 9 }}>{label}</button>
        ))}
      </div>

      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, letterSpacing: 0.5, textTransform: 'uppercase' }}>Avg daily {isDeficit ? 'deficit' : 'surplus'} · {period}</div>
        <div style={{ fontSize: 46, fontWeight: 700, color: isDeficit ? 'var(--green)' : 'var(--red)', lineHeight: 1 }}>{Math.abs(avgBalance)}</div>
        <div style={{ fontSize: 13, color: isDeficit ? 'var(--green)' : 'var(--red)', marginTop: 4 }}>kcal / day</div>
      </div>

      <div style={{ background: 'var(--bg2)', borderRadius: 12, padding: '10px 4px 2px', marginBottom: 20 }}>
        <svg width="100%" viewBox={`0 0 ${CW} ${CH}`} style={{ overflow: 'visible', display: 'block' }}>
          {/* Safe corridor */}
          <rect x={PAD.left} y={Math.min(corrUpY, corrLoY)} width={plotW} height={Math.abs(corrUpY - corrLoY)} fill="rgba(99,153,34,0.13)" stroke="rgba(99,153,34,0.28)" strokeWidth="0.5" />
          <text x={PAD.left - 3} y={corrUpY + 3} fontSize="7.5" textAnchor="end" fill="rgba(99,153,34,0.9)">-10%</text>
          <text x={PAD.left - 3} y={corrLoY + 3} fontSize="7.5" textAnchor="end" fill="rgba(99,153,34,0.9)">-20%</text>
          {/* Zero line */}
          <line x1={PAD.left} y1={zeroY} x2={PAD.left + plotW} y2={zeroY} stroke="var(--border2)" strokeWidth="1" strokeDasharray="3,3" />
          <text x={PAD.left - 3} y={zeroY + 3} fontSize="7.5" textAnchor="end" fill="var(--text3)">0</text>
          {/* Lines */}
          {points.map((p, i) => { if (i === 0 || !p.hasData || !points[i-1].hasData) return null; return <line key={`l${i}`} x1={toX(i-1)} y1={toY(points[i-1].balance)} x2={toX(i)} y2={toY(p.balance)} stroke="var(--text3)" strokeWidth="1.2" opacity="0.55" /> })}
          {/* Dots */}
          {points.map((p, i) => {
            if (!p.hasData) return null
            const x = toX(i), y = toY(p.balance)
            const inCorr = p.balance <= corrUp && p.balance >= corrLo
            const dot = inCorr ? '#5a9c1f' : p.balance < 0 ? '#378ADD' : '#E24B4A'
            const pct = avgBurned > 0 ? (p.balance / avgBurned * 100).toFixed(1) : '0'
            const hov = tooltip?.date === p.date
            return (
              <circle key={p.date} cx={x} cy={y} r={hov ? 5.5 : 3.5} fill={dot} stroke="var(--bg)" strokeWidth={hov ? 2 : 1.5} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setTooltip({ x, y, date: p.date, balance: p.balance, pct, inCorr })}
                onMouseLeave={() => setTooltip(null)}
                onTouchStart={(e) => { e.preventDefault(); setTooltip(t => t?.date === p.date ? null : { x, y, date: p.date, balance: p.balance, pct, inCorr }) }}
              />
            )
          })}
          {/* Tooltip */}
          {tooltip && (() => {
            const tx = Math.min(Math.max(tooltip.x - 54, PAD.left), CW - 116)
            const ty = Math.max(tooltip.y - 62, PAD.top)
            const isPos = tooltip.balance > 0
            return (
              <g>
                <rect x={tx} y={ty} width={108} height={50} rx="5" fill="var(--bg)" stroke="var(--border2)" strokeWidth="0.5" />
                <text x={tx+8} y={ty+15} fontSize="9" fill="var(--text2)">{new Date(tooltip.date+'T12:00').toLocaleDateString('en',{month:'short',day:'numeric'})}</text>
                <text x={tx+8} y={ty+30} fontSize="12" fill="var(--text)" fontWeight="600">{isPos?'+':''}{Math.round(tooltip.balance)} kcal</text>
                <text x={tx+8} y={ty+43} fontSize="9.5" fill={tooltip.inCorr?'#5a9c1f':isPos?'#E24B4A':'#378ADD'}>{+tooltip.pct>0?'+':''}{tooltip.pct}% of TDEE</text>
              </g>
            )
          })()}
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: PAD.left-4, paddingRight: PAD.right-4, marginTop: -2, paddingBottom: 6 }}>
          {labelIdxs.map(i => <span key={i} style={{ fontSize: 9, color: 'var(--text3)' }}>{new Date(dateRange[i]+'T12:00').toLocaleDateString('en',{month:'short',day:'numeric'})}</span>)}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {[
          { label: isDeficit ? 'Total Deficit' : 'Total Surplus', value: Math.abs(Math.round(totalBalance)), unit: 'kcal', sub: isDeficit ? '✓ deficit' : '↑ surplus', green: isDeficit, red: !isDeficit && totalBalance !== 0 },
          { label: weightChange < 0 ? 'Est. Weight Loss' : weightChange > 0 ? 'Est. Weight Gain' : 'Weight Change', value: Math.abs(weightChange), unit: 'kg', sub: weightChange < 0 ? 'weight loss' : weightChange > 0 ? 'weight gain' : 'no change', green: weightChange < 0, red: weightChange > 0 },
          { label: 'Avg Consumed', value: avgConsumed, unit: 'kcal / day', sub: `${withData.length} days tracked`, green: false, red: false },
          { label: 'Avg Burned', value: avgBurned, unit: 'kcal / day', sub: 'TDEE estimate', green: false, red: false },
        ].map(b => (
          <div key={b.label} style={{ background: b.green ? 'var(--green-bg)' : b.red ? 'var(--red-bg)' : 'var(--bg2)', borderRadius: 12, padding: '14px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: b.green ? 'var(--green)' : b.red ? 'var(--red)' : 'var(--text2)', marginBottom: 5 }}>{b.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: b.green ? 'var(--green)' : b.red ? 'var(--red)' : 'var(--text)', lineHeight: 1 }}>{b.value}</div>
            <div style={{ fontSize: 11, color: b.green ? 'var(--green)' : b.red ? 'var(--red)' : 'var(--text2)', marginTop: 4 }}>{b.unit}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 3 }}>{b.sub}</div>
          </div>
        ))}
      </div>

      {withData.length === 0 && <p style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', marginTop: 20 }}>No data yet. Start logging meals!</p>}
    </div>
  )
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────
function SettingsTab({ targets, onSaveTargets, onLogout, userEmail }) {
  const [t, setT] = useState({ ...targets })
  const [saved, setSaved] = useState(false)
  const save = () => { onSaveTargets(t); setSaved(true); setTimeout(() => setSaved(false), 1500) }

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 18 }}>Set your daily nutrition goals</p>
      <div className="card" style={{ marginBottom: 10 }}>
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 14 }}>Daily Goals</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[['kcal', 'Calories (kcal)'], ['protein', 'Protein (g)'], ['fat', 'Fat (g)'], ['carbs', 'Carbs (g)']].map(([k, lbl]) => (
            <div key={k}><label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>{lbl}</label><input type="number" value={t[k]} onChange={e => setT({ ...t, [k]: +e.target.value })} style={{ width: '100%' }} /></div>
          ))}
        </div>
        <button onClick={save} className="primary" style={{ marginTop: 14 }}>{saved ? '✓ Saved' : 'Save Goals'}</button>
      </div>
      <div className="surface" style={{ marginTop: 10 }}>
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Account</p>
        <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>{userEmail}</p>
        <button onClick={onLogout} style={{ fontSize: 13, color: 'var(--red)', borderColor: 'var(--red)' }}>Sign Out</button>
      </div>
      <div className="surface" style={{ marginTop: 10 }}>
        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>About</p>
        <p style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>Nutrition Tracker — personal food diary.<br />Data stored in Supabase cloud.<br />Photo recognition & AI search via Claude API.<br />Food search: USDA FoodData Central.<br />1 kg fat = 7,700 kcal.</p>
      </div>
    </div>
  )
}

// ─── AUTH SCREEN ──────────────────────────────────────────────────────────────
function AuthScreen() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const send = async () => {
    if (!email.trim()) return
    setLoading(true); setErr('')
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin } })
    if (error) setErr(error.message); else setSent(true)
    setLoading(false)
  }

  return (
    <div style={{ maxWidth: 400, margin: '0 auto', minHeight: '100dvh', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '2rem' }}>
      <div style={{ fontSize: 36, textAlign: 'center', marginBottom: 12 }}>🥗</div>
      <h1 style={{ fontSize: 22, fontWeight: 600, textAlign: 'center', marginBottom: 6 }}>Nutrition Tracker</h1>
      <p style={{ fontSize: 13, color: 'var(--text2)', textAlign: 'center', marginBottom: 32 }}>Personal food & calorie diary</p>
      {!sent
        ? <div className="card">
            <p style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Sign in or Sign up</p>
            <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 14 }}>Enter your email — we'll send a magic link. No password needed.</p>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="you@email.com" autoFocus style={{ width: '100%', marginBottom: 10 }} />
            {err && <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{err}</p>}
            <button onClick={send} disabled={loading || !email.trim()} className="primary" style={{ width: '100%' }}>{loading ? 'Sending...' : 'Send magic link'}</button>
          </div>
        : <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📬</div>
            <p style={{ fontWeight: 500, marginBottom: 8 }}>Check your email!</p>
            <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>Sent a sign-in link to <strong>{email}</strong>. Click the link to open the app.</p>
            <button onClick={() => setSent(false)} style={{ marginTop: 16, fontSize: 13 }}>← Use different email</button>
          </div>
      }
    </div>
  )
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
const DEFAULT_TARGETS = { kcal: 1800, protein: 90, fat: 60, carbs: 180 }
const TABS = [
  { id: 'today', label: 'Today' },
  { id: 'log', label: 'Log' },
  { id: 'stats', label: 'Stats' },
  { id: 'products', label: 'Products' },
  { id: 'settings', label: 'Settings' },
]

export default function App() {
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [tab, setTab] = useState('today')
  const [products, setProducts] = useState([])
  const [dayData, setDayData] = useState({})
  const [targets, setTargets] = useState(DEFAULT_TARGETS)
  const [dataReady, setDataReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => { setSession(session); setAuthLoading(false) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => setSession(session))
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    const uid = session.user.id
    setDataReady(false)
    Promise.all([
      supabase.from('products').select('*').eq('user_id', uid).order('created_at')
        .then(({ data }) => { if (data) setProducts(data.map(rowToProduct)) }),
      supabase.from('day_logs').select('*').eq('user_id', uid)
        .gte('date', new Date(Date.now() - 90 * 864e5).toISOString().split('T')[0])
        .then(({ data }) => { const days = {}; if (data) data.forEach(r => { days[r.date] = { items: r.items || [], burned: r.burned_kcal || 0 } }); setDayData(days) }),
      supabase.from('user_settings').select('*').eq('user_id', uid).maybeSingle()
        .then(({ data }) => { if (data) setTargets({ kcal: data.target_kcal, protein: data.target_protein, fat: data.target_fat, carbs: data.target_carbs }) }),
    ]).then(() => setDataReady(true))
  }, [session])

  const saveProducts = async (newProds) => {
    const uid = session.user.id
    const oldIds = new Set(products.map(p => p.id))
    const newIds = new Set(newProds.map(p => p.id))
    for (const p of newProds.filter(p => !oldIds.has(p.id))) {
      await supabase.from('products').insert({ id: p.id, user_id: uid, name: p.name, nickname: p.nickname || '', brand: p.brand || '', url: p.url || '', kcal: p.per100g.kcal, protein: p.per100g.protein, fat: p.per100g.fat, carbs: p.per100g.carbs, fiber: p.per100g.fiber || 0 })
    }
    for (const p of products.filter(p => !newIds.has(p.id))) await supabase.from('products').delete().eq('id', p.id)
    setProducts(newProds)
  }

  const saveDayData = async (date, data) => {
    const uid = session.user.id
    setDayData(prev => ({ ...prev, [date]: data }))
    await supabase.from('day_logs').upsert({ user_id: uid, date, items: data.items, burned_kcal: data.burned || 0, updated_at: new Date().toISOString() }, { onConflict: 'user_id,date' })
  }

  const saveTargets = async (t) => {
    const uid = session.user.id; setTargets(t)
    await supabase.from('user_settings').upsert({ user_id: uid, target_kcal: t.kcal, target_protein: t.protein, target_fat: t.fat, target_carbs: t.carbs })
  }

  const logout = () => supabase.auth.signOut()

  if (authLoading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh', color: 'var(--text2)', fontSize: 14 }}>Loading...</div>
  if (!session) return <AuthScreen />
  if (!dataReady) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh', color: 'var(--text2)', fontSize: 14 }}>Loading your data...</div>

  return (
    <div style={{ maxWidth: 540, margin: '0 auto', minHeight: '100dvh', background: 'var(--bg)' }}>
      <div style={{ padding: '16px 20px 0', borderBottom: '0.5px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h1 style={{ fontSize: 17, fontWeight: 600 }}>Nutrition Tracker</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>{session.user.email}</span>
            <button onClick={logout} style={{ fontSize: 11, padding: '3px 8px' }}>Sign out</button>
          </div>
        </div>
        <div style={{ display: 'flex', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: '7px 12px', border: 'none', borderBottom: `2px solid ${tab === t.id ? 'var(--text)' : 'transparent'}`, background: 'transparent', color: tab === t.id ? 'var(--text)' : 'var(--text2)', fontWeight: tab === t.id ? 600 : 400, cursor: 'pointer', fontSize: 13, marginBottom: -1, flexShrink: 0 }}>{t.label}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: '20px 20px 80px' }}>
        {tab === 'today' && <TodayTab dayData={dayData} onSave={saveDayData} targets={targets} />}
        {tab === 'log' && <LogTab products={products} dayData={dayData} onSave={saveDayData} />}
        {tab === 'stats' && <StatisticsTab dayData={dayData} />}
        {tab === 'products' && <ProductsTab products={products} onSave={saveProducts} />}
        {tab === 'settings' && <SettingsTab targets={targets} onSaveTargets={saveTargets} onLogout={logout} userEmail={session.user.email} />}
      </div>
    </div>
  )
}
