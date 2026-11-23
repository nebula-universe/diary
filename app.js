'use strict';
/* =========================================================
 * 照片日記 — 所有資料只存在這部手機的瀏覽器 (IndexedDB) 裡
 * ========================================================= */

const MOODS = [
  { id: 'happy', emoji: '😄', label: '開心' },
  { id: 'calm',  emoji: '😌', label: '平靜' },
  { id: 'meh',   emoji: '😐', label: '普通' },
  { id: 'sad',   emoji: '😢', label: '難過' },
  { id: 'angry', emoji: '😠', label: '生氣' },
  { id: 'tired', emoji: '😴', label: '好累' },
];
const moodOf = id => MOODS.find(m => m.id === id);

const PHOTO_MAX = 1920;   // 照片最長邊（像素），壓縮以節省空間
const PHOTO_Q = 0.85;
const THUMB_MAX = 400;
const THUMB_Q = 0.75;
const BACKUP_REMIND_DAYS = 30;

const MONTH_EN = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const MON_EN = MONTH_EN.map(m => m.slice(0, 3));
const WEEK_EN = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const WK_EN = WEEK_EN.map(w => w.slice(0, 3));
const WEEK = '日一二三四五六';

const svg = d => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
const ICON = {
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};

const app = document.getElementById('app');

/* ---------------- IndexedDB ---------------- */
const DB_NAME = 'photo-diary';
const STORE = 'entries';
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('資料庫開啟逾時，請把 App 完全關閉後再打開')), 10000);
      const req = indexedDB.open(DB_NAME, 1);
      req.onblocked = () => reject(new Error('資料庫被另一個視窗占用，請關閉其他開著日記的分頁或視窗'));
      req.addEventListener('success', () => clearTimeout(timer));
      req.addEventListener('error', () => clearTimeout(timer));
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('date', 'date');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const dbGetAll = () => withStore('readonly', s => s.getAll());
const dbPut = e => withStore('readwrite', s => s.put(e));
const dbDelete = id => withStore('readwrite', s => s.delete(id));

let entries = null; // 記憶體快取，已排序（新到舊）

async function loadAll() {
  entries = (await dbGetAll()) || [];
  sortEntries();
}
function sortEntries() {
  entries.sort((a, b) => (b.date.localeCompare(a.date)) || (b.createdAt - a.createdAt));
}

/* ---------------- 小工具 ---------------- */
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => fmtDate(new Date());
function parts(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d, wd: new Date(y, m - 1, d).getDay() };
}
function prettyDate(s) {
  const { y, m, d, wd } = parts(s);
  return `${y}年${m}月${d}日（${WEEK[wd]}）`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// 圖片網址管理（切換畫面時釋放記憶體）
let objUrls = [];
function blobUrl(blob) {
  const u = URL.createObjectURL(blob);
  objUrls.push(u);
  return u;
}
function freeUrls() {
  objUrls.forEach(u => URL.revokeObjectURL(u));
  objUrls = [];
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = true; void el.offsetWidth; el.hidden = false; // 重播動畫
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

function showSaved() {
  const el = document.createElement('div');
  el.className = 'saved-mark';
  el.innerHTML = `<div>${ICON.check}</div>`;
  document.body.appendChild(el);
  if (navigator.vibrate) navigator.vibrate(12);
  setTimeout(() => el.remove(), 800);
}

/* ---------------- 照片處理 ---------------- */
async function loadImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { /* fallback */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const u = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('無法讀取這張圖片')); };
    img.src = u;
  });
}
function resizeTo(src, max, quality) {
  const w = src.naturalWidth || src.width;
  const h = src.naturalHeight || src.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) =>
    c.toBlob(b => (b ? resolve(b) : reject(new Error('照片壓縮失敗'))), 'image/jpeg', quality));
}
async function processPhoto(file) {
  const img = await loadImage(file);
  const blob = await resizeTo(img, PHOTO_MAX, PHOTO_Q);
  const thumb = await resizeTo(img, THUMB_MAX, THUMB_Q);
  if (img.close) img.close();
  return { id: uid(), blob, thumb, caption: '' };
}

/* ---------------- 路由 ---------------- */
let leaveGuard = null;      // 編輯中離開前的確認
let currentHash = location.hash;

window.addEventListener('hashchange', () => {
  if (leaveGuard && !leaveGuard()) {
    history.pushState(null, '', currentHash || '#/');
    return;
  }
  route();
});

