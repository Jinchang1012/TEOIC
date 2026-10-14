/* 語言模組登錄表（殼層 index.html 載入；單純資料）。
 * 新增語言 = 新增一個資料夾 modules/<id>/index.html ＋ 在此加一筆。
 * 並請在 sw.js 的 PRECACHE_URLS 與 fetch fallback 補上該模組路徑。 */
window.LANG_MODULES = [
  { id:'en', name:'英文', subtitle:'多益 850 訓練場', flag:'EN', path:'modules/en/index.html', storeKey:'toeic850_v1', accent:'#2f5d50' },
  { id:'fr', name:'法文', subtitle:'法文訓練場', flag:'FR', path:'modules/fr/index.html', storeKey:'francais_v1', accent:'#3b4f8c' },
];
