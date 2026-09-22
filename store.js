// iPhone 内（IndexedDB）にデータを保存し、PC版サーバーと同じ形の API を提供する
const DB_NAME = 'care-calendar';
const TABLES = ['categories', 'places', 'medicines', 'events', 'event_medicines', 'photos'];
let idb;
const mem = { categories: [], places: [], medicines: [], events: [], event_medicines: [], photos: [], meta: {} };
const urlCache = new Map(); // 'p<id>' -> object URL

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function tx(stores, mode = 'readwrite') {
  return idb.transaction(stores, mode);
}
function done(t) {
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}

export async function openStore() {
  idb = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const t of TABLES) {
        if (t === 'event_medicines') d.createObjectStore(t, { keyPath: ['event_id', 'medicine_id'] });
        else d.createObjectStore(t, { keyPath: 'id', autoIncrement: true });
      }
      d.createObjectStore('blobs');
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const t = tx([...TABLES, 'meta'], 'readonly');
  for (const name of TABLES) mem[name] = await req(t.objectStore(name).getAll());
  const keys = await req(t.objectStore('meta').getAllKeys());
  const vals = await req(t.objectStore('meta').getAll());
  keys.forEach((k, i) => (mem.meta[k] = vals[i]));

  if (!mem.categories.length) {
    await insert('categories', { name: '美容院', color: '#db2777', icon: '✂️', sort: 1 });
    await insert('categories', { name: '病院（皮膚科）', color: '#0f766e', icon: '🏥', sort: 2 });
    await insert('categories', { name: '歯医者', color: '#2563eb', icon: '🦷', sort: 3 });
  }
  // ホーム画面のアプリでも消されにくくする
  navigator.storage?.persist?.().catch(() => {});
}

async function insert(table, obj) {
  const t = tx(table);
  const id = await req(t.objectStore(table).add(obj));
  await done(t);
  obj.id = id;
  mem[table].push(obj);
  return id;
}
async function save(table, obj) {
  const t = tx(table);
  t.objectStore(table).put(obj);
  await done(t);
}
async function remove(table, key) {
  const t = tx(table);
  t.objectStore(table).delete(key);
  await done(t);
}
export function getMeta(key) {
  return mem.meta[key] ?? null;
}
export async function setMeta(key, value) {
  const t = tx('meta');
  t.objectStore('meta').put(value, key);
  await done(t);
  mem.meta[key] = value;
}

// ---------------- 写真 ----------------
const photoName = (p) => `p${p.id}`;
export function photoUrl(name) {
  return urlCache.get(name) || '';
}
async function ensureUrls(names) {
  const need = [...new Set(names.filter((n) => n && !urlCache.has(n)))];
  if (!need.length) return;
  const t = tx('blobs', 'readonly');
  const store = t.objectStore('blobs');
  for (const n of need) {
    const blob = await req(store.get(Number(n.slice(1))));
    if (blob) urlCache.set(n, URL.createObjectURL(blob));
  }
}
function photosOf(type, id) {
  return mem.photos.filter((p) => p.owner_type === type && p.owner_id === id).sort((a, b) => a.id - b.id)
    .map((p) => ({ id: p.id, filename: photoName(p), caption: p.caption || '' }));
}
function firstPhoto(type, id) {
  return photosOf(type, id)[0]?.filename || null;
}
async function deletePhoto(p) {
  const t = tx(['photos', 'blobs']);
  t.objectStore('photos').delete(p.id);
  t.objectStore('blobs').delete(p.id);
  await done(t);
  mem.photos = mem.photos.filter((x) => x.id !== p.id);
  const u = urlCache.get(photoName(p));
  if (u) { URL.revokeObjectURL(u); urlCache.delete(photoName(p)); }
}
async function deletePhotosOf(type, id) {
  for (const p of mem.photos.filter((x) => x.owner_type === type && x.owner_id === id)) await deletePhoto(p);
}
async function addPhoto(type, id, blob) {
  const meta = { owner_type: type, owner_id: id, caption: '', type: blob.type || 'image/jpeg', created_at: new Date().toISOString() };
  const t = tx(['photos', 'blobs']);
  const pid = await req(t.objectStore('photos').add(meta));
  t.objectStore('blobs').put(blob, pid);
  await done(t);
  meta.id = pid;
  mem.photos.push(meta);
}

