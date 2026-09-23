// OurTime（iPhone 版・データは端末内に保存）
import { openStore, api as storeApi, photoUrl, getMeta, setMeta, stats, exportBackup, importBackup } from './store.js';
import { pushSupported, enablePush, sendJobs, testPush, disablePush, setClientProvider, claimOwner, redeemPairCode, issuePairCode, listClients, removeClient } from './push.js';

// 通知・家族共有サーバーは「承認済みの端末」だけが使える
setClientProvider(() => getMeta('server_client'));
const approved = () => !!getMeta('server_client');
import { MEMBER_COLORS, newInviteCode, normalizeCode, joinFamily, pushFamily, pullFamily, leaveFamily } from './family.js';

// 予定が変わったら通知サーバーの予約と家族共有も更新する
async function api(path, opts = {}) {
  const res = await storeApi(path, opts);
  if (opts.method && opts.method !== 'GET' && /^\/api\/(events|places|categories)/.test(path)) {
    schedulePushSync();
    scheduleFamilyPush();
  }
  return res;
}

// ---------------- 家族共有（見るだけ） ----------------
const family = () => getMeta('family');
let familyTimer = null;
function scheduleFamilyPush() {
  if (!family() || !approved()) return;
  clearTimeout(familyTimer);
  familyTimer = setTimeout(() => syncFamily(true), 1500);
}
// 自分の共有予定を送り、家族の予定を受け取る
async function syncFamily(pushOnly = false) {
  const fam = family();
  if (!fam) return;
  try {
    const from = new Date(); from.setMonth(from.getMonth() - 3);
    const mine = (await storeApi(`/api/events?from=${ymd(from)}`)).filter((e) => e.shared)
      .map((e) => ({ id: e.id, date: e.date, time: e.time, title: e.title || '予定', done: e.done })); // カテゴリ・病院名・メモは送らない
    await pushFamily(fam, { name: fam.name, color: fam.color }, mine);
    if (!pushOnly) {
      const members = (await pullFamily(fam)).filter((m) => m.memberId !== fam.memberId);
      await setMeta('family_cache', { at: new Date().toISOString(), members });
    }
    await setMeta('family_error', '');
  } catch (err) {
    await setMeta('family_error', err.message);
  }
}
let lastPull = 0;
async function pullFamilyIfStale() {
  if (!family() || !approved() || Date.now() - lastPull < 60000) return false;
  lastPull = Date.now();
  await syncFamily();
  return true;
}
// 家族の予定（期間内）: [{ date, time, title, name, color }]
function familyEvents(from, to) {
  const cache = getMeta('family_cache');
  if (!family() || !cache) return [];
  return cache.members.flatMap((m) => (m.events || [])
    .filter((e) => e.date >= from && e.date <= to)
    .map((e) => ({ ...e, name: m.name, color: m.color || '#7c3aed' })));
}
import { parseCalendarText, guessCategory } from './import-cal.js';
import { searchPlaces } from './places.js';
import { ALARM_OPTIONS, buildIcs, openIcs, shareIcs } from './calendar-export.js';
import { holidayName } from './holidays.js';
import { gomiOut, gomiCollect, GOMI_RANGE, GOMI_SOURCE } from './gomi.js';

// ごみの日（前日の夜に出す前提で1日前に表示）
const gomiOn = () => getMeta('gomi_on') !== false;
const gomiFor = (dateStr) => (gomiOn() ? gomiOut(dateStr) : []);
const GOMI_SHORT = { 燃やせるごみ: '燃やせる', 燃やせないごみ: '燃やせない', プラ容器包装: 'プラ', ペットボトル: 'ペット', 紙ごみ: '紙', リチウムイオン電池: '電池' };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const todayStr = () => ymd(new Date());
function fmtDate(s, withDow = true) {
  const [y, m, d] = s.split('-').map(Number);
  const dow = DOW[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}${withDow ? `（${dow}）` : ''}`;
}
function fmtLongDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${y}年${m}月${d}日（${DOW[new Date(y, m - 1, d).getDay()]}）`;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : u ? `https://${u}` : '');


function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

// ---------------- 状態 ----------------
const state = {
  tab: 'calendar',
  month: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(),
  selected: todayStr(),
  filter: new Set(), // 空 = すべて
  categories: [],
  places: [],
  medicines: [],
  masterSeg: 'places',
  medQuery: '',
  listQuery: '',
  listPast: false,
};
const catById = (id) => state.categories.find((c) => c.id === Number(id));

async function loadMasters() {
  [state.categories, state.places, state.medicines] = await Promise.all([
    api('/api/categories'), api('/api/places'), api('/api/medicines'),
  ]);
}

// ---------------- 画像の縮小（通信量と容量の節約） ----------------
async function shrinkImage(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}
async function uploadPhotos(ownerType, ownerId, files) {
  if (!files.length) return;
  const fd = new FormData();
  fd.append('owner_type', ownerType);
  fd.append('owner_id', ownerId);
  for (const f of files) fd.append('files', await shrinkImage(f));
  await api('/api/photos', { method: 'POST', body: fd });
}

// 写真エディタ（既存 + 追加予定を管理）
// st を渡すと、別シートへ移って戻ってきても追加予定の写真が保持される
function photoEditor(container, existing = [], st = {}) {
  st.pending ||= [];
  st.removed ||= [];
  const { pending, removed } = st;
  let photos = existing.filter((p) => !removed.includes(p.id));
  const render = () => {
    container.innerHTML = `<div class="photos">
      ${photos.map((p) => `<div class="photo"><img src="${photoUrl(p.filename)}" data-full="${photoUrl(p.filename)}" alt=""><button type="button" class="del" data-del="${p.id}" aria-label="削除">✕</button></div>`).join('')}
      ${pending.map((p, i) => `<div class="photo pending"><img src="${p.url}" alt=""><button type="button" class="del" data-pdel="${i}" aria-label="取消">✕</button></div>`).join('')}
      <label class="add-photo" title="写真を追加">＋<input type="file" accept="image/*" multiple hidden></label>
    </div>`;
    $('input[type=file]', container).addEventListener('change', (e) => {
      for (const f of e.target.files) pending.push({ file: f, url: URL.createObjectURL(f) });
      render();
    });
    $$('[data-del]', container).forEach((b) => b.addEventListener('click', () => {
      removed.push(Number(b.dataset.del));
      photos = photos.filter((p) => p.id !== Number(b.dataset.del));
      render();
    }));
    $$('[data-pdel]', container).forEach((b) => b.addEventListener('click', () => {
      pending.splice(Number(b.dataset.pdel), 1);
      render();
    }));
  };
  render();
  return {
    async commit(ownerType, ownerId) {
      for (const id of removed) await api(`/api/photos/${id}`, { method: 'DELETE' });
      await uploadPhotos(ownerType, ownerId, pending.map((p) => p.file));
    },
  };
}
function photoGrid(photos) {
  if (!photos?.length) return '';
  return `<div class="photos">${photos.map((p) => `<div class="photo"><img src="${photoUrl(p.filename)}" data-full="${photoUrl(p.filename)}" alt="" loading="lazy"></div>`).join('')}</div>`;
}

// ---------------- シート（モーダル） ----------------
const sheetStack = [];
function openSheet(render) {
  sheetStack.push(render);
  showSheet();
}
async function showSheet() {
  const render = sheetStack.at(-1);
  const sheet = $('#sheet');
  if (!render) { closeAllSheets(); return; }
  $('#sheet-backdrop').hidden = false;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  await render(sheet);
  addHeadSave(sheet);
  sheet.scrollTop = 0;
}
// 入力画面では、上の見出しにも「保存」を置いてスクロールせずに保存できるようにする
function addHeadSave(sheet) {
  const head = $('.sheet-head', sheet);
  if (!head || $('[data-headsave]', head)) return;
  const form = [...sheet.querySelectorAll('form')].find((f) => [...f.querySelectorAll('button.primary')].some((b) => b.type === 'submit' && b.textContent.trim() === '保存'));
  if (!form) return;
  head.insertAdjacentHTML('beforeend', '<button type="button" class="btn primary" data-headsave>保存</button>');
  $('[data-headsave]', head).addEventListener('click', () => form.requestSubmit());
}
function backSheet() {
  sheetStack.pop();
  showSheet();
}
function closeAllSheets() {
  sheetStack.length = 0;
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  $('#sheet').innerHTML = '';
  document.body.style.overflow = '';
}
function sheetHead(title, extra = '') {
  // 閉じる／戻るボタンは右手の親指で押しやすい右下に置く
  return `<div class="sheet-head"><h1>${esc(title)}</h1>${extra}</div>
    <button type="button" class="sheet-close" data-back aria-label="${sheetStack.length > 1 ? '戻る' : '閉じる'}">${sheetStack.length > 1 ? '‹' : '✕'}</button>`;
}
function bindHead(sheet) {
  $('[data-back]', sheet)?.addEventListener('click', backSheet);
}
$('#sheet-backdrop').addEventListener('click', closeAllSheets);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('#lightbox').hidden) $('#lightbox').hidden = true; else if (sheetStack.length) backSheet(); }
});
document.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-full]');
  if (img) { $('img', $('#lightbox')).src = img.dataset.full; $('#lightbox').hidden = false; }
});
$('#lightbox').addEventListener('click', () => ($('#lightbox').hidden = true));

async function refresh() {
  await loadMasters();
  await renderTab();
}