// 發生錯誤時直接顯示在畫面上，而不是停在空白頁
function showFatal(err) {
  console.error(err);
  document.body.classList.remove('editing');
  app.className = '';
  app.innerHTML = `<div class="empty">
    <div class="big">出了點問題</div>
    <p>請把 App 完全關閉（從最近使用的 App 中滑掉）後再打開。<br>如果還是不行，請把下面這行文字截圖給我。</p>
    <p class="small" style="word-break:break-all;color:var(--danger)">${esc((err && (err.message || err.name)) || err)}</p>
    <button class="btn" onclick="location.reload()">重新載入</button>
  </div>`;
}
window.addEventListener('error', ev => { if (!app.querySelector('.story, .cal-grid, .field, .stat')) showFatal(ev.error || ev.message); });
window.addEventListener('unhandledrejection', ev => { if (!entries) showFatal(ev.reason); });

async function route() {
  try { await routeInner(); } catch (err) { showFatal(err); }
}

async function routeInner() {
  leaveGuard = null;
  currentHash = location.hash;
  freeUrls();
  closeLightbox(true);
  document.body.classList.remove('editing');
  if (!entries) await loadAll();

  const h = location.hash.slice(1) || '/';
  const [path, query] = h.split('?');
  const segs = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query || '');
  const page = segs[0] || 'list';

  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === page));
  window.scrollTo(0, 0);
  app.className = '';
  void app.offsetWidth;
  app.className = 'enter';

  switch (page) {
    case 'calendar': return renderCalendar(params);
    case 'new': return renderEditor(null, params.get('date'));
    case 'edit': return renderEditor(segs[1]);
    case 'entry': return renderEntry(segs[1]);
    case 'settings': return renderSettings();
    default: return renderList();
  }
}

function goBack() {
  if (history.length > 1) history.back();
  else location.hash = '#/';
}

/* ---------------- 日記大卡片 ---------------- */
function storyHTML(e, i = 0, label = '') {
  const { y, m, d, wd } = parts(e.date);
  const mood = moodOf(e.mood);
  const cover = e.photos[0];
  const excerpt = e.text.trim() || e.photos.map(p => p.caption).find(Boolean) || '';
  const thisYear = new Date().getFullYear();
  return `
    <a class="story ${cover ? '' : 'textonly'} ${label ? 'memory' : ''}" style="--i:${Math.min(i, 6)}" href="#/entry/${e.id}">
      ${label ? `<div class="kicker memory-label">${label}</div>` : ''}
      ${cover ? `<div class="cover">
          <img class="loading" loading="lazy" decoding="async" src="${blobUrl(cover.blob)}" onload="this.classList.remove('loading')" alt="">
          ${e.photos.length > 1 ? `<span class="count">${e.photos.length} 張</span>` : ''}
        </div>` : ''}
      <div class="dateline">
        <span class="day">${d}</span>
        <span class="kicker">${MON_EN[m - 1]} · ${WK_EN[wd]}${y !== thisYear ? ` · ${y}` : ''}</span>
        ${mood ? `<span class="mood-tag">${mood.label}</span>` : ''}
      </div>
      ${excerpt ? `<hr class="rule"><div class="excerpt">${esc(excerpt)}</div>` : ''}
    </a>`;
}

/* ---------------- 日記列表 ---------------- */
const listState = { q: '', mood: '' };

function matches(e) {
  if (listState.mood && e.mood !== listState.mood) return false;
  const q = listState.q.trim().toLowerCase();
  if (!q) return true;
  if (e.text.toLowerCase().includes(q)) return true;
  return e.photos.some(p => (p.caption || '').toLowerCase().includes(q));
}