// ---------------- 参照ヘルパー ----------------
const str = (v) => (v == null ? '' : String(v).trim());
const idOrNull = (v) => (v === '' || v == null ? null : Number(v));
const byName = (a, b) => a.name.localeCompare(b.name, 'ja');
const find = (table, id) => mem[table].find((x) => x.id === Number(id));
class ApiError extends Error {}
const bad = (msg) => { throw new ApiError(msg); };

function eventRow(e) {
  const c = find('categories', e.category_id) || {};
  const p = e.place_id ? find('places', e.place_id) : null;
  return {
    ...e, category_name: c.name, color: c.color, icon: c.icon, place_name: p ? p.name : null,
    photo_count: mem.photos.filter((x) => x.owner_type === 'event' && x.owner_id === e.id).length,
    medicine_count: mem.event_medicines.filter((x) => x.event_id === e.id).length,
  };
}
function eventCmp(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (!a.time !== !b.time) return a.time ? -1 : 1; // 時刻なしは後ろ
  return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
}

// ---------------- ルーティング ----------------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:\w+/g, '(\\d+)')}$`), fn });

// カテゴリ
route('GET', '/api/categories', () => [...mem.categories].sort((a, b) => a.sort - b.sort || a.id - b.id));
route('POST', '/api/categories', async (_, b) => {
  const name = str(b.name) || bad('カテゴリ名を入力してください');
  const sort = Math.max(0, ...mem.categories.map((c) => c.sort)) + 1;
  return { id: await insert('categories', { name, color: str(b.color) || '#0f766e', icon: str(b.icon), sort }) };
});
// 並び順の変更: ids の順に sort を振り直す
route('PUT', '/api/categories/order', async (_, b) => {
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number);
  for (const c of mem.categories) {
    const i = ids.indexOf(c.id);
    const sort = i < 0 ? ids.length + c.sort : i + 1;
    if (c.sort !== sort) { c.sort = sort; await save('categories', c); }
  }
  return { ok: true };
});
route('PUT', '/api/categories/:id', async ([id], b) => {
  const c = find('categories', id);
  Object.assign(c, { name: str(b.name) || bad('カテゴリ名を入力してください'), color: str(b.color) || '#0f766e', icon: str(b.icon) });
  await save('categories', c);
  return { ok: true };
});
route('DELETE', '/api/categories/:id', async ([id]) => {
  id = Number(id);
  for (const e of mem.events.filter((x) => x.category_id === id)) await deleteEvent(e.id);
  for (const p of mem.places.filter((x) => x.category_id === id)) await deletePlace(p.id);
  for (const m of mem.medicines.filter((x) => x.category_id === id)) { m.category_id = null; await save('medicines', m); }
  await remove('categories', id);
  mem.categories = mem.categories.filter((x) => x.id !== id);
  return { ok: true };
});

// 病院・お店
route('GET', '/api/places', (_, __, q) => {
  const list = q.get('category_id') ? mem.places.filter((p) => p.category_id === Number(q.get('category_id'))) : mem.places;
  return [...list].sort((a, b) => a.category_id - b.category_id || byName(a, b));
});
route('GET', '/api/places/:id', ([id]) => {
  const p = find('places', id);
  if (!p) bad('not found');
  return {
    ...p,
    photos: photosOf('place', p.id),
    medicines: mem.medicines.filter((m) => m.place_id === p.id).sort(byName),
    events: mem.events.filter((e) => e.place_id === p.id).sort(eventCmp).reverse().slice(0, 50),
  };
});
function placeFields(b) {
  const f = { category_id: Number(b.category_id), name: str(b.name), url: str(b.url), phone: str(b.phone), address: str(b.address), memo: str(b.memo) };
  if (!f.category_id || !f.name) bad('カテゴリと名前は必須です');
  return f;
}
route('POST', '/api/places', async (_, b) => ({ id: await insert('places', placeFields(b)) }));
route('PUT', '/api/places/:id', async ([id], b) => {
  const p = Object.assign(find('places', id), placeFields(b));
  await save('places', p);
  return { ok: true };
});
async function deletePlace(id) {
  await deletePhotosOf('place', id);
  for (const m of mem.medicines.filter((x) => x.place_id === id)) { m.place_id = null; await save('medicines', m); }
  for (const e of mem.events.filter((x) => x.place_id === id)) { e.place_id = null; await save('events', e); }
  await remove('places', id);
  mem.places = mem.places.filter((x) => x.id !== id);
}
route('DELETE', '/api/places/:id', async ([id]) => { await deletePlace(Number(id)); return { ok: true }; });

