// 家族共有：共有にした予定（日付・時間・タイトルだけ）を、招待コードから作った鍵で暗号化して預ける。
// サーバーには招待コードそのものは送らず、コードから作った groupId と、暗号化した中身だけを送る。
import { PUSH_SERVER } from './push.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい 0/O・1/I は使わない

export const MEMBER_COLORS = ['#7c3aed', '#ea580c', '#0891b2', '#ca8a04', '#16a34a', '#db2777'];

// 16文字（約80ビット）の招待コード。表示は 4 文字ずつ区切る
export function newInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const s = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  return s.match(/.{4}/g).join('-');
}
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function derive(code) {
  const raw = enc.encode(normalizeCode(code));
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const idBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('care-notes-family'), info: enc.encode('group-id') }, base, 128);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('care-notes-family'), info: enc.encode('data-key') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const groupId = [...new Uint8Array(idBits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { groupId, key };
}

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return `${b64(iv)}.${b64(ct)}`;
}
async function open(key, blob) {
  const [iv, ct] = blob.split('.');
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct))));
}

async function call(path, body) {
  const res = await fetch(PUSH_SERVER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `共有サーバーのエラー (${res.status})`);
  return data;
}

// create=true でグループを新しく作る。戻り値は端末に保存する
export async function joinFamily(code, create = false) {
  const { groupId } = await derive(code);
  const r = await call('/family/join', { groupId, create });
  return { code: normalizeCode(code), groupId, memberId: r.memberId, token: r.token };
}

export async function pushFamily(fam, profile, events) {
  const { key } = await derive(fam.code);
  const blob = await seal(key, { ...profile, events, updated: Date.now() });
  await call('/family/push', { groupId: fam.groupId, memberId: fam.memberId, token: fam.token, blob });
}

// 家族全員分を取得して復号する（自分の分も含む）
export async function pullFamily(fam) {
  const { key } = await derive(fam.code);
  const { members } = await call('/family/pull', { groupId: fam.groupId, memberId: fam.memberId, token: fam.token });
  const out = [];
  for (const m of members) {
    if (!m.blob) { out.push({ memberId: m.memberId, name: '（まだ同期していません）', events: [] }); continue; }
    try { out.push({ memberId: m.memberId, ...(await open(key, m.blob)) }); } catch { /* 読めないデータは無視 */ }
  }
  return out;
}

export const leaveFamily = (fam) => call('/family/leave', { groupId: fam.groupId, memberId: fam.memberId, token: fam.token });