// ---------------- カレンダー ----------------
async function renderCalendar(view) {
  const m = state.month;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const end = new Date(start); end.setDate(start.getDate() + 41);
  const events = (await api(`/api/events?from=${ymd(start)}&to=${ymd(end)}`))
    .filter((e) => !state.filter.size || state.filter.has(e.category_id));
  const byDate = {};
  for (const e of events) (byDate[e.date] ||= []).push(e);
  // 家族の予定（見るだけ）
  const famByDate = {};
  for (const e of familyEvents(ymd(start), ymd(end))) (famByDate[e.date] ||= []).push(e);
  for (const l of Object.values(famByDate)) l.sort((a, b) => (a.time || '99') < (b.time || '99') ? -1 : 1);
  const famPill = (e) => `<span class="pill fam ${e.done ? 'done' : ''}" style="--c:${esc(e.color)}">${esc(e.name.slice(0, 2))}:${esc(e.title)}</span>`;

  const today = todayStr();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = ymd(d);
    const list = byDate[ds] || [];
    const fam = famByDate[ds] || [];
    const hol = holidayName(ds);
    const cls = ['cal-day', d.getMonth() !== m.getMonth() && 'other', ds === today && 'today', ds === state.selected && 'sel',
      (d.getDay() === 0 || hol) && 'sun', d.getDay() === 6 && !hol && 'sat'].filter(Boolean).join(' ');
    cells += `<button class="${cls}" data-date="${ds}"><span class="daytop"><span class="num">${d.getDate()}</span>${hol ? `<span class="hol">${esc(hol)}</span>` : ''}</span>
      ${[...list.map((e) => `<span class="pill ${e.done ? 'done' : ''}" style="--c:${esc(e.color)}">${esc(e.icon)}${esc(e.place_name || e.title || e.category_name)}</span>`), ...fam.map(famPill)].slice(0, 3).join('')}
      ${gomiFor(ds).length ? `<span class="pill gomi">🗑️${esc(gomiFor(ds).map((t) => GOMI_SHORT[t] || t).join('・'))}</span>` : ''}
      ${list.length + fam.length > 3 ? `<span class="more">+${list.length + fam.length - 3}</span>` : ''}</button>`;
    if (i === 34 && d >= new Date(m.getFullYear(), m.getMonth() + 1, 0)) break; // 5週で収まる月
  }

  const dayEvents = byDate[state.selected] || [];
  const dayFam = famByDate[state.selected] || [];
  const famItem = (e) => `<div class="item fam ${e.done ? 'done' : ''}" style="--c:${esc(e.color)};cursor:default"><span class="bar"></span>
    <span class="body"><div class="t">${esc(e.title)}</div><div class="s">👤 ${esc(e.name)}の予定${e.time ? ` · ${esc(e.time)}` : ''}</div></span></div>`;
  view.innerHTML = `
    <div class="cal-head">
      <button class="icon-btn" data-nav="-1" aria-label="前の月">‹</button>
      <h1>${m.getFullYear()}年${m.getMonth() + 1}月</h1>
      <button class="icon-btn" data-nav="1" aria-label="次の月">›</button>
      <button class="btn" data-today style="min-height:34px;padding:4px 10px">今日</button>
    </div>
    ${categoryChips()}
    <div class="cal">
      <div class="cal-grid">${DOW.map((w, i) => `<div class="cal-dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
    </div>
    <h2>${fmtLongDate(state.selected)}${holidayName(state.selected) ? ` <span style="color:#dc2626">${esc(holidayName(state.selected))}</span>` : ''}</h2>
    ${gomiFor(state.selected).length ? `<div class="box" style="margin-bottom:10px;border-color:#57534e">
      🗑️ <b>今夜出す: ${esc(gomiFor(state.selected).join('・'))}</b>
      <div class="small muted">（翌${fmtDate(addDays(state.selected, 1))}の朝 5:00〜8:30 に収集）</div></div>` : ''}
    <div class="card">${dayEvents.length || dayFam.length ? dayEvents.map((e) => eventItem(e)).join('') + dayFam.map(famItem).join('') : '<div class="empty">予定はありません</div>'}</div>
    <button class="fab" data-add aria-label="予定を追加">＋</button>`;
  // 家族の予定は1分以上たっていれば取り直して描き直す
  pullFamilyIfStale().then((pulled) => { if (pulled && state.tab === 'calendar') renderTab(); });

  $$('[data-nav]', view).forEach((b) => b.addEventListener('click', () => {
    state.month = new Date(m.getFullYear(), m.getMonth() + Number(b.dataset.nav), 1);
    renderTab();
  }));
  $('[data-today]', view).addEventListener('click', () => {
    const d = new Date();
    state.month = new Date(d.getFullYear(), d.getMonth(), 1);
    state.selected = todayStr();
    renderTab();
  });
  $$('[data-date]', view).forEach((b) => b.addEventListener('click', () => {
    const ds = b.dataset.date;
    if (state.selected === ds && (byDate[ds] || []).length === 0 && (famByDate[ds] || []).length === 0) { openEventEdit(null, ds); return; }
    state.selected = ds;
    const [y, mo] = ds.split('-').map(Number);
    if (mo - 1 !== m.getMonth()) state.month = new Date(y, mo - 1, 1);
    renderTab();
  }));
  $('[data-add]', view).addEventListener('click', () => openEventEdit(null, state.selected));
  bindChips(view);
  bindEventItems(view);
}

function categoryChips() {
  return `<div class="chips">
    <button class="chip ${state.filter.size ? '' : 'on'}" data-chip="all">すべて</button>
    ${state.categories.map((c) => `<button class="chip ${state.filter.has(c.id) ? 'on' : ''}" style="--c:${esc(c.color)}" data-chip="${c.id}"><span class="dot"></span>${esc(c.icon)} ${esc(c.name)}</button>`).join('')}
    <button class="chip add" data-addcat>＋ カテゴリ</button>
  </div>`;
}
function bindChips(view) {
  $('[data-addcat]', view)?.addEventListener('click', () => openCategoryEdit());
  $$('[data-chip]', view).forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.chip;
    if (v === 'all') state.filter.clear();
    else { const id = Number(v); state.filter.has(id) ? state.filter.delete(id) : state.filter.add(id); }
    renderTab();
  }));
}
// 今日からの日数（「当日」「明日」「3日後」「2日前」）
function daysFromToday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
}
function relDay(dateStr) {
  const n = daysFromToday(dateStr);
  return n === 0 ? '当日' : n === 1 ? '明日' : n > 1 ? `${n}日後` : n === -1 ? '昨日' : `${-n}日前`;
}
const relClass = (dateStr) => { const n = daysFromToday(dateStr); return n === 0 ? 'today' : n > 0 && n <= 3 ? 'soon' : n < 0 ? 'past' : ''; };

function eventItem(e, showDate = false) {
  const sub = [e.time, e.place_name, e.title && e.place_name ? e.title : '', e.medicine_count ? `💊${e.medicine_count}` : '', e.photo_count ? `📷${e.photo_count}` : '']
    .filter(Boolean).join(' · ');
  return `<button class="item ${e.done ? 'done' : ''}" data-event="${e.id}" style="--c:${esc(e.color)}">
    <span class="bar"></span>
    <span class="body"><div class="t">${esc(e.icon)} ${esc(e.title || e.place_name || e.category_name)}</div>
    <div class="s">${esc(sub || e.category_name)}</div></span>
    ${showDate ? `<span class="when">${fmtDate(e.date)} <span class="rel ${relClass(e.date)}">${relDay(e.date)}</span></span>` : ''}
  </button>`;
}
function bindEventItems(view) {
  $$('[data-event]', view).forEach((b) => b.addEventListener('click', () => openEventView(Number(b.dataset.event))));
}

// ---------------- 予定一覧 ----------------
async function renderList(view) {
  const q = state.listQuery;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (!q) {
    if (state.listPast) { params.set('to', todayStr()); params.set('order', 'desc'); params.set('limit', '300'); }
    else params.set('from', todayStr());
  } else params.set('order', 'desc');
  const events = (await api(`/api/events?${params}`)).filter((e) => !state.filter.size || state.filter.has(e.category_id));
  let html = '';
  let lastMonth = '';
  for (const e of events) {
    const mo = e.date.slice(0, 7);
    if (mo !== lastMonth) {
      if (lastMonth) html += '</div>';
      html += `<div class="month-label">${Number(mo.slice(0, 4))}年${Number(mo.slice(5))}月</div><div class="card">`;
      lastMonth = mo;
    }
    html += eventItem(e, true);
  }
  if (lastMonth) html += '</div>';
  view.innerHTML = `
    <h1 style="margin-bottom:10px">予定一覧</h1>
    <input class="search" type="search" placeholder="検索（病院名・薬名・メモ）" value="${esc(q)}">
    ${q ? '' : `<div class="seg"><button data-past="0" class="${state.listPast ? '' : 'on'}">これから</button><button data-past="1" class="${state.listPast ? 'on' : ''}">過去の記録</button></div>`}
    ${categoryChips()}
    ${html || '<div class="card"><div class="empty">該当する予定はありません</div></div>'}
    <button class="fab" data-add aria-label="予定を追加">＋</button>`;
  const input = $('.search', view);
  input.addEventListener('input', () => {
    clearTimeout(renderList.t);
    renderList.t = setTimeout(() => { state.listQuery = input.value.trim(); renderTab().then(() => { const i = $('.search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300);
  });
  $$('[data-past]', view).forEach((b) => b.addEventListener('click', () => { state.listPast = b.dataset.past === '1'; renderTab(); }));
  $('[data-add]', view).addEventListener('click', () => openEventEdit(null, todayStr()));
  bindChips(view);
  bindEventItems(view);
}

// ---------------- 予定の詳細 ----------------
function openEventView(id) {
  openSheet(async (sheet) => {
    const e = await api(`/api/events/${id}`);
    const p = e.place;
    sheet.innerHTML = `${sheetHead(fmtLongDate(e.date), '<button class="btn" data-edit>編集</button>')}
      <div style="--c:${esc(e.color)}"><span class="badge">${esc(e.icon)} ${esc(e.category_name)}</span> ${e.done ? '<span class="badge" style="--c:#78716c">済</span>' : ''}
        ${e.shared && getMeta('family') ? '<span class="badge" style="--c:#7c3aed">👪 家族と共有中</span>' : ''}</div>
      <h1 style="margin:8px 0 0;font-size:20px">${esc(e.title || e.place_name || e.category_name)}</h1>
      <dl class="detail">
        ${e.time ? `<dt>時刻</dt><dd class="pre">${esc(e.time)}</dd>` : ''}
        ${p ? `<dt>病院・お店</dt><dd><a href="#" data-place="${p.id}">${esc(p.name)}</a>
          ${p.url ? `<br><a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">${esc(p.url)}</a>` : ''}
          ${p.phone ? `<br>📞 <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ''}
          ${p.address ? `<br>📍 <a href="https://maps.google.com/?q=${encodeURIComponent(p.address)}" target="_blank" rel="noopener">${esc(p.address)}</a>` : ''}</dd>
          ${routeSection(p, e.time)}` : ''}
        ${e.memo ? `<dt>📝 この予定のメモ</dt><dd class="pre">${esc(e.memo)}</dd>` : ''}
        ${p?.memo ? `<dt>🏷️ ${esc(p.name)} のメモ（共通）</dt><dd class="pre">${esc(p.memo)}</dd>` : ''}
        ${e.medicines.length ? `<dt>薬</dt><dd><div class="box">${e.medicines.map((m) => `
          <div class="med-row" data-med="${m.id}" style="cursor:pointer">
            ${m.thumb ? `<img class="thumb" src="${photoUrl(m.thumb)}" alt="">` : '<span class="thumb" style="display:flex;align-items:center;justify-content:center">💊</span>'}
            <div class="body"><b>${esc(m.name)}</b>${m.note ? ` <span class="muted small">${esc(m.note)}</span>` : ''}
              ${m.efficacy ? `<div class="small muted">効能: ${esc(m.efficacy)}</div>` : ''}</div></div>`).join('')}</div></dd>` : ''}
        ${e.photos.length ? `<dt>写真</dt><dd>${photoGrid(e.photos)}</dd>` : ''}
      </dl>
      <div class="actions">
        <button class="btn" data-toggle>${e.done ? '未完了に戻す' : '✓ 完了にする'}</button>
        <button class="btn" data-next>次回の予定を作成</button>
      </div>
      ${e.date >= todayStr() ? `<div class="box" style="margin-top:12px">
        <button class="btn primary block" data-tocal>🔔 iPhone のカレンダーに追加（${esc(alarmLabel())}に通知）</button>
        <div class="small muted" style="margin-top:6px">${isExported(e) ? '✅ 追加済みです（内容を変えたときは、もう一度追加してください）。' : ''}
          通知はカレンダーが出すので、このアプリを閉じていても届きます。通知のタイミングは「設定」で変えられます。
          <a href="#" data-tocalshare>うまく追加できないとき</a></div>
      </div>` : ''}`;
    bindHead(sheet);
    $('[data-tocal]', sheet)?.addEventListener('click', async () => {
      openIcs(buildIcs([e], alarmOpts()), `care-${e.date}.ics`);
      await markExported([e]);
    });
    $('[data-tocalshare]', sheet)?.addEventListener('click', async (ev) => {
      ev.preventDefault();
      try {
        await shareIcs(new File([buildIcs([e], alarmOpts())], `care-${e.date}.ics`, { type: 'text/calendar' }));
        await markExported([e]);
      } catch (err) { if (err.name !== 'AbortError') alert(err.message); }
    });
    $('[data-edit]', sheet).addEventListener('click', () => openEventEdit(e));
    $('[data-place]', sheet)?.addEventListener('click', (ev) => { ev.preventDefault(); openPlaceView(p.id); });
    $$('[data-med]', sheet).forEach((r) => r.addEventListener('click', () => openMedicineView(Number(r.dataset.med))));
    $('[data-toggle]', sheet).addEventListener('click', async () => {
      await api(`/api/events/${e.id}`, { method: 'PUT', body: { ...e, done: !e.done, medicines: undefined } });
      await renderTab();
      showSheet();
    });
    $('[data-next]', sheet).addEventListener('click', () => {
      openEventEdit({ category_id: e.category_id, place_id: e.place_id, title: e.title, date: '', time: e.time, memo: '', medicines: [], photos: [], shared: e.shared }, null, true);
    });
  });
}

// ---------------- 予定の登録・編集 ----------------
function openEventEdit(ev, date, isCopy = false) {
  const isNew = !ev || isCopy;
  const data = ev ? { ...ev } : { category_id: [...state.filter][0] || state.categories[0]?.id, place_id: null, date, time: '', title: '', memo: '', done: 0, medicines: [], photos: [] };
  if (!data.date) data.date = date || todayStr();
  let meds = (data.medicines || []).map((m) => ({ medicine_id: m.id, name: m.name, note: m.note || '' }));
  const photoState = {};
  const placeMemos = {};

  openSheet(async (sheet) => {
    sheet.innerHTML = `${sheetHead(isNew ? '予定を追加' : '予定を編集')}
      <form>
        <div class="field"><label>カテゴリ</label><div class="chips" data-cats style="flex-wrap:wrap">
          ${state.categories.map((c) => `<button type="button" class="chip" style="--c:${esc(c.color)}" data-cat="${c.id}"><span class="dot"></span>${esc(c.icon)} ${esc(c.name)}</button>`).join('')}
          <button type="button" class="chip add" data-newcat>＋ 追加</button>
        </div></div>
        <div class="field"><label>病院・お店</label>
          <div class="row"><select name="place_id"></select><button type="button" class="btn" data-newplace style="flex:none">＋新規</button></div>
        </div>
        <div class="row">
          <div class="field"><label>日付</label><input type="date" name="date" required value="${esc(data.date)}"></div>
          <div class="field"><label>時刻</label><input type="time" name="time" value="${esc(data.time)}"></div>
        </div>
        <div class="field"><label>内容（例: カット＋カラー、定期診察）</label><input name="title" value="${esc(data.title)}" autocomplete="off"></div>
        <div class="field"><label>📝 この予定のメモ（今回だけ）</label><textarea name="memo" placeholder="今回の症状、してもらったこと、費用、次回の目安など">${esc(data.memo)}</textarea></div>
        <div class="field" data-placememo-wrap hidden><label>🏷️ <span data-placememo-name></span> のメモ（毎回共通）</label>
          <textarea name="place_memo" placeholder="担当の先生・スタイリスト、診療時間、持ち物など"></textarea></div>
        <div class="field"><label>薬</label><div class="box" data-meds></div></div>
        <div class="field"><label>写真</label><div data-photos></div></div>
        <label class="check"><input type="checkbox" name="done" ${data.done ? 'checked' : ''}> 完了（通院・来店済み）</label>
        ${getMeta('family') ? `<label class="check"><input type="checkbox" name="shared" ${data.shared ? 'checked' : ''}> 👪 家族と共有する（日付・時間・内容だけ）</label>` : ''}
        <div class="actions">
          ${!isNew ? '<button type="button" class="btn danger" data-delete style="flex:0 0 auto">削除</button>' : ''}
          <button class="btn primary">保存</button>
        </div>
      </form>`;
    bindHead(sheet);
    const form = $('form', sheet);
    let catId = Number(data.category_id);

    const renderCats = () => $$('[data-cat]', sheet).forEach((b) => b.classList.toggle('on', Number(b.dataset.cat) === catId));
    const renderPlaces = () => {
      const list = state.places.filter((p) => p.category_id === catId);
      form.place_id.innerHTML = `<option value="">（未選択）</option>${list.map((p) => `<option value="${p.id}" ${p.id === Number(data.place_id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
      renderPlaceMemo();
    };
    // 選んだ病院・お店の共通メモ（入力途中の内容は placeMemos に保持）
    let shownPlace = null;
    function keepPlaceMemo() {
      if (shownPlace) placeMemos[shownPlace] = form.place_memo.value;
    }
    function renderPlaceMemo() {
      keepPlaceMemo();
      const p = state.places.find((x) => x.id === Number(form.place_id.value));
      shownPlace = p ? p.id : null;
      $('[data-placememo-wrap]', sheet).hidden = !p;
      if (p) {
        $('[data-placememo-name]', sheet).textContent = p.name;
        form.place_memo.value = placeMemos[p.id] ?? p.memo ?? '';
      }
    }
    form.place_id.addEventListener('change', renderPlaceMemo);
    const renderMeds = () => {
      const box = $('[data-meds]', sheet);
      const opts = state.medicines.filter((m) => !meds.some((x) => x.medicine_id === m.id));
      box.innerHTML = `${meds.map((m, i) => `<div class="med-row"><div class="body"><b>💊 ${esc(m.name)}</b>
          <input placeholder="飲み方・日数など（例: 朝晩 14日分）" value="${esc(m.note)}" data-mnote="${i}" style="width:100%;margin-top:4px;border:1px solid var(--line);border-radius:8px;background:var(--bg)"></div>
          <button type="button" class="icon-btn" data-mdel="${i}" aria-label="外す">✕</button></div>`).join('')}
        <div class="row" style="margin-top:6px">
          <select data-madd><option value="">登録済みの薬を追加…</option>${opts.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
          <button type="button" class="btn" data-mnew style="flex:none">＋新しい薬</button>
        </div>`;
      $$('[data-mnote]', box).forEach((inp) => inp.addEventListener('input', () => (meds[Number(inp.dataset.mnote)].note = inp.value)));
      $$('[data-mdel]', box).forEach((b) => b.addEventListener('click', () => { meds.splice(Number(b.dataset.mdel), 1); renderMeds(); }));
      $('[data-madd]', box).addEventListener('change', (e) => {
        const m = state.medicines.find((x) => x.id === Number(e.target.value));
        if (m) { meds.push({ medicine_id: m.id, name: m.name, note: '' }); renderMeds(); }
      });
      $('[data-mnew]', box).addEventListener('click', () => {
        saveDraft();
        openMedicineEdit({ category_id: catId, place_id: Number(form.place_id.value) || null }, (newId, name) => {
          meds.push({ medicine_id: newId, name, note: '' });
        });
      });
    };
    // 別シートへ移る前に入力内容を保持
    const saveDraft = () => {
      keepPlaceMemo();
      Object.assign(data, { category_id: catId, place_id: Number(form.place_id.value) || null, date: form.date.value, time: form.time.value,
        title: form.title.value, memo: form.memo.value, done: form.done.checked,
        shared: form.shared ? form.shared.checked : !!data.shared });
    };

    renderCats(); renderPlaces(); renderMeds();
    const photos = photoEditor($('[data-photos]', sheet), isCopy ? [] : data.photos || [], photoState);

    $$('[data-cat]', sheet).forEach((b) => b.addEventListener('click', () => {
      catId = Number(b.dataset.cat); data.place_id = null; renderCats(); renderPlaces();
    }));
    $('[data-newplace]', sheet).addEventListener('click', () => {
      saveDraft();
      openPlaceEdit({ category_id: catId }, (newId) => { data.place_id = newId; });
    });
    $('[data-newcat]', sheet).addEventListener('click', () => {
      saveDraft();
      openCategoryEdit({}, (newId) => { data.category_id = newId; data.place_id = null; });
    });
    $('[data-delete]', sheet)?.addEventListener('click', async () => {
      if (!confirm('この予定を削除しますか？（写真も削除されます）')) return;
      await api(`/api/events/${data.id}`, { method: 'DELETE' });
      closeAllSheets(); toast('削除しました'); renderTab();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      saveDraft();
      const btn = $('.btn.primary', form);
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        const body = { ...data, medicines: meds };
        let id = data.id;
        if (isNew) id = (await api('/api/events', { method: 'POST', body })).id;
        else await api(`/api/events/${id}`, { method: 'PUT', body });
        await photos.commit('event', id);
        // 病院・お店の共通メモが変わっていれば保存
        for (const [pid, memo] of Object.entries(placeMemos)) {
          const p = state.places.find((x) => x.id === Number(pid));
          if (p && (p.memo || '') !== memo) await api(`/api/places/${p.id}`, { method: 'PUT', body: { ...p, memo } });
        }
        state.selected = data.date;
        const [y, m] = data.date.split('-').map(Number);
        state.month = new Date(y, m - 1, 1);
        closeAllSheets();
        toast('保存しました');
        await refresh();
        openEventView(id);
      } catch (err) {
        alert(err.message);
        btn.disabled = false; btn.textContent = '保存';
      }
    });
  });
}

// ---------------- 病院・お店 ----------------
function openPlaceView(id) {
  openSheet(async (sheet) => {
    const p = await api(`/api/places/${id}`);
    const c = catById(p.category_id);
    sheet.innerHTML = `${sheetHead(p.name, '<button class="btn" data-edit>編集</button>')}
      ${c ? `<span class="badge" style="--c:${esc(c.color)}">${esc(c.icon)} ${esc(c.name)}</span>` : ''}
      <dl class="detail">
        ${p.url ? `<dt>URL</dt><dd><a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">${esc(p.url)}</a></dd>` : ''}
        ${p.address ? `<dt>住所</dt><dd><a href="https://maps.google.com/?q=${encodeURIComponent(p.address)}" target="_blank" rel="noopener">${esc(p.address)}</a></dd>` : ''}
        ${routeSection(p)}
        ${p.memo ? `<dt>🏷️ メモ（毎回共通）</dt><dd class="pre">${esc(p.memo)}</dd>` : ''}
        ${p.photos.length ? `<dt>写真</dt><dd>${photoGrid(p.photos)}</dd>` : ''}
        ${p.medicines.length ? `<dt>この病院の薬</dt><dd>${p.medicines.map((m) => `<a href="#" data-med="${m.id}">💊 ${esc(m.name)}</a>`).join('<br>')}</dd>` : ''}
        <dt>履歴</dt><dd>${p.events.length ? p.events.map((e) => `<a href="#" data-ev="${e.id}">${esc(e.date.replaceAll('-', '/'))}</a> ${esc(e.title)}${e.done ? '' : ' <span class="muted small">(予定)</span>'}`).join('<br>') : '<span class="muted">なし</span>'}</dd>
      </dl>`;
    bindHead(sheet);
    $('[data-edit]', sheet).addEventListener('click', () => openPlaceEdit(p));
    $$('[data-med]', sheet).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openMedicineView(Number(a.dataset.med)); }));
    $$('[data-ev]', sheet).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openEventView(Number(a.dataset.ev)); }));
  });
}
function openPlaceEdit(p, onCreated) {
  const isNew = !p.id;
  const photoState = {};
  openSheet(async (sheet) => {
    sheet.innerHTML = `${sheetHead(isNew ? '病院・お店を追加' : '病院・お店を編集')}
      <form>
        <div class="field"><label>カテゴリ</label><select name="category_id">${state.categories.map((c) => `<option value="${c.id}" ${c.id === Number(p.category_id) ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>名前</label>
          <div class="row"><input name="name" required value="${esc(p.name)}" placeholder="例: ○○皮膚科クリニック"><button type="button" class="btn" data-lookup style="flex:none">🔍 検索</button></div>
          <div class="small muted" style="margin-top:4px">名前を入れて「検索」を押すと、Google から住所・URL・電話番号を入れられます</div></div>
        <div class="field"><label>URL（予約ページなど）</label><input name="url" type="url" inputmode="url" value="${esc(p.url)}" placeholder="https://"></div>
        <div class="field"><label>電話番号</label><input name="phone" type="tel" value="${esc(p.phone)}"></div>
        <div class="field"><label>住所</label><input name="address" value="${esc(p.address)}"></div>
        <div class="field"><label>メモ</label><textarea name="memo" placeholder="診療時間、休診日、担当の先生・スタイリストなど">${esc(p.memo)}</textarea></div>
        <div class="field"><label>写真（診察券・外観など）</label><div data-photos></div></div>
        <div class="actions">
          ${!isNew ? '<button type="button" class="btn danger" data-delete style="flex:0 0 auto">削除</button>' : ''}
          <button class="btn primary">保存</button>
        </div>
      </form>`;
    bindHead(sheet);
    const form = $('form', sheet);
    const photos = photoEditor($('[data-photos]', sheet), p.photos || [], photoState);
    $('[data-lookup]', sheet).addEventListener('click', () => {
      // 入力中の内容を保持してから検索画面へ
      Object.assign(p, Object.fromEntries(new FormData(form)));
      if (!p.name.trim()) { alert('先に名前を入力してください'); return; }
      openPlaceLookup(p.name.trim(), (hit) => {
        Object.assign(p, {
          address: hit.address || p.address,
          url: hit.url || p.url,
          phone: hit.phone || p.phone,
        });
      });
    });
    $('[data-delete]', sheet)?.addEventListener('click', async () => {
      if (!confirm(`「${p.name}」を削除しますか？（予定は残り、病院の紐付けだけ外れます）`)) return;
      await api(`/api/places/${p.id}`, { method: 'DELETE' });
      await loadMasters();
      sheetStack.length = 0; closeAllSheets(); toast('削除しました'); renderTab();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      try {
        let id = p.id;
        if (isNew) id = (await api('/api/places', { method: 'POST', body })).id;
        else await api(`/api/places/${id}`, { method: 'PUT', body });
        await photos.commit('place', id);
        await loadMasters();
        onCreated?.(id);
        toast('保存しました');
        backSheet();
        if (state.tab === 'master') renderTab();
      } catch (err) { alert(err.message); }
    });
  });
}

// ---------------- 通知（iPhone のカレンダーに追加） ----------------
const alarmMinutes = () => getMeta('alarm_min') ?? 60;
const alarmLabel = () => ALARM_OPTIONS.find((o) => o.value === alarmMinutes())?.label || '1時間前';
const alarmOpts = () => ({ alarm: alarmMinutes(), dayBefore: !!getMeta('alarm_day_before') });
// 日時が変わったら「未追加」に戻るよう、日時込みで覚えておく
const exportKey = (e) => `${e.id}:${e.date}:${e.time}`;
const isExported = (e) => (getMeta('cal_exported') || []).includes(exportKey(e));
async function markExported(events) {
  const keys = new Set(getMeta('cal_exported') || []);
  for (const e of events) keys.add(exportKey(e));
  await setMeta('cal_exported', [...keys].slice(-2000));
}
async function upcomingNotExported() {
  const list = (await api(`/api/events?from=${todayStr()}`)).filter((e) => !e.done && !isExported(e));
  return Promise.all(list.map((e) => api(`/api/events/${e.id}`)));
}
// 今日・明日の予定をカレンダーの上に出す
async function soonBanner() {
  const t = new Date(); t.setDate(t.getDate() + 1);
  const list = (await api(`/api/events?from=${todayStr()}&to=${ymd(t)}`)).filter((e) => !e.done);
  if (!list.length) return '';
  return `<div class="box" style="margin-bottom:12px;border-color:var(--accent)">
    <b>⏰ 今日・明日の予定</b>
    ${list.map((e) => `<div class="small" style="margin-top:4px">${e.date === todayStr() ? '今日' : '明日'} ${esc(e.time || '')}　${esc(e.icon)} ${esc(e.title || e.place_name || e.category_name)}</div>`).join('')}
  </div>`;
}

// ---------------- 通知（このアプリから・Web Push） ----------------
const pushDevice = () => getMeta('push_device');
// これからの予定から「いつ・何を通知するか」を作る（詳細は送らない）
async function buildPushJobs() {
  const now = Date.now();
  const limit = new Date(); limit.setDate(limit.getDate() + 90);
  const events = (await storeApi(`/api/events?from=${todayStr()}&to=${ymd(limit)}`)).filter((e) => !e.done);
  const { alarm, dayBefore } = alarmOpts();
  const hidden = !!getMeta('push_private');
  const jobs = [];
  for (const e of events) {
    const [y, m, d] = e.date.split('-').map(Number);
    const [h, mi] = e.time ? e.time.split(':').map(Number) : [0, 0];
    const start = new Date(y, m - 1, d, h, mi).getTime();
    const name = `${e.icon || ''}${e.title || e.place_name || e.category_name}`;
    const when = e.time || '時刻なし';
    const add = (at, label) => {
      if (at <= now) return;
      jobs.push(hidden
        ? { at, title: 'OurTime', body: `予定の${label}です` }
        : { at, title: name, body: `${fmtDate(e.date)} ${when}${e.place_name && e.place_name !== e.title ? ` ${e.place_name}` : ''}（${label}）` });
    };
    // 時刻のない予定は前日 9:00（カレンダー追加のときと同じ）
    if (alarm >= 0) add(e.time ? start - alarm * 60000 : start - 15 * 3600000, e.time ? alarmLabel() : '前日');
    if (dayBefore && alarm !== 1440) add(e.time ? start - 86400000 : start - 39 * 3600000, '前日');
  }
  // ごみを出す前夜の通知
  if (getMeta('gomi_notify')) {
    const [gh, gm] = (getMeta('gomi_time') || '20:00').split(':').map(Number);
    for (let i = 0; i < 90; i++) {
      const day = addDays(todayStr(), i);
      const types = gomiOut(day);
      if (!types.length) continue;
      const [y, mo, d] = day.split('-').map(Number);
      const at = new Date(y, mo - 1, d, gh, gm).getTime();
      if (at > now) jobs.push({ at, title: '🗑️ ごみを出す日', body: `${types.join('・')}（明日 ${fmtDate(addDays(day, 1))} の朝に収集）` });
    }
  }
  return jobs.sort((a, b) => a.at - b.at);
}
let pushTimer = null;
function schedulePushSync() {
  if (!pushDevice() || !approved()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncPush, 1500);
}
async function syncPush() {
  const device = pushDevice();
  if (!device) return;
  try {
    const r = await sendJobs(device, await buildPushJobs());
    await setMeta('push_synced', { at: new Date().toISOString(), count: r.count });
  } catch (err) {
    await setMeta('push_synced', { at: new Date().toISOString(), error: err.message });
  }
}

// ---------------- 端末登録（承認） ----------------
// 以前から通知を使っている端末は、最初の持ち主として自動で登録する
async function autoClaimOwner() {
  if (approved() || !pushDevice()) return;
  try {
    const { client } = await claimOwner(pushDevice(), '持ち主の iPhone');
    await setMeta('server_client', client);
  } catch { /* すでに持ち主がいる場合などは、登録コードで登録してもらう */ }
}
function deviceSettingsHtml() {
  const inputStyle = 'padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:var(--card)';
  if (!approved()) {
    return `<p class="small muted" style="margin-top:0">通知と家族共有は、登録した iPhone だけが使えます（知らない人に使われないようにするため）。
        すでに登録済みの iPhone の「設定」→「端末登録」で<b>登録コード</b>を発行し、ここに入力してください。</p>
      <div class="field"><label>この iPhone の名前</label><input data-devname maxlength="20" placeholder="例: はなこの iPhone" style="width:100%;${inputStyle}"></div>
      <div class="row"><input data-paircode placeholder="登録コード（XXXX-XXXX）" autocapitalize="characters" autocomplete="off" style="${inputStyle}">
        <button class="btn primary" data-redeem style="flex:none">登録</button></div>
      ${pushDevice() ? '<button class="btn block" data-claim style="margin-top:8px">この iPhone を持ち主として登録する</button>' : ''}`;
  }
  return `<p class="small" style="margin-top:0">✅ この iPhone は登録済みです。</p>
    <div data-pairbox></div>
    <button class="btn block" data-newpair>ほかの iPhone を追加する（登録コードを発行）</button>
    <details style="margin-top:8px" data-clients><summary class="small" style="cursor:pointer;color:var(--accent)">登録済みの iPhone</summary><div data-clientlist class="small">読み込み中…</div></details>`;
}
function bindDeviceSettings(view) {
  $('[data-redeem]', view)?.addEventListener('click', async () => {
    const name = $('[data-devname]', view).value.trim() || 'iPhone';
    const code = $('[data-paircode]', view).value.trim();
    if (!code) { alert('登録コードを入力してください'); return; }
    try {
      const { client } = await redeemPairCode(code, name);
      await setMeta('server_client', client);
      toast('この iPhone を登録しました');
    } catch (err) { alert(err.message); }
    renderTab();
  });
  $('[data-claim]', view)?.addEventListener('click', async () => {
    try {
      const { client } = await claimOwner(pushDevice(), '持ち主の iPhone');
      await setMeta('server_client', client);
      toast('持ち主として登録しました');
    } catch (err) { alert(err.message); }
    renderTab();
  });
  $('[data-newpair]', view)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { code, expires } = await issuePairCode();
      $('[data-pairbox]', view).innerHTML = `<div class="box" style="margin-bottom:8px;text-align:center">
        <div class="small muted">追加する iPhone の「設定」→「端末登録」で入力してください</div>
        <div style="font-size:26px;font-weight:700;letter-spacing:3px;font-family:monospace;margin:4px 0">${esc(code)}</div>
        <div class="small muted">${new Date(expires).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} まで有効・1回だけ使えます</div></div>`;
    } catch (err) { alert(err.message); }
    e.target.disabled = false;
  });
  $('[data-clients]', view)?.addEventListener('toggle', async (e) => {
    if (!e.target.open) return;
    const box = $('[data-clientlist]', view);
    try {
      const { clients } = await listClients();
      box.innerHTML = clients.map((c) => `<div class="row" style="align-items:center;padding:4px 0">
        <span>📱 ${esc(c.name)}${c.me ? '（この iPhone）' : ''}<br><span class="muted">${new Date(c.added).toLocaleDateString('ja-JP')} に登録</span></span>
        ${c.me ? '' : `<button class="btn danger" data-rmclient="${esc(c.id)}" style="flex:none">解除</button>`}</div>`).join('');
      $$('[data-rmclient]', box).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('この iPhone の登録を解除しますか？（通知と家族共有が使えなくなります）')) return;
        await removeClient(b.dataset.rmclient);
        e.target.open = false; e.target.open = true;
      }));
    } catch (err) { box.textContent = err.message; }
  });
}