// 薬
route('GET', '/api/medicines', () => [...mem.medicines].sort(byName)
  .map((m) => ({ ...m, place_name: find('places', m.place_id)?.name || null, thumb: firstPhoto('medicine', m.id) })));
route('GET', '/api/medicines/:id', ([id]) => {
  const m = find('medicines', id);
  if (!m) bad('not found');
  const events = mem.event_medicines.filter((x) => x.medicine_id === m.id)
    .map((x) => ({ ...find('events', x.event_id), note: x.note })).filter((e) => e.id)
    .sort(eventCmp).reverse().slice(0, 50).map(({ id, date, title, note }) => ({ id, date, title, note }));
  return { ...m, place_name: find('places', m.place_id)?.name || null, photos: photosOf('medicine', m.id), events };
});
function medFields(b) {
  const f = { category_id: idOrNull(b.category_id), place_id: idOrNull(b.place_id), name: str(b.name), efficacy: str(b.efficacy), usage: str(b.usage), memo: str(b.memo) };
  if (!f.name) bad('薬の名前を入力してください');
  return f;
}
route('POST', '/api/medicines', async (_, b) => ({ id: await insert('medicines', medFields(b)) }));
route('PUT', '/api/medicines/:id', async ([id], b) => {
  const m = Object.assign(find('medicines', id), medFields(b));
  await save('medicines', m);
  return { ok: true };
});
route('DELETE', '/api/medicines/:id', async ([id]) => {
  id = Number(id);
  await deletePhotosOf('medicine', id);
  for (const x of mem.event_medicines.filter((x) => x.medicine_id === id)) await remove('event_medicines', [x.event_id, x.medicine_id]);
  mem.event_medicines = mem.event_medicines.filter((x) => x.medicine_id !== id);
  await remove('medicines', id);
  mem.medicines = mem.medicines.filter((x) => x.id !== id);
  return { ok: true };
});

// 予定
// カレンダーから取り込み済みの予定（重複取り込みの防止用）
route('GET', '/api/ext-ids', () => mem.events.map((e) => e.ext_id).filter(Boolean));
route('GET', '/api/events', (_, __, q) => {
  const from = q.get('from'), to = q.get('to'), cat = q.get('category_id'), text = (q.get('q') || '').toLowerCase();
  let list = mem.events.filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!cat || e.category_id === Number(cat)));
  if (text) {
    const has = (s) => (s || '').toLowerCase().includes(text);
    list = list.filter((e) => has(e.title) || has(e.memo) || has(find('places', e.place_id)?.name)
      || mem.event_medicines.some((x) => x.event_id === e.id && has(find('medicines', x.medicine_id)?.name)));
  }
  list.sort(eventCmp);
  if (q.get('order') === 'desc') list.reverse();
  return list.slice(0, Math.min(Number(q.get('limit')) || 1000, 1000)).map(eventRow);
});
route('GET', '/api/events/:id', ([id]) => {
  const e = find('events', id);
  if (!e) bad('not found');
  return {
    ...eventRow(e),
    place: e.place_id ? find('places', e.place_id) || null : null,
    photos: photosOf('event', e.id),
    medicines: mem.event_medicines.filter((x) => x.event_id === e.id)
      .map((x) => ({ ...find('medicines', x.medicine_id), note: x.note, thumb: firstPhoto('medicine', x.medicine_id) }))
      .filter((m) => m.id).sort(byName),
  };
});
function eventFields(b) {
  const f = { category_id: Number(b.category_id), place_id: idOrNull(b.place_id), date: str(b.date), time: str(b.time), title: str(b.title), memo: str(b.memo), done: b.done ? 1 : 0, ext_id: str(b.ext_id) };
  if (!f.category_id) bad('カテゴリを選んでください');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) bad('日付が正しくありません');
  return f;
}
async function saveEventMedicines(eventId, meds) {
  for (const x of mem.event_medicines.filter((x) => x.event_id === eventId)) await remove('event_medicines', [x.event_id, x.medicine_id]);
  mem.event_medicines = mem.event_medicines.filter((x) => x.event_id !== eventId);
  for (const m of Array.isArray(meds) ? meds : []) {
    const mid = Number(m?.medicine_id);
    if (!mid || mem.event_medicines.some((x) => x.event_id === eventId && x.medicine_id === mid)) continue;
    const row = { event_id: eventId, medicine_id: mid, note: str(m.note) };
    await save('event_medicines', row);
    mem.event_medicines.push(row);
  }
}
route('POST', '/api/events', async (_, b) => {
  const id = await insert('events', { ...eventFields(b), created_at: new Date().toISOString() });
  await saveEventMedicines(id, b.medicines);
  return { id };
});
route('PUT', '/api/events/:id', async ([id], b) => {
  const e = Object.assign(find('events', id), eventFields(b));
  await save('events', e);
  if (b.medicines) await saveEventMedicines(e.id, b.medicines);
  return { ok: true };
});
async function deleteEvent(id) {
  await deletePhotosOf('event', id);
  await saveEventMedicines(id, []);
  await remove('events', id);
  mem.events = mem.events.filter((x) => x.id !== id);
}
route('DELETE', '/api/events/:id', async ([id]) => { await deleteEvent(Number(id)); return { ok: true }; });