function renderList() {
  const lastBackup = Number(localStorage.getItem('lastBackup') || 0);
  const needBackup = entries.length > 0 && (Date.now() - lastBackup) > BACKUP_REMIND_DAYS * 864e5;
  const now = new Date();
  const t = todayStr();
  const memories = entries.filter(e => e.date.slice(5) === t.slice(5) && e.date < t);

  app.innerHTML = `
    <header class="masthead">
      <div class="kicker">${WEEK_EN[now.getDay()]}, ${MONTH_EN[now.getMonth()]} ${now.getDate()}</div>
      <h1>我的日記</h1>
    </header>
    ${needBackup ? `<div class="banner"><div class="spacer">${lastBackup ? '已經一段時間沒有備份了' : '還沒有備份過'}，記得備份，以免換手機時資料遺失。</div><a href="#/settings">去備份</a></div>` : ''}
    <div class="search-wrap">${ICON.search}<input class="search" type="search" placeholder="搜尋文字或照片註解" value="${esc(listState.q)}"></div>
    <div class="chips">
      <button class="chip ${listState.mood ? '' : 'on'}" data-mood="">全部</button>
      ${MOODS.map(m => `<button class="chip ${listState.mood === m.id ? 'on' : ''}" data-mood="${m.id}">${m.label}</button>`).join('')}
    </div>
    <div id="list"></div>`;

  const listEl = app.querySelector('#list');
  const draw = () => {
    freeUrls();
    if (!entries.length) {
      listEl.innerHTML = `<div class="empty"><div class="big">第一頁，還是空白的</div><p>按下方的 ＋，記下今天的照片與心情。</p></div>`;
      return;
    }
    const filtered = entries.filter(matches);
    const filtering = listState.q.trim() || listState.mood;
    let html = '';
    let i = 0;
    if (!filtering && memories.length) {
      html += memories.map(e => storyHTML(e, i++, `On this day · ${now.getFullYear() - parts(e.date).y} 年前的今天`)).join('');
    }
    if (!filtered.length) {
      html += `<div class="empty"><div class="big">沒有找到</div><p>換個關鍵字或心情試試看。</p></div>`;
    } else {
      let lastMonth = '';
      for (const e of filtered) {
        const ym = e.date.slice(0, 7);
        if (ym !== lastMonth) {
          const { y, m } = parts(e.date);
          html += `<div class="month-head"><span class="kicker">${MONTH_EN[m - 1]} ${y}</span></div>`;
          lastMonth = ym;
        }
        html += storyHTML(e, i++);
      }
    }
    listEl.innerHTML = html;
  };
  draw();

  app.querySelector('.search').addEventListener('input', ev => { listState.q = ev.target.value; draw(); });
  app.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => {
    listState.mood = btn.dataset.mood;
    app.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b === btn));
    draw();
  }));
}

/* ---------------- 月曆 ---------------- */
const calState = { y: null, m: null, sel: null };

function renderCalendar() {
  const now = new Date();
  if (calState.y === null) { calState.y = now.getFullYear(); calState.m = now.getMonth(); }
  const { y, m } = calState;
  const today = todayStr();
  const monthPrefix = `${y}-${pad(m + 1)}`;
  if (!calState.sel || !calState.sel.startsWith(monthPrefix)) {
    calState.sel = today.startsWith(monthPrefix) ? today : null;
  }

  const byDate = {};
  for (const e of entries) {
    if (e.date.startsWith(monthPrefix)) (byDate[e.date] ||= []).push(e);
  }
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const count = Object.values(byDate).reduce((n, a) => n + a.length, 0);

  let cells = WEEK.split('').map(w => `<div class="wd">${w}</div>`).join('');
  for (let i = 0; i < first; i++) cells += `<div class="dayc blank"></div>`;
  for (let d = 1; d <= days; d++) {
    const ds = `${monthPrefix}-${pad(d)}`;
    const list = (byDate[ds] || []).slice().reverse(); // 當天最早的在前
    const photo = list.flatMap(e => e.photos)[0];
    const cls = ['dayc', photo ? 'has-photo' : '', ds === today ? 'today' : '', ds === calState.sel ? 'sel' : '', ds > today ? 'future' : ''].join(' ');
    cells += `<button class="${cls}" data-date="${ds}">
      ${photo ? `<img class="bgimg" src="${blobUrl(photo.thumb)}" alt="">` : ''}
      <span class="n">${d}</span>
      ${list.length && !photo ? `<span class="dot"></span>` : ''}
    </button>`;
  }

  app.innerHTML = `
    <div class="cal-head">
      <button class="iconbtn" data-nav="-1" aria-label="上個月">${ICON.back}</button>
      <div class="t"><span class="kicker y">${MONTH_EN[m]} ${y}</span><span class="m">${y}年${m + 1}月</span></div>
      <button class="iconbtn" data-nav="1" aria-label="下個月">${ICON.next}</button>
    </div>
    <div class="cal-grid">${cells}</div>
    <p class="kicker cal-count">${count} 篇日記</p>
    <div id="day-detail"></div>`;

  const detail = app.querySelector('#day-detail');
  const showDay = () => {
    const ds = calState.sel;
    if (!ds) { detail.innerHTML = ''; return; }
    const list = byDate[ds] || [];
    detail.innerHTML = `<div class="day-detail">
      ${list.map((e, i) => storyHTML(e, i)).join('') || `<p class="muted" style="text-align:center;font-family:var(--serif)">${prettyDate(ds)}，沒有日記</p>`}
      <a class="btn ghost block" href="#/new?date=${ds}">寫這天的日記</a></div>`;
  };
  showDay();

  app.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
    calState.m += Number(b.dataset.nav);
    if (calState.m < 0) { calState.m = 11; calState.y--; }
    if (calState.m > 11) { calState.m = 0; calState.y++; }
    route();
  }));
  app.querySelectorAll('.dayc[data-date]').forEach(b => b.addEventListener('click', () => {
    calState.sel = b.dataset.date;
    app.querySelectorAll('.dayc.sel').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    showDay();
  }));
}

