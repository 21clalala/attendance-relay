// 출결 연락 패널 — Apps Script(수신로그 시트)에서 날짜별 연락을 불러와 학생별로 보여 준다.
// 메시지 내용은 화면에만 표시하고 확장 프로그램 저장소에는 URL·비밀키만 저장한다.

const TYPES = ['결석', '지각', '조퇴', '결과', '확인필요', '해당없음'];
const REFRESH_MS = 60 * 1000;

const state = { url: '', secret: '', date: todayStr(), items: [], loading: false, lastLoaded: null };
const $ = (id) => document.getElementById(id);

/* ---------- 날짜 ---------- */

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function shift(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(y, m - 1, d + days);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
function label(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const w = '일월화수목금토'[new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${w})` + (dateStr === todayStr() ? ' · 오늘' : '');
}

/* ---------- 통신 ---------- */

async function api(params) {
  const body = new URLSearchParams({ secret: state.secret, ...params });
  const res = await fetch(state.url, { method: 'POST', body });
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); } catch (_) {
    throw new Error(res.status === 200 ? '응답 형식 오류 (웹 앱 배포 설정 확인)' : `HTTP ${res.status}`);
  }
  if (!j.ok) throw new Error(j.error === 'auth' ? '비밀키가 맞지 않습니다' : (j.error || '알 수 없는 오류'));
  return j;
}

async function load(quiet) {
  if (!state.url || !state.secret) { showSettings(true); render(); return; }
  if (state.loading) return;
  state.loading = true;
  if (!quiet) setStatus('불러오는 중…');
  try {
    const j = await api({ action: 'list', date: state.date });
    state.items = j.items || [];
    state.lastLoaded = new Date();
    setStatus('');
  } catch (e) {
    setStatus('불러오지 못했습니다: ' + e.message, true);
  } finally {
    state.loading = false;
    render();
  }
}

async function setChecked(group, value) {
  const ids = group.items.map((i) => i.id).filter(Boolean);
  group.items.forEach((i) => { i.checked = value; }); // 화면 먼저 반영
  render();
  try {
    await api({ action: 'check', ids: ids.join(','), value: String(value) });
  } catch (e) {
    group.items.forEach((i) => { i.checked = !value; });
    render();
    setStatus('체크 저장 실패: ' + e.message, true);
  }
}

/* ---------- 화면 ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // 메시지 내용은 항상 textContent로 (HTML 해석 금지)
  return n;
}

function groups() {
  const map = new Map();
  for (const it of state.items) {
    const k = `${it.no}|${it.name}`;
    if (!map.has(k)) map.set(k, { no: it.no, name: it.name, items: [] });
    map.get(k).items.push(it);
  }
  const arr = [...map.values()];
  for (const g of arr) {
    g.items.sort((a, b) => a.time.localeCompare(b.time));
    // 담임이 폰에서 지정한 값이 있으면 그것만, 없으면 자동 추정값
    const confirmed = g.items.filter((i) => i.ctype);
    g.confirmed = confirmed.length > 0;
    if (g.confirmed) {
      g.types = [...new Set(confirmed.map((i) => i.ctype))];
      g.reasons = [...new Set(confirmed.map((i) => i.creason).filter(Boolean))];
    } else {
      g.types = [...new Set(g.items.map((i) => i.type).filter((t) => t && t !== '확인필요'))];
      if (!g.types.length) g.types = ['확인필요'];
      g.reasons = [...new Set(g.items.map((i) => i.reason).filter(Boolean))];
    }
    g.memos = [...new Set(g.items.flatMap((i) => String(i.memo || '').split(', ')).filter(Boolean))];
    g.done = g.items.every((i) => i.checked);
  }
  // 입력 안 한 학생 먼저, 그다음 번호순
  arr.sort((a, b) => (a.done - b.done) || (a.no - b.no));
  return arr;
}

function render() {
  $('dateLabel').textContent = label(state.date);
  $('next').disabled = state.date >= todayStr();

  const gs = groups();
  const list = $('list');
  list.replaceChildren();

  // 요약
  const summary = $('summary');
  summary.replaceChildren();
  const pending = gs.filter((g) => !g.done);
  if (gs.length) {
    const counts = {};
    for (const g of pending) for (const t of g.types) counts[t] = (counts[t] || 0) + 1;
    summary.append(el('span', 'sum-main', pending.length ? `미입력 ${pending.length}명` : '모두 입력 완료'));
    for (const t of TYPES) if (counts[t]) summary.append(el('span', `chip t-${t}`, `${t} ${counts[t]}`));
    if (gs.length - pending.length) summary.append(el('span', 'sum-done', `완료 ${gs.length - pending.length}`));
  }

  if (!gs.length && state.url && !state.loading) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'empty-title', '받은 출결 연락이 없습니다'));
    empty.append(el('div', 'muted', state.date === todayStr() ? '새 연락이 오면 1분 안에 표시됩니다.' : ''));
    list.append(empty);
  }

  for (const g of gs) list.append(card(g));

  $('foot').textContent = state.lastLoaded
    ? `마지막 갱신 ${pad(state.lastLoaded.getHours())}:${pad(state.lastLoaded.getMinutes())}` +
      (state.date === todayStr() ? ' · 1분마다 자동 갱신' : '')
    : '';
}

function card(g) {
  const c = el('article', 'card' + (g.done ? ' done' : ''));

  const head = el('div', 'card-head');
  const who = el('div', 'who');
  who.append(el('span', 'no', String(g.no)), el('span', 'name', g.name));
  head.append(who);

  const chk = el('label', 'check');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = g.done;
  box.addEventListener('change', () => setChecked(g, box.checked));
  chk.append(box, el('span', '', '나이스 입력 완료'));
  head.append(chk);
  c.append(head);

  const tags = el('div', 'tags');
  for (const t of g.types) tags.append(el('span', `chip t-${t}` + (g.confirmed ? ' confirmed' : ''), g.confirmed ? `✔ ${t}` : t));
  for (const r of g.reasons) tags.append(el('span', 'chip reason' + (g.confirmed ? ' confirmed' : ''), r));
  if (!g.confirmed && g.types[0] !== '확인필요') tags.append(el('span', 'guess', '자동 추정'));
  for (const m of g.memos) tags.append(el('span', 'chip memo', m));
  c.append(tags);

  const msgs = el('ul', 'msgs');
  for (const it of g.items) {
    const li = el('li', 'msg');
    const meta = el('div', 'meta');
    meta.append(el('span', 'time', it.time), el('span', 'rel', it.rel), el('span', 'app', it.app));
    li.append(meta, el('div', 'text', it.text));
    msgs.append(li);
  }
  c.append(msgs);
  return c;
}

function setStatus(msg, isError) {
  const s = $('status');
  s.hidden = !msg;
  s.textContent = msg || '';
  s.classList.toggle('error', !!isError);
}

function showSettings(show) {
  $('settings').hidden = !show;
  $('url').value = state.url;
  $('secret').value = state.secret;
}

/* ---------- 이벤트 ---------- */

$('prev').addEventListener('click', () => { state.date = shift(state.date, -1); state.items = []; load(); });
$('next').addEventListener('click', () => { state.date = shift(state.date, 1); state.items = []; load(); });
$('dateLabel').addEventListener('click', () => { state.date = todayStr(); state.items = []; load(); });
$('refresh').addEventListener('click', () => load());
$('gear').addEventListener('click', () => showSettings($('settings').hidden));

$('save').addEventListener('click', async () => {
  const url = $('url').value.trim();
  const secret = $('secret').value.trim();
  const msg = $('settingsMsg');
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    msg.textContent = 'URL은 https://script.google.com/…/exec 형식이어야 합니다.';
    return;
  }
  if (!secret) { msg.textContent = '비밀키를 입력하세요.'; return; }
  state.url = url;
  state.secret = secret;
  msg.textContent = '연결 확인 중…';
  try {
    await api({ action: 'list', date: state.date });
    await chrome.storage.local.set({ url, secret });
    msg.textContent = '';
    showSettings(false);
    load();
  } catch (e) {
    msg.textContent = '연결 실패: ' + e.message;
  }
});

// 자정이 지나면 오늘 날짜를 따라가고, 패널이 보일 때만 1분마다 갱신
setInterval(() => {
  if (document.hidden) return;
  if (state.date === todayStr()) load(true);
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.date === todayStr()) load(true); });

chrome.storage.local.get(['url', 'secret']).then((v) => {
  state.url = v.url || '';
  state.secret = v.secret || '';
  load();
});