// 写真
route('POST', '/api/photos', async (_, fd) => {
  const type = fd.get('owner_type');
  const id = Number(fd.get('owner_id'));
  if (!['event', 'medicine', 'place'].includes(type) || !id) bad('owner が不正です');
  for (const f of fd.getAll('files')) await addPhoto(type, id, f);
  return { photos: photosOf(type, id) };
});
route('DELETE', '/api/photos/:id', async ([id]) => {
  const p = find('photos', id);
  if (p) await deletePhoto(p);
  return { ok: true };
});

// レスポンスに含まれる写真名を集める
function collectNames(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => collectNames(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'filename' || k === 'thumb') && typeof x === 'string') out.push(x);
      else if (x && typeof x === 'object') collectNames(x, out);
    }
  }
  return out;
}

export async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const url = new URL(path, 'http://local');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const result = await r.fn(m.slice(1), opts.body ?? {}, url.searchParams);
    const out = structuredClone(result);
    await ensureUrls(collectNames(out));
    return out;
  }
  throw new Error(`未対応の操作です: ${method} ${url.pathname}`);
}

// ---------------- バックアップ（書き出し / 読み込み） ----------------
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function stats() {
  return { events: mem.events.length, places: mem.places.length, medicines: mem.medicines.length, photos: mem.photos.length };
}

export async function exportBackup() {
  const t = tx('blobs', 'readonly');
  const store = t.objectStore('blobs');
  const photos = [];
  for (const p of mem.photos) {
    const blob = await req(store.get(p.id));
    photos.push({ ...p, data: blob ? await blobToBase64(blob) : null });
  }
  const data = { app: 'care-calendar', version: 1, exportedAt: new Date().toISOString(), data: {} };
  for (const t2 of TABLES) data.data[t2] = t2 === 'photos' ? photos : mem[t2];
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `care-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
  return new File([JSON.stringify(data)], name, { type: 'application/json' });
}

export async function importBackup(file) {
  const json = JSON.parse(await file.text());
  if (json?.app !== 'care-calendar' || !json.data) throw new Error('通院ノートのバックアップファイルではありません');
  const t = tx([...TABLES, 'blobs']);
  for (const name of [...TABLES, 'blobs']) t.objectStore(name).clear();
  for (const name of TABLES) {
    for (const row of json.data[name] || []) {
      if (name === 'photos') {
        const { data, ...meta } = row;
        t.objectStore('photos').put(meta);
        if (data) t.objectStore('blobs').put(base64ToBlob(data, meta.type || 'image/jpeg'), meta.id);
      } else {
        t.objectStore(name).put(row);
      }
    }
  }
  await done(t);
  for (const u of urlCache.values()) URL.revokeObjectURL(u);
  urlCache.clear();
  for (const name of TABLES) mem[name] = (json.data[name] || []).map((r) => { const { data, ...rest } = r; return rest; });
  return stats();
}