/* ---------------- 單篇檢視 ---------------- */
function renderEntry(id) {
  const e = entries.find(x => x.id === id);
  if (!e) { app.innerHTML = `<div class="empty"><div class="big">找不到這篇日記</div><a class="btn" href="#/">回到日記</a></div>`; return; }
  app.classList.add('entry-page');
  const mood = moodOf(e.mood);
  const { y, m, d, wd } = parts(e.date);
  const urls = e.photos.map(p => blobUrl(p.blob));
  const n = e.photos.length;

  app.innerHTML = `
    <div class="entry-top">
      <button class="iconbtn" id="back" aria-label="返回">${ICON.back}</button>
      <a class="iconbtn" href="#/edit/${e.id}" aria-label="編輯">${ICON.edit}</a>
    </div>
    ${n ? `
      <div class="carousel-wrap"><div class="carousel">
        ${urls.map((u, i) => `<div class="slide" data-i="${i}"><img src="${u}" alt="${esc(e.photos[i].caption)}"></div>`).join('')}
      </div></div>
      ${n > 1 ? `<div class="carousel-meta"><div class="dots">${urls.map((_, i) => `<span class="${i ? '' : 'on'}"></span>`).join('')}</div><span class="counter">1 / ${n}</span></div>` : ''}
      <p class="caption">${esc(e.photos[0].caption)}</p>` : ''}
    <div class="entry-date">
      <div class="kicker">${MONTH_EN[m - 1]} ${y} · ${WEEK_EN[wd]}</div>
      <div class="big">${d}</div>
    </div>
    ${mood ? `<div class="kicker" style="margin-top:10px;color:var(--text-2)">${mood.emoji}　${mood.label}</div>` : ''}
    <hr class="rule">
    ${e.text.trim() ? `<div class="entry-text">${esc(e.text)}</div>` : ''}
    <div class="entry-foot">最後修改　${new Date(e.updatedAt).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })}</div>`;

  app.querySelector('#back').addEventListener('click', goBack);

  const car = app.querySelector('.carousel');
  if (car) {
    const dots = [...app.querySelectorAll('.dots span')];
    const counter = app.querySelector('.counter');
    const cap = app.querySelector('.caption');
    let cur = 0;
    car.addEventListener('scroll', () => {
      const i = Math.round(car.scrollLeft / car.clientWidth);
      if (i === cur || i < 0 || i >= n) return;
      cur = i;
      dots.forEach((s, k) => s.classList.toggle('on', k === i));
      if (counter) counter.textContent = `${i + 1} / ${n}`;
      cap.style.opacity = 0;
      setTimeout(() => { cap.textContent = e.photos[i].caption || ''; cap.style.opacity = 1; }, 120);
    }, { passive: true });
    car.querySelectorAll('.slide').forEach(s => s.addEventListener('click', () => {
      openLightbox(urls, e.photos.map(p => p.caption), Number(s.dataset.i));
    }));
  }
}

/* ---------------- 全螢幕看照片（可左右滑） ---------------- */
const lightbox = document.getElementById('lightbox');
const lbTrack = lightbox.querySelector('.lb-track');
const lbCount = lightbox.querySelector('.lb-count');

