// 日本の祝日（「国民の祝日に関する法律」に基づいて計算。2000〜2099年）
// 振替休日・国民の休日・2019〜2021年の特例にも対応
const pad = (n) => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const cache = new Map();

// 第 n 月曜日
function nthMonday(y, m, n) {
  const first = new Date(y, m - 1, 1).getDay();
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}
// 春分・秋分（1980〜2099年に使える近似式）
const shunbun = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const shubun = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

function build(y) {
  const h = new Map();
  const add = (m, d, name) => h.set(key(y, m, d), name);

  add(1, 1, '元日');
  add(1, nthMonday(y, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (y >= 2020) add(2, 23, '天皇誕生日');
  add(3, shunbun(y), '春分の日');
  add(4, 29, y >= 2007 ? '昭和の日' : 'みどりの日');
  add(5, 3, '憲法記念日');
  if (y >= 2007) add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  if (y === 2020) add(7, 23, '海の日');
  else if (y === 2021) add(7, 22, '海の日');
  else if (y >= 2003) add(7, nthMonday(y, 7, 3), '海の日');
  else add(7, 20, '海の日');
  if (y === 2020) add(8, 10, '山の日');
  else if (y === 2021) add(8, 8, '山の日');
  else if (y >= 2016) add(8, 11, '山の日');
  add(9, y >= 2003 ? nthMonday(y, 9, 3) : 15, '敬老の日');
  add(9, shubun(y), '秋分の日');
  if (y === 2020) add(7, 24, 'スポーツの日');
  else if (y === 2021) add(7, 23, 'スポーツの日');
  else add(10, nthMonday(y, 10, 2), y >= 2020 ? 'スポーツの日' : '体育の日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');
  if (y <= 2018) add(12, 23, '天皇誕生日');
  if (y === 2019) {
    add(5, 1, '天皇の即位の日');
    add(10, 22, '即位礼正殿の儀');
  }

  // 国民の休日（祝日にはさまれた平日）
  for (const k of [...h.keys()]) {
    const [yy, mm, dd] = k.split('-').map(Number);
    const next = new Date(yy, mm - 1, dd + 1);
    const after = new Date(yy, mm - 1, dd + 2);
    const nk = key(next.getFullYear(), next.getMonth() + 1, next.getDate());
    const ak = key(after.getFullYear(), after.getMonth() + 1, after.getDate());
    if (!h.has(nk) && h.has(ak) && next.getDay() !== 0 && next.getFullYear() === y) h.set(nk, '国民の休日');
  }

  // 振替休日（日曜の祝日の次の、祝日でない日）
  for (const k of [...h.keys()].sort()) {
    const [yy, mm, dd] = k.split('-').map(Number);
    if (new Date(yy, mm - 1, dd).getDay() !== 0) continue;
    const d = new Date(yy, mm - 1, dd + 1);
    while (h.has(key(d.getFullYear(), d.getMonth() + 1, d.getDate()))) d.setDate(d.getDate() + 1);
    if (d.getFullYear() === y) h.set(key(y, d.getMonth() + 1, d.getDate()), '振替休日');
  }
  return h;
}

// 'YYYY-MM-DD' → 祝日名（祝日でなければ ''）
export function holidayName(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  if (!cache.has(y)) cache.set(y, build(y));
  return cache.get(y).get(dateStr) || '';
}