const fmtCode = (c) => normalizeCode(c).match(/.{1,4}/g)?.join('-') || '';
function familySettingsHtml() {
  const fam = family();
  const inputStyle = 'padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:var(--card)';
  if (!fam && !approved()) return '<p class="small muted" style="margin:0">先に上の「📱 端末登録」でこの iPhone を登録してください。</p>';
  if (!fam) {
    return `<p class="small muted" style="margin-top:0">「家族と共有」にした予定の <b>日付・時間・内容</b> だけを家族に見せられます（家族は見るだけ）。カテゴリ・病院名・薬・写真・メモは共有しません。予定は暗号化して送るので、サーバーの管理者にも中身は読めません。</p>
      <div class="field"><label>あなたの表示名（家族に見える名前）</label><input data-famname maxlength="10" placeholder="例: たつや" style="width:100%;${inputStyle}"></div>
      <button class="btn primary block" data-famcreate>家族グループを作る</button>
      <p class="small muted" style="margin:10px 0 4px">家族から招待コードをもらった場合</p>
      <div class="row"><input data-famcode placeholder="XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" autocomplete="off" style="${inputStyle}">
        <button class="btn" data-famjoin style="flex:none">参加</button></div>`;
  }
  const cache = getMeta('family_cache');
  const err = getMeta('family_error');
  const members = cache?.members || [];
  return `<p class="small" style="margin-top:0">あなたの表示名: <b>${esc(fam.name)}</b>　色:
      ${MEMBER_COLORS.map((c) => `<button class="color-opt ${c === fam.color ? 'on' : ''}" data-famcolor="${c}" style="--c:${c};width:26px;height:26px;vertical-align:middle" aria-label="色"></button>`).join(' ')}</p>
    <div class="field"><label>招待コード（家族に伝えてください）</label>
      <div class="row"><input readonly value="${esc(fmtCode(fam.code))}" style="${inputStyle};font-family:monospace;letter-spacing:1px">
        <button class="btn" data-famshare style="flex:none">送る</button></div></div>
    <p class="small" style="margin:6px 0">家族: ${members.length ? members.map((m) => `<span class="badge" style="--c:${esc(m.color || '#7c3aed')}">👤 ${esc(m.name)}</span>`).join(' ') : '<span class="muted">まだ誰も参加していません</span>'}</p>
    <p class="small muted" style="margin:0 0 8px">${cache ? `最終同期: ${new Date(cache.at).toLocaleString('ja-JP')}` : ''}${err ? `<br><span style="color:var(--danger)">⚠️ ${esc(err)}</span>` : ''}<br>
      共有する予定は、予定の編集画面で「👪 家族と共有する」にチェックを入れてください。</p>
    <div class="row"><button class="btn" data-famsync>今すぐ同期</button><button class="btn danger" data-famleave style="flex:none">グループから抜ける</button></div>`;
}
function bindFamilySettings(view) {
  const start = async (create) => {
    const name = ($('[data-famname]', view)?.value || '').trim();
    const code = create ? newInviteCode() : ($('[data-famcode]', view)?.value || '').trim();
    if (!name) { alert('先に「あなたの表示名」を入力してください'); return; }
    if (!create && normalizeCode(code).length !== 16) { alert('招待コードは16文字です（ハイフンはあってもなくても大丈夫です）'); return; }
    try {
      const fam = await joinFamily(code, create);
      await setMeta('family', { ...fam, name, color: create ? MEMBER_COLORS[0] : MEMBER_COLORS[1] });
      lastPull = 0;
      await syncFamily();
      toast(create ? '家族グループを作りました' : '家族グループに参加しました');
    } catch (err) { alert(err.message); }
    renderTab();
  };
  $('[data-famcreate]', view)?.addEventListener('click', () => start(true));
  $('[data-famjoin]', view)?.addEventListener('click', () => start(false));
  $('[data-famshare]', view)?.addEventListener('click', async () => {
    const text = `OurTimeの家族グループの招待コード: ${fmtCode(family().code)}\nアプリ: https://0009komu.github.io/care-notes/\n（アプリの「設定」→「家族と共有」で入力してください）`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast('コピーしました'); }
    } catch (err) { if (err.name !== 'AbortError') alert(err.message); }
  });
  $$('[data-famcolor]', view).forEach((b) => b.addEventListener('click', async () => {
    await setMeta('family', { ...family(), color: b.dataset.famcolor });
    await syncFamily(true);
    renderTab();
  }));
  $('[data-famsync]', view)?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '同期中…';
    lastPull = Date.now();
    await syncFamily();
    renderTab();
  });
  $('[data-famleave]', view)?.addEventListener('click', async () => {
    if (!confirm('家族グループから抜けますか？（あなたの共有予定は家族から見えなくなります）')) return;
    try { await leaveFamily(family()); } catch { /* サーバー側で消えていても抜けられるようにする */ }
    await setMeta('family', null);
    await setMeta('family_cache', null);
    renderTab();
  });
}