function openLightbox(urls, captions, start) {
  lbTrack.innerHTML = urls.map((u, i) => `
    <div class="lb-slide"><img src="${u}" alt="">${captions[i] ? `<p>${esc(captions[i])}</p>` : ''}</div>`).join('');
  lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
  lbTrack.scrollLeft = start * lbTrack.clientWidth;
  const update = () => { lbCount.textContent = urls.length > 1 ? `${Math.round(lbTrack.scrollLeft / lbTrack.clientWidth) + 1} / ${urls.length}` : ''; };
  lbTrack.onscroll = update;
  update();
  history.pushState({ lightbox: true }, '');   // 讓手機「返回鍵」可以關閉
}
function closeLightbox(silent) {
  if (lightbox.hidden) return;
  lightbox.hidden = true;
  document.body.style.overflow = '';
  lbTrack.innerHTML = '';
  if (!silent && history.state && history.state.lightbox) history.back();
}
window.addEventListener('popstate', () => { if (!lightbox.hidden) closeLightbox(true); });
lightbox.querySelector('.lb-close').addEventListener('click', ev => { ev.stopPropagation(); closeLightbox(); });
lbTrack.addEventListener('click', () => closeLightbox());

/* ---------------- 編輯 / 新增 ---------------- */
function renderEditor(id, presetDate) {
  const existing = id ? entries.find(x => x.id === id) : null;
  if (id && !existing) { app.innerHTML = `<div class="empty"><div class="big">找不到這篇日記</div></div>`; return; }
  document.body.classList.add('editing');

  const draft = existing
    ? { ...existing, photos: existing.photos.map(p => ({ ...p })) }
    : { id: uid(), date: presetDate || todayStr(), mood: '', text: '', photos: [], createdAt: Date.now() };
  let dirty = false;
  let busy = 0;
  const markDirty = () => { dirty = true; };
  leaveGuard = () => !dirty || confirm('還沒有儲存，確定要離開嗎？');

  app.innerHTML = `
    <div class="topbar">
      <button class="iconbtn" id="cancel" aria-label="取消">${ICON.close}</button>
      <div class="title">${existing ? '編輯日記' : '新的一頁'}</div>
      <span style="width:44px"></span>
    </div>
    <div class="field">
      <label class="lbl kicker" for="date">日期 · Date</label>
      <input class="input" type="date" id="date" value="${draft.date}">
    </div>
    <div class="field">
      <span class="lbl kicker">心情 · Mood</span>
      <div class="moods">${MOODS.map(m => `
        <button type="button" class="mood-btn ${draft.mood === m.id ? 'on' : ''}" data-mood="${m.id}">
          <span class="e">${m.emoji}</span>${m.label}</button>`).join('')}</div>
    </div>
    <div class="field">
      <label class="lbl kicker" for="text">發生了什麼事 · Notes</label>
      <textarea class="textarea" id="text" placeholder="寫下今天開心或不開心的事…">${esc(draft.text)}</textarea>
    </div>
    <div class="field">
      <span class="lbl kicker">照片 · Photos</span>
      <div id="photos"></div>
      <label class="add-photo">${ICON.camera} 加入照片（可多選）
        <input type="file" id="file" accept="image/*" multiple>
      </label>
      <p class="muted small" id="busy" hidden>正在處理照片…</p>
    </div>
    ${existing ? `<button class="btn danger block" id="delete" type="button">刪除這篇日記</button>` : ''}
    <div class="save-bar"><div class="inner">
      <button class="btn primary" id="save" type="button">儲存</button>
    </div></div>`;

  const photosEl = app.querySelector('#photos');
  const busyEl = app.querySelector('#busy');
  const saveBtn = app.querySelector('#save');

  const drawPhotos = () => {
    photosEl.innerHTML = draft.photos.map((p, i) => `
      <div class="photo-edit" data-i="${i}">
        <div class="pv"><img src="${blobUrl(p.thumb)}" alt=""></div>
        <div class="ctl">
          <textarea class="textarea" data-cap="${i}" placeholder="照片註解（可留空）" rows="2">${esc(p.caption)}</textarea>
          <div class="ops">
            <button type="button" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="往前">↑</button>
            <button type="button" data-down="${i}" ${i === draft.photos.length - 1 ? 'disabled' : ''} aria-label="往後">↓</button>
            <button type="button" class="rm" data-rm="${i}">移除</button>
          </div>
        </div>
      </div>`).join('');
    photosEl.querySelectorAll('[data-cap]').forEach(t => t.addEventListener('input', () => {
      draft.photos[Number(t.dataset.cap)].caption = t.value; markDirty();
    }));
    const move = (i, j) => { [draft.photos[i], draft.photos[j]] = [draft.photos[j], draft.photos[i]]; markDirty(); drawPhotos(); };
    photosEl.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.up); move(i, i - 1); }));
    photosEl.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.down); move(i, i + 1); }));
    photosEl.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('移除這張照片？')) return;
      draft.photos.splice(Number(b.dataset.rm), 1); markDirty(); drawPhotos();
    }));
  };
  drawPhotos();

  app.querySelector('#date').addEventListener('change', ev => { draft.date = ev.target.value || draft.date; markDirty(); });
  app.querySelector('#text').addEventListener('input', ev => { draft.text = ev.target.value; markDirty(); });
  app.querySelectorAll('.mood-btn').forEach(b => b.addEventListener('click', () => {
    draft.mood = draft.mood === b.dataset.mood ? '' : b.dataset.mood;
    app.querySelectorAll('.mood-btn').forEach(x => x.classList.toggle('on', x.dataset.mood === draft.mood));
    if (navigator.vibrate) navigator.vibrate(8);
    markDirty();
  }));

  app.querySelector('#file').addEventListener('change', async ev => {
    const files = [...ev.target.files];
    ev.target.value = '';
    if (!files.length) return;
    busy++; busyEl.hidden = false; saveBtn.disabled = true;
    let failed = 0;
    for (const f of files) {
      try { draft.photos.push(await processPhoto(f)); markDirty(); drawPhotos(); }
      catch (err) { console.error(err); failed++; }
    }
    busy--; if (!busy) { busyEl.hidden = true; saveBtn.disabled = false; }
    if (failed) toast(`有 ${failed} 張照片無法讀取`);
  });

  app.querySelector('#cancel').addEventListener('click', () => {
    if (dirty && !confirm('還沒有儲存，確定要離開嗎？')) return;
    dirty = false;
    goBack();
  });

  saveBtn.addEventListener('click', async () => {
    if (busy) return;
    if (!draft.text.trim() && !draft.photos.length && !draft.mood) {
      toast('寫點文字、選個心情或加張照片吧');
      return;
    }
    saveBtn.disabled = true;
    draft.updatedAt = Date.now();
    const record = {
      id: draft.id, date: draft.date, mood: draft.mood, text: draft.text,
      photos: draft.photos.map(p => ({ id: p.id, blob: p.blob, thumb: p.thumb, caption: p.caption || '' })),
      createdAt: draft.createdAt, updatedAt: draft.updatedAt,
    };
    try {
      await dbPut(record);
    } catch (err) {
      console.error(err);
      saveBtn.disabled = false;
      alert('儲存失敗：' + (err && err.name === 'QuotaExceededError' ? '手機儲存空間不足' : (err && err.message) || err));
      return;
    }
    const idx = entries.findIndex(x => x.id === record.id);
    if (idx >= 0) entries[idx] = record; else entries.push(record);
    sortEntries();
    requestPersist();
    dirty = false;
    showSaved();
    location.replace(`#/entry/${record.id}`);
  });

  const del = app.querySelector('#delete');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('確定要刪除這篇日記嗎？刪除後無法復原。')) return;
    await dbDelete(draft.id);
    entries = entries.filter(x => x.id !== draft.id);
    dirty = false;
    toast('已刪除');
    location.replace('#/');
  });
}

