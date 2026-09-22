// iPhone のカレンダーの予定を読み取る
//   1. ショートカット App が作るテキスト（1件ごとに「■」で始まる）
//   2. .ics ファイル（カレンダーの標準形式）
// どちらも [{ ext_id, date: 'YYYY-MM-DD', time: 'HH:MM' | '', title, location, notes }] を返す
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// 「2026/09/25 10:00」「2026年9月25日 午後3:00」「2026-09-25 15:00」などを読む
function parseDateTime(s) {
  const d = s.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  if (!d) return null;
  const date = `${d[1]}-${pad(d[2])}-${pad(d[3])}`;
  const rest = s.slice(d.index + d[0].length);
  const t = rest.match(/(\d{1,2}):(\d{2})/);
  let time = '';
  if (t) {
    let h = Number(t[1]);
    if (/午後|PM|pm/.test(rest) && h < 12) h += 12;
    if (/午前|AM|am/.test(rest) && h === 12) h = 0;
    time = `${pad(h)}:${t[2]}`;
  }
  // 終日の予定は 0:00 開始として渡されるので時刻なしにする
  if (/終日/.test(rest) || time === '00:00') time = '';
  return { date, time };
}

export function parseShortcutText(text) {
  const out = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/^■/m).slice(1)) {
    const lines = block.split('\n');
    const dt = parseDateTime(lines[0] || '');
    if (!dt) continue;
    const title = (lines[1] || '').trim();
    const location = (lines[2] || '').trim();
    const notes = lines.slice(3).join('\n').trim();
    out.push({ ext_id: `sc:${dt.date} ${dt.time} ${title}`, ...dt, title, location, notes });
  }
  return out;
}

function unescapeIcs(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}
function icsDate(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  if (!m[4] || /VALUE=DATE(?!-)/.test(params)) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: '' };
  if (m[7]) { // UTC → この端末の時刻
    const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    return { date: ymd(d), time: hm(d) };
  }
  // TZID 付き／時刻のみの場合は、書かれた時刻をそのまま使う（日本時間の予定を想定）
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

export function parseIcs(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur?.start) {
        out.push({
          ext_id: `ics:${cur.uid || cur.summary}:${cur.start.date}`,
          ...cur.start, title: cur.summary || '', location: cur.location || '', notes: cur.description || '',
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(';');
    const value = line.slice(i + 1);
    switch (name.toUpperCase()) {
      case 'DTSTART': cur.start = icsDate(value, params.join(';')); break;
      case 'SUMMARY': cur.summary = unescapeIcs(value).trim(); break;
      case 'LOCATION': cur.location = unescapeIcs(value).trim(); break;
      case 'DESCRIPTION': cur.description = unescapeIcs(value).trim(); break;
      case 'UID': cur.uid = value.trim(); break;
    }
  }
  return out;
}

export function parseCalendarText(text) {
  return /BEGIN:VCALENDAR/.test(text) ? parseIcs(text) : parseShortcutText(text);
}

// カテゴリ名・病院名から、どのカテゴリの予定かを推測する
const HINTS = [
  [/美容|ヘア|髪/, ['美容', 'カット', 'カラー', 'パーマ', 'ヘア', 'サロン', 'トリートメント', 'ヘッドスパ']],
  [/皮膚/, ['皮膚', 'ひふ', 'スキン']],
  [/歯/, ['歯', 'デンタル', '矯正']],
  [/眼|目/, ['眼科', 'コンタクト']],
  [/耳|鼻/, ['耳鼻']],
  [/病院|医院|クリニック/, ['病院', '医院', 'クリニック', '診察', '通院', '検診', '健診']],
  [/ネイル/, ['ネイル']],
  [/整体|マッサージ/, ['整体', 'マッサージ', '鍼', 'カイロ']],
];
export function guessCategory(item, categories, places) {
  const hay = `${item.title} ${item.location}`;
  const place = places.find((p) => p.name && hay.includes(p.name));
  if (place) return { category_id: place.category_id, place_id: place.id };
  // カテゴリ名そのものが含まれていれば強く、関連語なら弱く数える
  let best = null;
  let bestScore = 0;
  for (const c of categories) {
    const own = c.name.split(/[（）()・\s/]+/).filter((w) => w.length >= 2);
    const extra = HINTS.filter(([re]) => re.test(c.name)).flatMap(([, words]) => words);
    const score = own.filter((w) => hay.includes(w)).length * 3 + extra.filter((w) => hay.includes(w)).length;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return { category_id: best ? best.id : null, place_id: null };
}