function pushSettingsHtml() {
  const on = !!pushDevice();
  const synced = getMeta('push_synced');
  if (!pushSupported() || !isStandalone) {
    return `<p class="small muted" style="margin:0">ホーム画面の「OurTime」アイコンから開くと使えます（iOS 16.4 以降）。</p>`;
  }
  if (!approved()) return '<p class="small muted" style="margin:0">先に上の「📱 端末登録」でこの iPhone を登録してください。</p>';
  return `<p class="small" style="margin:0 0 6px">状態: ${on ? '✅ オン' : 'オフ'}${on && synced ? `<span class="muted">（${synced.error ? `⚠️ ${esc(synced.error)}` : `${synced.count}件を予約済み`}）</span>` : ''}</p>
    ${on ? `<label class="check"><input type="checkbox" data-pushprivate ${getMeta('push_private') ? 'checked' : ''}> 通知に予定名を出さない（「予定の1時間前です」だけにする）</label>
      <div class="row"><button class="btn" data-pushtest>テスト通知</button><button class="btn danger" data-pushoff style="flex:none">オフにする</button></div>`
    : '<button class="btn primary block" data-pushon>通知をオンにする</button>'}`;
}
function bindPushSettings(view) {
  $('[data-pushon]', view)?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '設定中…';
    try {
      await setMeta('push_device', await enablePush());
      await syncPush();
      toast('通知をオンにしました');
    } catch (err) { alert(err.message); }
    renderTab();
  });
  $('[data-pushtest]', view)?.addEventListener('click', async () => {
    try { await testPush(pushDevice()); toast('テスト通知を送りました'); } catch (err) { alert(err.message); }
  });
  $('[data-pushoff]', view)?.addEventListener('click', async () => {
    if (!confirm('このアプリからの通知をオフにしますか？')) return;
    await disablePush(pushDevice());
    await setMeta('push_device', null);
    await setMeta('push_synced', null);
    renderTab();
  });
  $('[data-pushprivate]', view)?.addEventListener('change', async (e) => {
    await setMeta('push_private', e.target.checked);
    await syncPush();
    toast('変更しました');
  });
}

