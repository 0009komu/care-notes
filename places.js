// Google の場所検索（Maps JavaScript API の Place.searchByText）
// API キーは iPhone の中（設定）にだけ保存し、公開ファイルには含めない
let loading = null;
let loadedKey = null;

function loadMaps(key) {
  if (loading && loadedKey === key) return loading;
  if (loadedKey && loadedKey !== key) {
    // 読み込み済みのキーは差し替えられないので、ページを開き直してもらう
    return Promise.reject(new Error('API キーを変更した場合は、アプリを一度閉じて開き直してください'));
  }
  loadedKey = key;
  loading = new Promise((resolve, reject) => {
    const cb = `__gmapsReady${Date.now()}`;
    window[cb] = () => { delete window[cb]; resolve(); };
    // キーが間違っている・制限に合わないときに呼ばれる
    window.gm_authFailure = () => reject(new Error('API キーが使えませんでした。キーと制限の設定を確認してください'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=ja&region=JP&loading=async&callback=${cb}`;
    s.async = true;
    s.onerror = () => { loading = null; loadedKey = null; reject(new Error('Google に接続できませんでした（オフラインかもしれません）')); };
    document.head.appendChild(s);
  });
  return loading;
}

function friendly(err) {
  const m = String(err?.message || err);
  if (/API key not valid|InvalidKey/i.test(m)) return 'API キーが正しくありません。「設定」で登録し直してください';
  if (/RefererNotAllowed|referer/i.test(m)) return 'この API キーは、このアプリからの利用が許可されていません（キーの「ウェブサイトの制限」を確認してください）';
  if (/not been used|disabled|ApiNotActivated|PERMISSION_DENIED/i.test(m)) return 'Google Cloud で「Places API (New)」と「Maps JavaScript API」が有効になっていません';
  if (/BILLING|billing/.test(m)) return 'Google Cloud でお支払い（請求先アカウント）が設定されていません';
  if (/QUOTA|RESOURCE_EXHAUSTED|OVER_QUERY_LIMIT/i.test(m)) return '今日の検索回数の上限に達しました。明日また使えます';
  return m;
}

export async function searchPlaces(key, query) {
  try {
    return await doSearch(key, query);
  } catch (err) {
    throw new Error(friendly(err));
  }
}

async function doSearch(key, query) {
  await loadMaps(key);
  const { Place } = await google.maps.importLibrary('places');
  const { places } = await Place.searchByText({
    textQuery: query,
    fields: ['displayName', 'formattedAddress', 'websiteURI', 'nationalPhoneNumber', 'googleMapsURI'],
    language: 'ja',
    region: 'jp',
    maxResultCount: 6,
  });
  return (places || []).map((p) => ({
    name: p.displayName || '',
    address: (p.formattedAddress || '').replace(/^日本、?\s*/, ''),
    url: p.websiteURI || '',
    phone: p.nationalPhoneNumber || '',
    mapUrl: p.googleMapsURI || '',
  }));
}
