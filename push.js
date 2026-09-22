// このアプリからの通知（Web Push）。通知の時刻になったら Cloudflare の通知サーバーが送る
// サーバーに渡すのは「通知する日時」と「短い文」だけ
export const PUSH_SERVER = 'https://care-notes-push.care-notes-push.workers.dev';

const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function call(method, path, body) {
  const res = await fetch(PUSH_SERVER + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `通知サーバーのエラー (${res.status})`);
  return data;
}

// 通知をオンにする（ボタンを押した直後に呼ぶこと）
export async function enablePush() {
  if (!pushSupported()) throw new Error('この端末では通知を使えません。iOS 16.4 以降で、ホーム画面のアイコンから開いてください');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知が許可されませんでした。iPhone の「設定」→「通知」→「OurTime」で許可できます');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await call('GET', '/vapid');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(publicKey) });
  return call('POST', '/register', { sub: sub.toJSON() }); // { deviceId, token }
}

export async function sendJobs(device, jobs) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return call('PUT', '/jobs', { ...device, sub: sub ? sub.toJSON() : undefined, jobs });
}

export const testPush = (device) => call('POST', '/test', device);

export async function disablePush(device) {
  await call('POST', '/unregister', device).catch(() => {});
  const reg = await navigator.serviceWorker.ready;
  await (await reg.pushManager.getSubscription())?.unsubscribe();
}
