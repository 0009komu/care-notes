// このアプリからの通知（Web Push）。通知の時刻になったら Cloudflare の通知サーバーが送る
// サーバーに渡すのは「通知する日時」と「短い文」だけ
export const PUSH_SERVER = 'https://care-notes-push.care-notes-push.workers.dev';

const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

// 承認済みの端末の証明（id と secret）。app.js から渡される
let clientProvider = () => null;
export function setClientProvider(fn) { clientProvider = fn; }

export class ServerError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// サーバー呼び出し。承認情報を自動で付ける
export async function serverCall(method, path, body) {
  const res = await fetch(PUSH_SERVER + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify({ ...(body || {}), client: clientProvider() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ServerError(data.error || `サーバーのエラー (${res.status})`, data.code);
  return data;
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// 通知をオンにする（ボタンを押した直後に呼ぶこと）
export async function enablePush() {
  if (!pushSupported()) throw new Error('この端末では通知を使えません。iOS 16.4 以降で、ホーム画面のアイコンから開いてください');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知が許可されませんでした。iPhone の「設定」→「通知」→「OurTime」で許可できます');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await serverCall('GET', '/vapid');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(publicKey) });
  return serverCall('POST', '/register', { sub: sub.toJSON() }); // { deviceId, token }
}

export async function sendJobs(device, jobs) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return serverCall('PUT', '/jobs', { ...device, sub: sub ? sub.toJSON() : undefined, jobs });
}

export const testPush = (device) => serverCall('POST', '/test', device);

export async function disablePush(device) {
  await serverCall('POST', '/unregister', device).catch(() => {});
  const reg = await navigator.serviceWorker.ready;
  await (await reg.pushManager.getSubscription())?.unsubscribe();
}

// ---------------- 端末の承認 ----------------
// 最初の持ち主: すでに通知をオンにしている端末の証明で登録
export const claimOwner = (device, name) => serverCall('POST', '/auth/claim', { ...device, name });
// 登録コードで承認してもらう
export const redeemPairCode = (code, name) => serverCall('POST', '/auth/redeem', { code, name });
// 承認済みの端末が、ほかの端末用の登録コードを発行
export const issuePairCode = () => serverCall('POST', '/auth/pair-code', {});
export const listClients = () => serverCall('POST', '/auth/list', {});
export const removeClient = (id) => serverCall('POST', '/auth/remove', { id });
