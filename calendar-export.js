// 予定を .ics（カレンダーの標準形式）にして、iPhone のカレンダーに通知つきで追加する
const pad = (n) => String(n).padStart(2, '0');

// 通知のタイミング（分）。0 は予定の時刻ちょうど、null はなし
export const ALARM_OPTIONS = [
  { value: 15, label: '15分前' },
  { value: 30, label: '30分前' },
  { value: 60, label: '1時間前' },
  { value: 120, label: '2時間前' },
  { value: 180, label: '3時間前' },
  { value: 1440, label: '1日前' },
  { value: -1, label: '通知なし' },
];

function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}
// 75 バイトを超える行は折り返す（カレンダーの決まり）
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > 73) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
function utc(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
}
function dateOnly(s) {
  return s.replaceAll('-', '');
}

function veventLines(e, { alarm = 60, dayBefore = false, durationMin = 60 } = {}) {
  const [y, m, d] = e.date.split('-').map(Number);
  const title = `${e.icon || ''}${e.title || e.place_name || e.category_name || '予定'}`;
  const place = e.place;
  const details = [
    e.place_name && e.title ? e.place_name : '',
    place?.phone ? `電話: ${place.phone}` : '',
    place?.url || '',
    e.memo || '',
    ...(e.medicines || []).map((x) => `薬: ${x.name}${x.note ? `（${x.note}）` : ''}`),
  ].filter(Boolean).join('\n');
  const lines = ['BEGIN:VEVENT', `UID:care-${e.id}@care-notes`, `DTSTAMP:${utc(new Date())}`];
  if (e.time) {
    const [h, mi] = e.time.split(':').map(Number);
    const start = new Date(y, m - 1, d, h, mi);
    const end = new Date(start.getTime() + durationMin * 60000);
    lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
  } else {
    const next = new Date(y, m - 1, d + 1);
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(e.date)}`, `DTEND;VALUE=DATE:${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`);
  }
  lines.push(`SUMMARY:${esc(title)}`);
  if (place?.address || e.place_name) lines.push(`LOCATION:${esc(place?.address || e.place_name)}`);
  if (details) lines.push(`DESCRIPTION:${esc(details)}`);
  const alarms = [];
  // 時刻のない予定は、その日の 0:00 が基準になるので「前日 9:00」に通知する
  if (alarm >= 0) alarms.push(e.time ? `-PT${alarm}M` : '-PT15H');
  if (dayBefore && alarm !== 1440) alarms.push(e.time ? '-P1D' : '-PT39H');
  for (const trigger of alarms) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, `TRIGGER:${trigger}`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

export function buildIcs(events, opts) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//care-notes//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of events) lines.push(...veventLines(e, opts));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// iPhone では .ics を開くと「カレンダーに追加」の画面が出る
export function openIcs(ics, name = 'care-notes.ics') {
  const file = new File([ics], name, { type: 'text/calendar' });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return file;
}

export async function shareIcs(file) {
  if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: file.name });
  else throw new Error('この端末では共有できません');
}