// ---------------- 行き方（登録した場所から電車で） ----------------
const ORIGIN_ICONS = ['🏠', '🏢', '👪', '🏡', '🏫', '🏥', '🚉', '🛒', '🏋️', '📍'];
// 出発地の一覧 [{ id, icon, label, address }]。以前の「自宅・会社」だけの保存形式からも読み込む
function origins() {
  const list = getMeta('origins');
  if (Array.isArray(list)) return list;
  return [
    { id: 'home', icon: '🏠', label: '自宅', address: getMeta('origin_home') || '' },
    { id: 'work', icon: '🏢', label: '会社', address: getMeta('origin_work') || '' },
  ];
}
// iPhone の「マップ」で乗り換え（dirflg=r は電車・バス）
function routeUrl(origin, dest) {
  const q = new URLSearchParams({ saddr: origin, daddr: dest, dirflg: 'r' });
  return `https://maps.apple.com/?${q}`;
}
// 病院・お店の詳細と予定の詳細に出す「行き方」
function routeSection(p, arriveTime = '') {
  const dest = p.address || p.name;
  if (!dest) return '';
  const saved = origins().filter((o) => o.address);
  const buttons = saved.map((o) => `<a class="btn" href="${esc(routeUrl(o.address, dest))}" target="_blank" rel="noopener"
      style="text-decoration:none;color:inherit;display:inline-flex;align-items:center">${esc(o.icon)} ${esc(o.label || '登録した場所')}から</a>`).join(' ');
  return `<dt>行き方（電車）</dt><dd>
    ${saved.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${buttons}</div>
      <div class="small muted" style="margin-top:4px">iPhone の「マップ」で乗り換えを表示します${arriveTime ? `。${esc(arriveTime)} に着きたいときは、マップの経路画面で「今すぐ出発」を押して「到着」の時刻を選んでください` : ''}</div>`
      : '<span class="small muted">「設定」で自宅・会社などの場所を登録すると、ここから乗り換えを調べられます</span>'}
    ${p.address ? '' : '<div class="small muted">※住所が未登録なので、名前で検索します</div>'}</dd>`;
}

// 名前から Google で住所・URL・電話番号を探す
function openPlaceLookup(initialQuery, onPick) {
  let query = initialQuery;
  let results = null;
  let error = '';
  const self = async (sheet) => {
    const key = getMeta('places_key');
    const mapsSearch = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    const render = () => {
      sheet.innerHTML = `${sheetHead('Google で検索')}
        <form data-q class="row" style="margin-bottom:10px">
          <input name="q" value="${esc(query)}" placeholder="名前（地名を足すと絞り込めます）" style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);font-size:16px">
          <button class="btn primary" style="flex:none">検索</button>
        </form>
        ${!key ? `<div class="box small">Google の場所検索を使うには、「設定」で API キーを登録してください。<br>
            いまは下のボタンから Google マップで探して、住所などをコピーできます。</div>`
          : error ? `<div class="box small" style="border-color:var(--danger)">⚠️ ${esc(error)}</div>`
          : !results ? '<div class="empty">検索中…</div>'
          : `<div class="card">${results.map((r, i) => `<button class="item" data-pick="${i}" style="align-items:flex-start">
              <span class="body"><div class="t" style="white-space:normal">${esc(r.name)}</div>
              <div class="small muted" style="white-space:normal">${esc(r.address)}</div>
              <div class="small muted">${[r.phone && `📞 ${esc(r.phone)}`, r.url && '🔗 URLあり'].filter(Boolean).join(' · ')}</div></span></button>`).join('')
              || '<div class="empty">見つかりませんでした。地名を足して検索してみてください。</div>'}</div>`}
        <div class="actions"><a class="btn block" href="${esc(mapsSearch)}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none;color:inherit">Google マップで開く</a></div>`;
      bindHead(sheet);
      $('[data-q]', sheet).addEventListener('submit', (e) => {
        e.preventDefault();
        query = e.target.q.value.trim();
        if (query) run();
      });
      $$('[data-pick]', sheet).forEach((b) => b.addEventListener('click', () => {
        const r = results[Number(b.dataset.pick)];
        onPick(r);
        toast('入力しました');
        backSheet();
      }));
    };
    const run = async () => {
      results = null; error = '';
      render();
      try { results = await searchPlaces(key, query); } catch (err) { error = err.message || String(err); }
      if (sheetStack.at(-1) === self) render(); // 検索中に画面を閉じていたら描かない
    };
    if (key && !results && !error) run(); else render();
  };
  openSheet(self);
}

// ---------------- 薬 ----------------
// 薬の効能などを調べるリンク（KEGG MEDICUS は添付文書・薬効が見られる医薬品データベース）
function drugLinks(name) {
  const q = encodeURIComponent(name.trim());
  const link = (href, label) => `<a class="btn" href="${href}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:inline-flex;align-items:center;min-height:36px;padding:4px 12px;margin:0 6px 6px 0">${label}</a>`;
  return link(`https://www.kegg.jp/medicus-bin/search_drug?search_keyword=${q}`, '💊 添付文書・薬効（KEGG）')
    + link(`https://www.google.com/search?q=${q}+${encodeURIComponent('効能 副作用')}`, '🔍 Google で検索');
}
function openMedicineView(id) {
  openSheet(async (sheet) => {
    const m = await api(`/api/medicines/${id}`);
    sheet.innerHTML = `${sheetHead(m.name, '<button class="btn" data-edit>編集</button>')}
      <dl class="detail">
        ${m.photos.length ? `<dt>写真</dt><dd>${photoGrid(m.photos)}</dd>` : ''}
        ${m.efficacy ? `<dt>効能</dt><dd class="pre">${esc(m.efficacy)}</dd>` : ''}
        <dt>薬の情報を調べる</dt><dd>${drugLinks(m.name)}</dd>
        ${m.usage ? `<dt>使い方・飲み方</dt><dd class="pre">${esc(m.usage)}</dd>` : ''}
        ${m.place_name ? `<dt>処方元</dt><dd><a href="#" data-place="${m.place_id}">${esc(m.place_name)}</a></dd>` : ''}
        ${m.memo ? `<dt>メモ</dt><dd class="pre">${esc(m.memo)}</dd>` : ''}
        <dt>処方の履歴</dt><dd>${m.events.length ? m.events.map((e) => `<a href="#" data-ev="${e.id}">${esc(e.date.replaceAll('-', '/'))}</a> ${esc(e.note || e.title)}`).join('<br>') : '<span class="muted">なし</span>'}</dd>
      </dl>`;
    bindHead(sheet);
    $('[data-edit]', sheet).addEventListener('click', () => openMedicineEdit(m));
    $('[data-place]', sheet)?.addEventListener('click', (e) => { e.preventDefault(); openPlaceView(m.place_id); });
    $$('[data-ev]', sheet).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openEventView(Number(a.dataset.ev)); }));
  });
}
function openMedicineEdit(m, onCreated) {
  const isNew = !m.id;
  openSheet(async (sheet) => {
    sheet.innerHTML = `${sheetHead(isNew ? '薬を追加' : '薬を編集')}
      <form>
        <div class="field"><label>薬の名前</label><input name="name" required value="${esc(m.name)}" placeholder="例: ヒルドイドソフト軟膏">
          <div data-druglinks style="margin-top:6px"></div></div>
        <div class="field"><label>写真</label><div data-photos></div></div>
        <div class="field"><label>効能</label><textarea name="efficacy" style="min-height:60px" placeholder="例: 保湿、乾燥肌の改善">${esc(m.efficacy)}</textarea></div>
        <div class="field"><label>使い方・飲み方</label><input name="usage" value="${esc(m.usage)}" placeholder="例: 1日2回 患部に塗る"></div>
        <div class="row">
          <div class="field"><label>カテゴリ</label><select name="category_id"><option value="">（なし）</option>${state.categories.map((c) => `<option value="${c.id}" ${c.id === Number(m.category_id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label>処方元</label><select name="place_id"><option value="">（なし）</option>${state.places.map((p) => `<option value="${p.id}" ${p.id === Number(m.place_id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>メモ</label><textarea name="memo" placeholder="副作用、ジェネリック名、残量など">${esc(m.memo)}</textarea></div>
        <div class="actions">
          ${!isNew ? '<button type="button" class="btn danger" data-delete style="flex:0 0 auto">削除</button>' : ''}
          <button class="btn primary">保存</button>
        </div>
      </form>`;
    bindHead(sheet);
    const form = $('form', sheet);
    const photos = photoEditor($('[data-photos]', sheet), m.photos || []);
    // 名前を入れると、効能を調べるリンクが出る（調べた内容は「効能」欄に貼り付け）
    const renderDrugLinks = () => {
      const v = form.name.value.trim();
      $('[data-druglinks]', sheet).innerHTML = v ? `<div class="small muted" style="margin-bottom:4px">効能・使い方を調べる</div>${drugLinks(v)}` : '';
    };
    form.name.addEventListener('input', renderDrugLinks);
    renderDrugLinks();
    $('[data-delete]', sheet)?.addEventListener('click', async () => {
      if (!confirm(`「${m.name}」を削除しますか？（予定からも外れます）`)) return;
      await api(`/api/medicines/${m.id}`, { method: 'DELETE' });
      await loadMasters();
      closeAllSheets(); toast('削除しました'); renderTab();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      try {
        let id = m.id;
        if (isNew) id = (await api('/api/medicines', { method: 'POST', body })).id;
        else await api(`/api/medicines/${id}`, { method: 'PUT', body });
        await photos.commit('medicine', id);
        await loadMasters();
        onCreated?.(id, body.name);
        toast('保存しました');
        backSheet();
        if (state.tab === 'master') renderTab();
      } catch (err) { alert(err.message); }
    });
  });
}

// ---------------- カテゴリ ----------------
const CATEGORY_ICONS = [
  '🏥', '🩺', '💊', '💉', '🩹', '🦷', '👁️', '👂', '🧠', '❤️', '🫁', '🦴',
  '🤰', '👶', '🧴', '🧪', '✂️', '💇', '💈', '💅', '💆', '🧖', '💄', '🪒',
  '🏋️', '🧘', '🏊', '🐶', '🐱', '📋', '🌸', '⭐',
];
const CATEGORY_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#57534e'];

function openCategoryEdit(c = {}, onCreated) {
  const isNew = !c.id;
  let icon = c.icon || '🏥';
  let color = c.color || CATEGORY_COLORS[state.categories.length % CATEGORY_COLORS.length];
  openSheet(async (sheet) => {
    sheet.innerHTML = `${sheetHead(isNew ? 'カテゴリを追加' : 'カテゴリを編集')}
      <form>
        <div class="field"><label>名前</label><input name="name" required value="${esc(c.name)}" placeholder="例: 病院（眼科）、整体、ネイル"></div>
        <div class="field"><label>アイコン</label><div class="icon-grid" data-icons>
          ${CATEGORY_ICONS.map((i) => `<button type="button" class="icon-opt" data-icon="${i}" aria-label="${i}">${i}</button>`).join('')}
        </div></div>
        <div class="field"><label>色</label><div class="color-grid" data-colors>
          ${CATEGORY_COLORS.map((col) => `<button type="button" class="color-opt" data-color="${col}" style="--c:${col}" aria-label="色 ${col}"></button>`).join('')}
        </div></div>
        <div class="field"><label>表示の見本</label><div data-preview></div></div>
        <div class="actions">
          ${!isNew ? '<button type="button" class="btn danger" data-delete style="flex:0 0 auto">削除</button>' : ''}
          <button class="btn primary">保存</button>
        </div>
      </form>`;
    bindHead(sheet);
    const form = $('form', sheet);
    const renderPicks = () => {
      $$('[data-icon]', sheet).forEach((b) => b.classList.toggle('on', b.dataset.icon === icon));
      $$('[data-color]', sheet).forEach((b) => b.classList.toggle('on', b.dataset.color === color));
      $('[data-preview]', sheet).innerHTML = `<span class="chip on" style="--c:${esc(color)};display:inline-block"><span class="dot"></span>${esc(icon)} ${esc(form.name.value || 'カテゴリ名')}</span>`;
    };
    $$('[data-icon]', sheet).forEach((b) => b.addEventListener('click', () => { icon = b.dataset.icon; renderPicks(); }));
    $$('[data-color]', sheet).forEach((b) => b.addEventListener('click', () => { color = b.dataset.color; renderPicks(); }));
    form.name.addEventListener('input', renderPicks);
    renderPicks();
    $('[data-delete]', sheet)?.addEventListener('click', async () => {
      if (!confirm(`カテゴリ「${c.name}」を削除すると、その中の予定・病院/お店もすべて削除されます。よろしいですか？`)) return;
      await api(`/api/categories/${c.id}`, { method: 'DELETE' });
      state.filter.delete(c.id);
      closeAllSheets(); toast('削除しました'); refresh();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { name: form.name.value, icon, color };
      try {
        let id = c.id;
        if (isNew) id = (await api('/api/categories', { method: 'POST', body })).id;
        else await api(`/api/categories/${c.id}`, { method: 'PUT', body });
        toast('保存しました');
        if (onCreated) { await loadMasters(); onCreated(id); backSheet(); renderTab(); return; }
        closeAllSheets(); refresh();
      } catch (err) { alert(err.message); }
    });
  });
}

// ---------------- 登録情報タブ ----------------
async function renderMaster(view) {
  const seg = state.masterSeg;
  let body = '';
  if (seg === 'places') {
    body = state.categories.map((c) => {
      const list = state.places.filter((p) => p.category_id === c.id);
      return `<div class="month-label"><span class="dot" style="--c:${esc(c.color)}"></span>${esc(c.icon)} ${esc(c.name)}</div>
        <div class="card">${list.map((p) => `<button class="item" data-place="${p.id}" style="--c:${esc(c.color)}"><span class="bar"></span>
          <span class="body"><div class="t">${esc(p.name)}</div>
            ${p.address ? `<div class="s">📍 ${esc(p.address)}</div>` : ''}
            ${p.url ? `<div class="s">🔗 ${esc(p.url)}</div>` : ''}
            ${!p.address && !p.url && p.memo ? `<div class="s">${esc(p.memo)}</div>` : ''}</span></button>`).join('')
          || '<div class="empty small">未登録</div>'}</div>`;
    }).join('');
  } else if (seg === 'medicines') {
    const q = state.medQuery.trim();
    const hit = (m) => !q || [m.name, m.efficacy, m.memo].some((s) => (s || '').toLowerCase().includes(q.toLowerCase()));
    const medRow = (m) => `<button class="item" data-med="${m.id}">
      ${m.thumb ? `<img class="thumb" src="${photoUrl(m.thumb)}" alt="" loading="lazy">` : '<span class="thumb" style="display:flex;align-items:center;justify-content:center;font-size:22px">💊</span>'}
      <span class="body"><div class="t">${esc(m.name)}</div><div class="s">${esc(m.efficacy || m.place_name || '')}</div></span></button>`;
    // カテゴリごとに分けて表示（カテゴリなしは最後）
    const groups = [...state.categories.map((c) => ({ c, list: state.medicines.filter((m) => m.category_id === c.id && hit(m)) })),
      { c: null, list: state.medicines.filter((m) => !catById(m.category_id) && hit(m)) }].filter((g) => g.list.length);
    body = `<input class="search" type="search" data-medq placeholder="薬の名前で検索" value="${esc(q)}">
      ${q ? `<div class="box small" style="margin-bottom:10px">「${esc(q)}」の効能・使い方を調べる<div style="margin-top:6px">${drugLinks(q)}</div></div>` : ''}
      ${groups.map((g) => `<div class="month-label">${g.c ? `<span class="dot" style="--c:${esc(g.c.color)}"></span>${esc(g.c.icon)} ${esc(g.c.name)}` : 'カテゴリなし'}</div>
        <div class="card">${g.list.map(medRow).join('')}</div>`).join('')
      || `<div class="card"><div class="empty">${q ? '登録済みの薬にはありません' : '薬は未登録です'}</div></div>`}`;
  } else {
    const n = state.categories.length;
    body = `<p class="small muted" style="margin:0 4px 6px">▲▼ で並び順を変えられます（カレンダーの上の並びにも反映されます）</p>
      <div class="card">${state.categories.map((c, i) => `<div class="item" style="--c:${esc(c.color)};cursor:default">
      <span class="bar"></span>
      <button class="body" data-cat="${c.id}" style="border:0;background:none;text-align:left;padding:0;cursor:pointer"><div class="t">${esc(c.icon)} ${esc(c.name)}</div></button>
      <button class="icon-btn" data-move="${i}" data-dir="-1" aria-label="上へ" ${i === 0 ? 'disabled style="opacity:.25"' : ''}>▲</button>
      <button class="icon-btn" data-move="${i}" data-dir="1" aria-label="下へ" ${i === n - 1 ? 'disabled style="opacity:.25"' : ''}>▼</button>
    </div>`).join('')}</div>`;
  }
  view.innerHTML = `<h1 style="margin-bottom:10px">登録情報</h1>
    <div class="seg">
      <button data-seg="places" class="${seg === 'places' ? 'on' : ''}">病院・お店</button>
      <button data-seg="medicines" class="${seg === 'medicines' ? 'on' : ''}">薬</button>
      <button data-seg="categories" class="${seg === 'categories' ? 'on' : ''}">カテゴリ</button>
    </div>
    ${body}
    <button class="fab" data-add aria-label="追加">＋</button>`;
  $$('[data-seg]', view).forEach((b) => b.addEventListener('click', () => { state.masterSeg = b.dataset.seg; renderTab(); }));
  const medq = $('[data-medq]', view);
  medq?.addEventListener('input', () => {
    clearTimeout(renderMaster.t);
    renderMaster.t = setTimeout(async () => {
      state.medQuery = medq.value;
      await renderTab();
      const i = $('[data-medq]');
      i.focus(); i.setSelectionRange(i.value.length, i.value.length);
    }, 400);
  });
  $$('[data-place]', view).forEach((b) => b.addEventListener('click', () => openPlaceView(Number(b.dataset.place))));
  $$('[data-med]', view).forEach((b) => b.addEventListener('click', () => openMedicineView(Number(b.dataset.med))));
  $$('[data-cat]', view).forEach((b) => b.addEventListener('click', () => openCategoryEdit(catById(b.dataset.cat))));
  $$('[data-move]', view).forEach((b) => b.addEventListener('click', async () => {
    const ids = state.categories.map((c) => c.id);
    const i = Number(b.dataset.move);
    const j = i + Number(b.dataset.dir);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('/api/categories/order', { method: 'PUT', body: { ids } });
    await refresh();
  }));
  $('[data-add]', view).addEventListener('click', () => {
    if (seg === 'places') openPlaceEdit({ category_id: [...state.filter][0] || state.categories[0]?.id });
    else if (seg === 'medicines') openMedicineEdit({});
    else openCategoryEdit();
  });
}

// ---------------- バックアップ ----------------
const DAY = 86400 * 1000;
const remindDays = () => getMeta('remind_days') || 7;
function daysSinceBackup() {
  const last = getMeta('last_backup');
  return last ? Math.floor((Date.now() - new Date(last).getTime()) / DAY) : null;
}
function backupDue() {
  const s = stats();
  if (!s.events && !s.places && !s.medicines) return false;
  const d = daysSinceBackup();
  return d === null || d >= remindDays();
}
function backupBanner() {
  if (!backupDue()) return '';
  const d = daysSinceBackup();
  return `<div class="box" style="border-color:var(--danger);margin-bottom:12px;display:flex;gap:8px;align-items:center">
    <span style="flex:1">⚠️ ${d === null ? 'まだバックアップしていません' : `前回のバックアップから${d}日たちました`}</span>
    <button class="btn primary" data-gobackup style="flex:none">バックアップ</button></div>`;
}
// ---------------- アプリの更新 ----------------
// sw.js の VERSION と同じ値にしておく（公開のたびに上げる）
const APP_VERSION = 'v18';
let newVersion = null;
// 公開されている版を調べる（キャッシュを使わずに取得）
async function checkUpdate() {
  try {
    const text = await fetch(`./sw.js?ts=${Date.now()}`, { cache: 'no-store' }).then((r) => r.text());
    const m = text.match(/VERSION = '([^']+)'/);
    newVersion = m && m[1] !== APP_VERSION ? m[1] : null;
  } catch { newVersion = null; }
  return newVersion;
}
// 保存してあるファイルを消してから開き直す
async function forceUpdate() {
  try {
    for (const k of await caches.keys()) await caches.delete(k);
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch { /* 消せなくても読み込み直す */ }
  location.replace(`${location.pathname}?u=${Date.now()}`);
}
function updateBanner() {
  if (!newVersion) return '';
  return `<div class="box" style="margin-bottom:12px;border-color:var(--accent);display:flex;gap:8px;align-items:center">
    <span style="flex:1">🆕 新しい版があります（${esc(newVersion)}）</span>
    <button class="btn primary" data-doupdate style="flex:none">更新する</button></div>`;
}

// ホーム画面のアイコン以外（Safari・アプリ内ブラウザ）で開いているか
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function placeWarning() {
  if (!isIOS || isStandalone) return '';
  return `<div class="box" style="border:2px solid var(--danger);margin-bottom:12px">
    <b style="color:var(--danger)">⚠️ ここで入力したデータは、ホーム画面のアプリには保存されません</b>
    <p class="small" style="margin:6px 0 0">いまは Safari または他のアプリの中で開いています。必ず<b>ホーム画面の「OurTime」アイコン</b>から開いて使ってください。</p>
    <details class="small" style="margin-top:6px"><summary style="color:var(--accent);cursor:pointer">ホーム画面に追加する方法</summary>
      <ol style="padding-left:20px;margin:6px 0 0;line-height:1.7">
        <li><b>Safari</b> で https://0009komu.github.io/care-notes/ を開く（Claude などのアプリ内で開いている場合は、右下などの「Safariで開く」を押す）</li>
        <li>下の共有ボタン（□↑）→「ホーム画面に追加」→「追加」</li>
        <li>ホーム画面にできた「OurTime」アイコンから開く</li>
      </ol></details>
  </div>`;
}
function goSettings() {
  state.tab = 'settings';
  $$('.tabbar button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'settings'));
  window.scrollTo(0, 0);
  renderTab();
}

// ---------------- カレンダーの取り込み ----------------
const SHORTCUT_HELP = `<ol class="small" style="padding-left:20px;margin:8px 0 0;line-height:1.7">
  <li><b>ショートカット</b> App を開き、右上の「＋」を押す</li>
  <li>「アクションを追加」で <b>カレンダーの予定を検索</b> を追加<br>
    「フィルタを追加」→「開始日」「が次の期間内」→ たとえば「90 日」にする<br>
    （「制限」はオフのまま）</li>
  <li><b>各項目を繰り返す</b> を追加（入力は「カレンダーの予定」）</li>
  <li>繰り返しの中に <b>テキスト</b> を追加し、次の4行を入れる<br>
    1行目: <code>■</code> に続けて変数「繰り返し項目」→ タップして <b>開始日</b> を選ぶ<br>
    2行目: 変数「繰り返し項目」→ <b>タイトル</b><br>
    3行目: 変数「繰り返し項目」→ <b>場所</b><br>
    4行目: 変数「繰り返し項目」→ <b>メモ</b></li>
  <li>「繰り返しの終了」の下に <b>クリップボードにコピー</b> を追加（入力は「繰り返しの結果」）</li>
  <li>名前を「OurTimeに送る」などにして完了</li>
</ol>
<p class="small muted">使うとき: ショートカットを実行 → このアプリを開いて「コピーした予定を貼り付け」。初回はカレンダーへのアクセス許可を聞かれます。</p>`;

function openPasteSheet() {
  openSheet(async (sheet) => {
    sheet.innerHTML = `${sheetHead('予定を貼り付け')}
      <p class="small muted" style="margin-top:0">ショートカットでコピーした内容を、下の欄を長押しして「ペースト」してください。</p>
      <div class="field"><textarea data-text style="min-height:200px" placeholder="■2026/10/01 10:00&#10;皮膚科&#10;さくら皮膚科&#10;メモ"></textarea></div>
      <div class="actions sticky"><button class="btn primary" data-next>次へ</button></div>`;
    bindHead(sheet);
    $('[data-next]', sheet).addEventListener('click', () => {
      const items = parseCalendarText($('[data-text]', sheet).value);
      if (!items.length) { alert('予定が見つかりませんでした。ショートカットの作り方を確認してください。'); return; }
      openCalendarImport(items);
    });
  });
}

async function openCalendarImport(all) {
  if (!all.length) { alert('予定が見つかりませんでした。'); return; }
  const imported = new Set(await api('/api/ext-ids'));
  const seen = new Set();
  const items = all.filter((it) => !imported.has(it.ext_id) && !seen.has(it.ext_id) && seen.add(it.ext_id))
    .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))
    .map((it) => {
      const g = guessCategory(it, state.categories, state.places);
      return { ...it, ...g, checked: !!g.category_id };
    });
  const skipped = all.length - items.length;

  openSheet(async (sheet) => {
    const placeOptions = (it) => `<option value="">（病院・お店なし）</option>${state.places.filter((p) => p.category_id === it.category_id)
      .map((p) => `<option value="${p.id}" ${p.id === it.place_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
    const count = () => items.filter((it) => it.checked && it.category_id).length;
    sheet.innerHTML = `${sheetHead('カレンダーから取り込む')}
      <p class="small muted" style="margin-top:0">${items.length}件の予定が見つかりました${skipped ? `（取り込み済みなど ${skipped}件は除外）` : ''}。取り込む予定にチェックを入れ、カテゴリを選んでください。</p>
      ${items.length ? `<div class="row" style="margin-bottom:8px"><button class="btn" data-all>すべて選択</button><button class="btn" data-none>すべて解除</button></div>` : ''}
      <div class="card">${items.map((it, i) => `
        <div class="import-row" data-row="${i}">
          <label class="check" style="min-height:auto;align-items:flex-start">
            <input type="checkbox" data-check ${it.checked ? 'checked' : ''}>
            <span style="flex:1;min-width:0"><b>${esc(it.title || '（タイトルなし）')}</b><br>
              <span class="small muted">${fmtDate(it.date)} ${esc(it.time)}${it.location ? ` · ${esc(it.location)}` : ''}</span></span>
          </label>
          <div class="row" style="margin-top:6px">
            <select data-cat><option value="">カテゴリを選ぶ…</option>${state.categories.map((c) => `<option value="${c.id}" ${c.id === it.category_id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select>
            <select data-place>${placeOptions(it)}</select>
          </div>
        </div>`).join('') || '<div class="empty">新しく取り込める予定はありません</div>'}</div>
      <div class="actions sticky"><button class="btn primary" data-go ${count() ? '' : 'disabled'}>選んだ ${count()}件を取り込む</button></div>`;
    bindHead(sheet);
    const go = $('[data-go]', sheet);
    const refreshCount = () => { const n = count(); go.disabled = !n; go.textContent = `選んだ ${n}件を取り込む`; };
    $$('[data-row]', sheet).forEach((row) => {
      const it = items[Number(row.dataset.row)];
      $('[data-check]', row).addEventListener('change', (e) => { it.checked = e.target.checked; refreshCount(); });
      $('[data-cat]', row).addEventListener('change', (e) => {
        it.category_id = Number(e.target.value) || null;
        it.place_id = null;
        $('[data-place]', row).innerHTML = placeOptions(it);
        if (it.category_id) { it.checked = true; $('[data-check]', row).checked = true; }
        refreshCount();
      });
      $('[data-place]', row).addEventListener('change', (e) => { it.place_id = Number(e.target.value) || null; });
    });
    const setAll = (v) => { items.forEach((it) => (it.checked = v)); $$('[data-check]', sheet).forEach((c) => (c.checked = v)); refreshCount(); };
    $('[data-all]', sheet)?.addEventListener('click', () => setAll(true));
    $('[data-none]', sheet)?.addEventListener('click', () => setAll(false));
    go.addEventListener('click', async () => {
      const targets = items.filter((it) => it.checked && it.category_id);
      if (items.some((it) => it.checked && !it.category_id) && !confirm('カテゴリを選んでいない予定は取り込まれません。続けますか？')) return;
      go.disabled = true; go.textContent = '取り込み中…';
      const today = todayStr();
      for (const it of targets) {
        const memo = [it.location && `場所: ${it.location}`, it.notes].filter(Boolean).join('\n');
        await api('/api/events', { method: 'POST', body: {
          category_id: it.category_id, place_id: it.place_id, date: it.date, time: it.time, title: it.title, memo,
          done: it.date < today, ext_id: it.ext_id, medicines: [],
        } });
      }
      closeAllSheets();
      toast(`${targets.length}件を取り込みました`);
      state.tab = 'calendar';
      $$('.tabbar button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'calendar'));
      await refresh();
    });
  });
}

// ---------------- 設定タブ ----------------
async function renderSettings(view) {
  const s = stats();
  const last = getMeta('last_backup');
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
  view.innerHTML = `<h1 style="margin-bottom:10px">設定</h1>
    <h2>バックアップ</h2>
    <div class="box">
      <dl class="detail" style="margin:0">
        <dt>前回のバックアップ</dt><dd>${last ? `${new Date(last).toLocaleString('ja-JP')}（${daysSinceBackup()}日前）` : 'まだありません'}</dd>
        <dt>お知らせの間隔</dt><dd><select data-remind style="padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--card)">
          ${[3, 7, 14, 30].map((n) => `<option value="${n}" ${n === remindDays() ? 'selected' : ''}>${n}日ごと</option>`).join('')}</select></dd>
      </dl>
      <p class="small muted">「バックアップを作成」→「保存先を選ぶ」で共有メニューが開きます。<b>Google ドライブ</b>（アプリ）または「ファイルに保存」→ Google ドライブ を選んでください。</p>
      <div class="actions" style="flex-direction:column">
        <button class="btn primary" data-make>バックアップを作成</button>
        <button class="btn primary" data-share hidden>保存先を選ぶ</button>
      </div>
    </div>
    <h2>iPhone のカレンダーから取り込む</h2>
    <div class="box">
      <p class="small muted" style="margin-top:0">ショートカット App でコピーした予定を貼り付けるか、カレンダーのファイル（.ics）を選びます。取り込む予定とカテゴリは次の画面で選べます。</p>
      <div class="actions" style="flex-direction:column;margin-top:8px">
        <button class="btn primary" data-paste>コピーした予定を貼り付け</button>
        <label class="btn block" style="display:flex;align-items:center;justify-content:center">カレンダーのファイル（.ics）を選ぶ<input type="file" accept=".ics,text/calendar" data-ics hidden></label>
      </div>
      <details style="margin-top:10px">
        <summary class="small" style="cursor:pointer;color:var(--accent)">ショートカットの作り方（最初に1回だけ）</summary>
        ${SHORTCUT_HELP}
      </details>
    </div>
    <h2>📱 端末登録</h2>
    <div class="box">${deviceSettingsHtml()}</div>
    <h2>通知</h2>
    <div class="box">
      <div class="row" style="align-items:center;margin-bottom:8px"><span style="flex:none">通知のタイミング</span>
        <select data-alarm style="padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card)">
          ${ALARM_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === alarmMinutes() ? 'selected' : ''}>${o.label}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" data-daybefore ${getMeta('alarm_day_before') ? 'checked' : ''}> 前日にも通知する</label>
      <p class="small muted" style="margin:0">時刻のない予定は、前日の 9:00 に通知します。</p>
      <h3 style="font-size:14px;margin:14px 0 4px">このアプリから通知する</h3>
      ${pushSettingsHtml()}
      <h3 style="font-size:14px;margin:14px 0 4px">iPhone のカレンダーに追加して通知する</h3>
      <p class="small muted" style="margin:0 0 6px">アプリからの通知が使えないときの方法です。</p>
      <button class="btn block" data-bulkcal>これからの予定をまとめて追加</button>
    </div>
    <h2>アプリの更新</h2>
    <div class="box">
      <p class="small" style="margin-top:0">今の版: <b>${esc(APP_VERSION)}</b>${newVersion ? ` <span style="color:var(--danger)">→ 新しい版 ${esc(newVersion)} があります</span>` : '（最新です）'}</p>
      <p class="small muted" style="margin:0 0 8px">新しい機能が出てこないときは、下のボタンを押してください。保存してある画面ファイルを消して読み込み直します（予定などのデータは消えません）。</p>
      <div class="row"><button class="btn" data-checkupdate>最新か確認する</button><button class="btn primary" data-forceupdate>最新に更新する</button></div>
    </div>
    <h2>🗑️ ごみの日（大津市 栄町）</h2>
    <div class="box">
      <label class="check"><input type="checkbox" data-gomion ${gomiOn() ? 'checked' : ''}> カレンダーに表示する</label>
      <p class="small muted" style="margin:0 0 8px">前日の夜に出す前提で、<b>収集日の1日前</b>に表示します（例: 金曜の朝に収集 → 木曜に表示）。</p>
      <div class="row" style="align-items:center">
        <label class="check" style="flex:1"><input type="checkbox" data-gominotify ${getMeta('gomi_notify') ? 'checked' : ''}> 前夜に通知する</label>
        <select data-gomitime style="flex:0 0 100px">${['18:00', '19:00', '20:00', '21:00', '22:00'].map((t) => `<option ${t === (getMeta('gomi_time') || '20:00') ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <p class="small muted" style="margin:6px 0 0">収集日のデータ: ${esc(GOMI_RANGE.first.replaceAll('-', '/'))}〜${esc(GOMI_RANGE.last.replaceAll('-', '/'))}（大津市の
        <a href="${esc(GOMI_SOURCE)}" target="_blank" rel="noopener">ごみ収集カレンダー</a>より）。期間が終わる前に入れ替えが必要です。</p>
    </div>
    <h2>👪 家族と共有</h2>
    <div class="box">${familySettingsHtml()}</div>
    <h2>乗り換え検索の出発地（自宅・会社など）</h2>
    <div class="box">
      <p class="small muted" style="margin-top:0">登録した場所から、病院・お店までの電車の乗り換えを iPhone の「マップ」で調べられます。住所・駅名・建物名のどれでも大丈夫です。この iPhone の中にだけ保存されます。</p>
      ${origins().map((o, i) => `<div class="origin-row" data-orow="${i}">
        <div class="row">
          <select data-oicon style="flex:0 0 64px">${ORIGIN_ICONS.map((ic) => `<option ${ic === o.icon ? 'selected' : ''}>${ic}</option>`).join('')}</select>
          <input data-olabel value="${esc(o.label)}" placeholder="名前（例: 家族の会社）">
          <button class="icon-btn" data-odel="${i}" aria-label="この場所を削除" style="flex:none">🗑️</button>
        </div>
        <div class="row" style="margin-top:6px">
          <input data-oaddr value="${esc(o.address)}" placeholder="例: 東京都渋谷区… / 渋谷駅">
          <button class="btn" data-olookup="${i}" style="flex:none">🔍</button>
        </div></div>`).join('')}
      <div class="row" style="margin-top:8px"><button class="btn" data-oadd>＋ 場所を追加</button><button class="btn primary" data-saveorigins>保存</button></div>
    </div>
    <h2>Google の場所検索</h2>
    <div class="box">
      <p class="small muted" style="margin-top:0">病院・お店の名前から住所・URL・電話番号を入れるための API キーです。キーはこの iPhone の中にだけ保存されます。</p>
      <div class="field" style="margin-bottom:8px"><input data-key type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
        placeholder="${getMeta('places_key') ? '登録済み（変更するときだけ入力）' : 'API キーを貼り付け'}"
        style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);font-size:16px"></div>
      <div class="row">
        <button class="btn primary" data-savekey>保存</button>
        ${getMeta('places_key') ? '<button class="btn danger" data-delkey style="flex:none">削除</button>' : ''}
      </div>
      <p class="small" style="margin-bottom:0">状態: ${getMeta('places_key') ? '✅ 登録済み' : '未登録'}</p>
    </div>
    <h2>復元</h2>
    <div class="box">
      <p class="small muted" style="margin-top:0">バックアップファイル（.json）を選ぶと、<b>今のデータをすべて置き換えて</b>復元します。PC版からの移行にも使えます。</p>
      <label class="btn block" style="display:flex;align-items:center;justify-content:center">バックアップファイルを選ぶ<input type="file" accept=".json,application/json" data-import hidden></label>
    </div>
    <h2>このアプリについて</h2>
    <div class="box small">
      データはこの iPhone の中だけに保存されます（予定 ${s.events}件・病院/お店 ${s.places}件・薬 ${s.medicines}件・写真 ${s.photos}枚${est?.usage ? `、約${fmtSize(est.usage)}` : ''}）。<br>
      ${persisted ? '保存領域は「永続」に設定されています。' : ''}
      ホーム画面からこのアプリを削除すると、データも消えます。定期的にバックアップしてください。
    </div>`;

  $('[data-remind]', view).addEventListener('change', async (e) => { await setMeta('remind_days', Number(e.target.value)); toast('変更しました'); });

  let file = null;
  const shareBtn = $('[data-share]', view);
  $('[data-make]', view).addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '作成中…';
    try {
      file = await exportBackup();
      shareBtn.hidden = false;
      e.target.textContent = `作成しました（${fmtSize(file.size)}）`;
    } catch (err) {
      alert(err.message);
      e.target.disabled = false; e.target.textContent = 'バックアップを作成';
    }
  });
  // iOS の共有はタップ直後に呼ぶ必要があるので、作成とは別のボタンにしている
  shareBtn.addEventListener('click', async () => {
    if (!file) return;
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: file.name });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      }
      await setMeta('last_backup', new Date().toISOString());
      toast('バックアップしました');
      renderTab();
    } catch (err) {
      if (err.name !== 'AbortError') alert(err.message);
    }
  });

  $('[data-alarm]', view).addEventListener('change', async (e) => { await setMeta('alarm_min', Number(e.target.value)); schedulePushSync(); toast('変更しました'); });
  $('[data-daybefore]', view).addEventListener('change', async (e) => { await setMeta('alarm_day_before', e.target.checked); schedulePushSync(); toast('変更しました'); });
  bindPushSettings(view);
  bindFamilySettings(view);
  bindDeviceSettings(view);
  $('[data-checkupdate]', view).addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '確認中…';
    const v = await checkUpdate();
    toast(v ? `新しい版 ${v} があります` : 'すでに最新です');
    renderTab();
  });
  $('[data-forceupdate]', view).addEventListener('click', forceUpdate);
  $('[data-gomion]', view).addEventListener('change', async (e) => { await setMeta('gomi_on', e.target.checked); toast('変更しました'); });
  $('[data-gominotify]', view).addEventListener('change', async (e) => { await setMeta('gomi_notify', e.target.checked); schedulePushSync(); toast('変更しました'); });
  $('[data-gomitime]', view).addEventListener('change', async (e) => { await setMeta('gomi_time', e.target.value); schedulePushSync(); toast('変更しました'); });
  // 予定の読み込みを先に済ませ、タップ直後にファイルを開けるようにしておく
  let pending = await upcomingNotExported();
  const bulk = $('[data-bulkcal]', view);
  bulk.textContent = pending.length ? `これからの予定をまとめて追加（未追加 ${pending.length}件）` : 'カレンダーに追加していない予定はありません';
  bulk.disabled = !pending.length;
  bulk.addEventListener('click', async () => {
    if (!pending.length) return;
    openIcs(buildIcs(pending, alarmOpts()), `care-${todayStr()}.ics`);
    await markExported(pending);
    pending = [];
    bulk.textContent = '追加しました'; bulk.disabled = true;
  });

  // 入力中の内容を読み取って保存する
  const readOrigins = () => $$('[data-orow]', view).map((row, i) => ({
    id: origins()[i]?.id || `o${Date.now()}${i}`,
    icon: $('[data-oicon]', row).value,
    label: $('[data-olabel]', row).value.trim(),
    address: $('[data-oaddr]', row).value.trim(),
  }));
  const saveOrigins = (list) => setMeta('origins', list);
  $('[data-saveorigins]', view).addEventListener('click', async () => {
    await saveOrigins(readOrigins().filter((o) => o.label || o.address));
    toast('保存しました');
    renderTab();
  });
  $('[data-oadd]', view).addEventListener('click', async () => {
    await saveOrigins([...readOrigins(), { id: `o${Date.now()}`, icon: '📍', label: '', address: '' }]);
    await renderTab();
    const rows = $$('[data-orow]');
    $('[data-olabel]', rows.at(-1))?.focus();
  });
  $$('[data-odel]', view).forEach((b) => b.addEventListener('click', async () => {
    const list = readOrigins();
    const o = list[Number(b.dataset.odel)];
    if ((o.label || o.address) && !confirm(`「${o.label || o.address}」を削除しますか？`)) return;
    list.splice(Number(b.dataset.odel), 1);
    await saveOrigins(list);
    renderTab();
  }));
  $$('[data-olookup]', view).forEach((b) => b.addEventListener('click', async () => {
    const list = readOrigins();
    const i = Number(b.dataset.olookup);
    const q = list[i].address || list[i].label;
    if (!q) { alert('先に建物名や駅名などを入力してください'); return; }
    await saveOrigins(list);
    openPlaceLookup(q, async (hit) => {
      const cur = origins();
      cur[i] = { ...cur[i], address: hit.address || hit.name };
      await saveOrigins(cur);
      renderTab();
    });
  }));

  $('[data-savekey]', view).addEventListener('click', async () => {
    const v = $('[data-key]', view).value.trim();
    if (!v) { alert('API キーを入力してください'); return; }
    await setMeta('places_key', v);
    toast('保存しました');
    renderTab();
  });
  $('[data-delkey]', view)?.addEventListener('click', async () => {
    if (!confirm('API キーを削除しますか？')) return;
    await setMeta('places_key', '');
    renderTab();
  });

  $('[data-paste]', view).addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* 許可されなかったら手で貼り付け */ }
    if (text && /■|BEGIN:VCALENDAR/.test(text)) openCalendarImport(parseCalendarText(text));
    else openPasteSheet();
  });
  $('[data-ics]', view).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) openCalendarImport(parseCalendarText(await f.text()));
  });

  $('[data-import]', view).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!confirm(`「${f.name}」から復元します。今のデータはすべて置き換わります。よろしいですか？`)) return;
    try {
      const r = await importBackup(f);
      await setMeta('last_backup', new Date().toISOString());
      toast(`復元しました（予定 ${r.events}件・写真 ${r.photos}枚）`);
      schedulePushSync();
      await refresh();
    } catch (err) { alert(`復元できませんでした: ${err.message}`); }
  });
}