/* ---------------- 設定 / 備份 ---------------- */
async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (_) { /* ignore */ }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}

async function buildBackup() {
  const out = [`{"app":"photo-diary","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"entries":[`];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const photos = [];
    for (const p of e.photos) {
      photos.push({ id: p.id, caption: p.caption, image: await blobToDataURL(p.blob), thumb: await blobToDataURL(p.thumb) });
    }
    out.push((i ? ',' : '') + JSON.stringify({ ...e, photos }));
  }
  out.push(']}');
  return new Blob(out, { type: 'application/json' });
}

function fmtBytes(n) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

async function renderSettings() {
  const photoCount = entries.reduce((n, e) => n + e.photos.length, 0);
  const lastBackup = Number(localStorage.getItem('lastBackup') || 0);
  const canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.json', { type: 'application/json' })] }));

  app.innerHTML = `
    <header class="masthead"><div class="kicker">Settings</div><h1>設定</h1></header>
    <div>
      <div class="stat"><span>日記篇數</span><b>${entries.length}</b></div>
      <div class="stat"><span>照片張數</span><b>${photoCount}</b></div>
      <div class="stat"><span>已使用空間</span><b id="usage">…</b></div>
      <div class="stat"><span>上次備份</span><b>${lastBackup ? new Date(lastBackup).toLocaleDateString('zh-TW') : '從未備份'}</b></div>
    </div>

    <section class="section">
      <div class="kicker">Backup</div><h2>備份</h2>
      <p>日記只存在這部手機的瀏覽器裡。建議每個月備份一次，把備份檔存到 Google 雲端硬碟，換手機時就能還原。</p>
      <div class="stack">
        ${canShareFiles ? `<button class="btn primary block" id="share">備份並存到雲端硬碟</button>` : ''}
        <button class="btn ${canShareFiles ? '' : 'primary'} block" id="download">下載備份檔</button>
      </div>
      <p class="small" id="bk-status" style="margin-top:10px" hidden></p>
    </section>

    <section class="section">
      <div class="kicker">Restore</div><h2>還原</h2>
      <p>選擇之前的備份檔（.json）。相同的日記會被覆蓋，其他日記會保留。</p>
      <label class="btn block">選擇備份檔<input type="file" id="import" accept=".json,application/json" hidden></label>
    </section>

    <section class="section">
      <div class="kicker">About</div><h2>關於</h2>
      <p>照片日記 v3　·　所有資料只存在這部手機，不會上傳到任何地方。</p>
      <p id="persist"></p>
    </section>`;

  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(({ usage }) => { app.querySelector('#usage').textContent = fmtBytes(usage || 0); }).catch(() => {});
  } else app.querySelector('#usage').textContent = '—';
  const persistEl = app.querySelector('#persist');
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then(p => {
      persistEl.textContent = p
        ? '已啟用「永久保存」：手機空間不足時，系統不會自動清掉日記。'
        : '尚未啟用永久保存。把網頁「安裝 / 加到主畫面」後通常會自動啟用。';
    });
  }

  const status = app.querySelector('#bk-status');
  const fileName = `diary-backup-${todayStr()}.json`;
  async function makeBackup() {
    status.hidden = false;
    status.textContent = '正在準備備份檔…';
    const blob = await buildBackup();
    status.textContent = `備份檔大小：${fmtBytes(blob.size)}`;
    return blob;
  }
  const markBackedUp = () => localStorage.setItem('lastBackup', String(Date.now()));

  const shareBtn = app.querySelector('#share');
  if (shareBtn) shareBtn.addEventListener('click', async () => {
    shareBtn.disabled = true;
    try {
      const blob = await makeBackup();
      const file = new File([blob], fileName, { type: 'application/json' });
      await navigator.share({ files: [file], title: '照片日記備份' });
      markBackedUp();
      toast('備份完成');
    } catch (err) {
      if (err && err.name !== 'AbortError') { console.error(err); toast('分享失敗，請改用「下載備份檔」'); }
    } finally { shareBtn.disabled = false; }
  });

  const dlBtn = app.querySelector('#download');
  dlBtn.addEventListener('click', async () => {
    dlBtn.disabled = true;
    try {
      const blob = await makeBackup();
      const a = document.createElement('a');
      const u = URL.createObjectURL(blob);
      a.href = u; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
      markBackedUp();
      toast('已下載備份檔');
    } catch (err) { console.error(err); toast('備份失敗'); }
    finally { dlBtn.disabled = false; }
  });

  app.querySelector('#import').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'photo-diary' || !Array.isArray(data.entries)) throw new Error('這不是照片日記的備份檔');
      if (!confirm(`備份檔裡有 ${data.entries.length} 篇日記，要匯入嗎？`)) return;
      toast('匯入中…');
      let n = 0;
      for (const e of data.entries) {
        const photos = [];
        for (const p of e.photos || []) {
          photos.push({ id: p.id || uid(), caption: p.caption || '', blob: await dataURLToBlob(p.image), thumb: await dataURLToBlob(p.thumb || p.image) });
        }
        await dbPut({
          id: e.id || uid(), date: e.date, mood: e.mood || '', text: e.text || '', photos,
          createdAt: e.createdAt || Date.now(), updatedAt: e.updatedAt || Date.now(),
        });
        n++;
      }
      await loadAll();
      requestPersist();
      toast(`已匯入 ${n} 篇日記`);
      renderSettings();
    } catch (err) {
      console.error(err);
      alert('匯入失敗：' + (err.message || err));
    }
  });
}

/* ---------------- 啟動 ---------------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.error));
}
route();