// ---------------- タブ切替 ----------------
const renderers = { calendar: renderCalendar, list: renderList, master: renderMaster, settings: renderSettings };
async function renderTab() {
  const view = $('#view');
  try {
    await renderers[state.tab](view);
    if (state.tab === 'calendar') view.insertAdjacentHTML('afterbegin', await soonBanner());
    // カレンダーには出さず、「設定」タブに小さな印だけ付ける
    $('.tabbar [data-tab=settings]').classList.toggle('due', backupDue());
    view.insertAdjacentHTML('afterbegin', placeWarning());
    view.insertAdjacentHTML('afterbegin', updateBanner());
    $('[data-doupdate]', view)?.addEventListener('click', forceUpdate);
  } catch (err) {
    view.innerHTML = `<div class="empty">読み込みに失敗しました: ${esc(err.message)}</div>`;
  }
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab;
  $$('.tabbar button').forEach((x) => x.classList.toggle('active', x === b));
  window.scrollTo(0, 0);
  renderTab();
}));

// オフラインでも開けるようにする
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

// ---------------- 初回だけのパスワード ----------------
// ※ 公開ファイルに含まれるので本格的な鍵ではない（データはもともと端末の外に出ない）
const PASS_HASH = 'c8ace20a55c88e4d1fc94009b763c6690efa764f5e6497cc736acf069b1fbc82';
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function showLock() {
  return new Promise((resolve) => {
    document.querySelector('.tabbar').hidden = true;
    const view = $('#view');
    view.innerHTML = `<div style="max-width:320px;margin:15vh auto 0;text-align:center">
      <img src="icon.svg" alt="" width="72" height="72" style="border-radius:16px">
      <h1 style="margin:12px 0 4px">OurTime</h1>
      <p class="small muted">最初に一度だけ、パスワードを入力してください</p>
      <form data-lock><input type="password" inputmode="numeric" autocomplete="off" name="pw" placeholder="パスワード"
        style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--card);font-size:20px;text-align:center;letter-spacing:6px">
        <button class="btn primary block" style="margin-top:10px">はじめる</button>
        <p data-err class="small" style="color:var(--danger)" hidden>パスワードが違います</p></form>
    </div>`;
    const form = $('[data-lock]', view);
    form.pw.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await sha256(form.pw.value.trim()) === PASS_HASH) {
        await setMeta('unlocked', true);
        document.querySelector('.tabbar').hidden = false;
        resolve();
      } else {
        $('[data-err]', view).hidden = false;
        form.pw.value = '';
      }
    });
  });
}

openStore().then(async () => {
  if (!getMeta('unlocked')) await showLock();
  checkUpdate().then((v) => { if (v) renderTab(); }); // 新しい版が出ていたらお知らせ
  await autoClaimOwner(); // 以前から通知を使っている端末は、持ち主として自動で登録
  await refresh();
  schedulePushSync(); // 開くたびに通知の予約を最新にする（日付が進んだ分など）
}).catch((err) => {
  $('#view').innerHTML = `<div class="empty">データを開けませんでした: ${esc(err.message)}<br>プライベートブラウズでは使えません。</div>`;
});
