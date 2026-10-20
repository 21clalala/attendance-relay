// 출결 연락 패널 — Apps Script(수신로그 시트)에서 날짜별 연락을 불러와 학생별로 보여 준다.
//  - 출결 관련 메시지는 학생 카드로, 무관해 보이는 대화는 맨 아래 '기타 대화'에 접어 둔다.
//  - 카드에서 유형·사유·적용 날짜·메모를 확정하거나 고칠 수 있다.
// 메시지 내용은 화면에만 표시하고, 확장 프로그램 저장소에는 URL·비밀키만 저장한다.

const TYPE_ORDER = ['결석', '지각', '조퇴', '결과', '확인필요'];
const EDIT_TYPES = ['결석', '지각', '조퇴', '결과'];
const EDIT_REASONS = [['질병', '질병'], ['미인정', '미인정'], ['기타', '기타'], ['출석인정', '출석인정'], ['', '미정']];
const REFRESH_MS = 60 * 1000;

const state = {
  url: '', secret: '', date: todayStr(),
  items: [], notices: [], roster: {},
  loading: false, lastLoaded: null,
  edit: null,            // 열려 있는 편집기 {key, mode:'card'|'other', type, reason, date, memo, saving}
  expanded: new Set(),   // '대화 더 보기'를 펼친 카드
  otherOpen: false,      // 기타 대화 펼침
};
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
function wday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return '일월화수목금토'[new Date(y, m - 1, d).getDay()];
}
function shortLabel(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}(${wday(dateStr)})`;
}
function label(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  const t = todayStr();
  const rel = dateStr === t ? ' · 오늘' : dateStr === shift(t, 1) ? ' · 내일' : dateStr === shift(t, -1) ? ' · 어제' : '';
  return `${m}월 ${d}일 (${wday(dateStr)})${rel}`;
}

/* ---------- 통신 ---------- */

async function api(params) {
  const body = new URLSearchParams({ secret: state.secret, ...params });
  const res = await fetch(state.url, { method: 'POST', body });
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); } catch (_) {
    throw new Error(res.status === 200 ? '응답 형식 오류 (Apps Script를 새 버전으로 배포했는지 확인)' : `HTTP ${res.status}`);
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
    state.notices = j.notices || [];
    state.roster = j.roster || state.roster;
    state.lastLoaded = new Date();
    if (!quiet) setStatus('');
  } catch (e) {
    setStatus('불러오지 못했습니다: ' + e.message, true);
  } finally {
    state.loading = false;
    render();
  }
}

function flash(msg) {
  setStatus(msg);
  setTimeout(() => { if ($('status').textContent === msg) setStatus(''); }, 3500);
}

async function setChecked(g, value) {
  const ids = g.att.map((i) => i.id);
  g.att.forEach((i) => { i.checked = value; }); // 화면 먼저 반영
  render();
  try {
    await api({ action: 'check', ids: ids.join(','), value: String(value) });
  } catch (e) {
    g.att.forEach((i) => { i.checked = !value; });
    render();
    setStatus('체크 저장 실패: ' + e.message, true);
  }
}

/* ---------- 묶기 ---------- */

function groups() {
  const map = new Map();
  for (const it of state.items) {
    const k = `${it.no}|${it.name}`;
    if (!map.has(k)) map.set(k, { key: k, no: it.no, name: it.name, items: [] });
    map.get(k).items.push(it);
  }
  const att = [];
  const other = [];
  for (const g of map.values()) {
    g.items.sort((a, b) => (a.recvDate + a.time).localeCompare(b.recvDate + b.time));
    g.att = g.items.filter((i) => i.att);       // 출결 관련
    g.chat = g.items.filter((i) => !i.att);     // 잡담·기타
    if (!g.att.length) { other.push(g); continue; }

    const confirmed = g.att.filter((i) => i.ctype);
    g.confirmed = confirmed.length > 0;
    if (g.confirmed) {
      g.types = uniq(confirmed.map((i) => i.ctype));
      g.reasons = uniq(confirmed.map((i) => i.creason).filter(Boolean));
    } else {
      g.types = uniq(g.att.map((i) => i.type).filter((t) => t && t !== '확인필요'));
      if (!g.types.length) g.types = ['확인필요'];
      g.reasons = uniq(g.att.map((i) => i.reason).filter(Boolean));
    }
    g.memos = uniq(g.att.flatMap((i) => String(i.memo || '').split(', ')).filter(Boolean));
    g.cmemos = uniq(g.att.map((i) => i.cmemo).filter(Boolean));
    g.recvOther = uniq(g.att.filter((i) => i.recvDate && i.recvDate !== state.date).map((i) => i.recvDate));
    g.done = g.att.every((i) => i.checked);
    att.push(g);
  }
  // 입력 안 한 학생 먼저, 그다음 번호순
  att.sort((a, b) => (a.done - b.done) || (a.no - b.no));
  other.sort((a, b) => a.no - b.no);
  return { att, other };
}

function uniq(a) { return [...new Set(a)]; }

/* ---------- 화면 ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // 메시지 내용은 항상 textContent로 (HTML 해석 금지)
  return n;
}

function button(text, cls, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function render() {
  $('dateLabel').textContent = label(state.date);
  $('addDate').textContent = '· ' + label(state.date);

  const { att, other } = groups();
  const list = $('list');
  list.replaceChildren();

  // 요약
  const summary = $('summary');
  summary.replaceChildren();
  const pending = att.filter((g) => !g.done);
  if (att.length) {
    const counts = {};
    for (const g of pending) for (const t of g.types) counts[t] = (counts[t] || 0) + 1;
    summary.append(el('span', 'sum-main', pending.length ? `미입력 ${pending.length}명` : '모두 입력 완료'));
    for (const t of TYPE_ORDER) if (counts[t]) summary.append(el('span', `chip t-${t}`, `${t} ${counts[t]}`));
    if (att.length - pending.length) summary.append(el('span', 'sum-done', `완료 ${att.length - pending.length}`));
  }

  // 다른 날짜로 넘어간 연락 (예: 오늘 받은 '내일 결석')
  if (state.notices.length) {
    const box = el('div', 'notices');
    box.append(el('div', 'notices-title', '다른 날짜로 넘어간 연락'));
    for (const n of state.notices) {
      const row = button('', 'notice', () => goDate(n.date));
      row.append(el('span', 'no', String(n.no)), el('span', 'name', n.name),
        el('span', 'arrow', `→ ${shortLabel(n.date)}`),
        el('span', `chip t-${n.type}`, n.type), el('span', 'muted', `${n.time} 받음`));
      box.append(row);
    }
    list.append(box);
  }

  if (!att.length && state.url && !state.loading) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'empty-title', '출결 연락이 없습니다'));
    empty.append(el('div', 'muted', state.date === todayStr() ? '새 연락이 오면 1분 안에 표시됩니다.' : ''));
    list.append(empty);
  }

  for (const g of att) list.append(card(g));

  if (other.length) list.append(otherSection(other));

  $('foot').textContent = state.lastLoaded
    ? `마지막 갱신 ${pad(state.lastLoaded.getHours())}:${pad(state.lastLoaded.getMinutes())}` +
      (state.date === todayStr() ? ' · 1분마다 자동 갱신' : '')
    : '';
}

function msgItem(it, extraCls) {
  const li = el('li', 'msg' + (extraCls ? ' ' + extraCls : ''));
  const meta = el('div', 'meta');
  const when = it.recvDate && it.recvDate !== state.date ? `${shortLabel(it.recvDate)} ${it.time}` : it.time;
  meta.append(el('span', 'time', when), el('span', 'rel', it.rel), el('span', 'app', it.app));
  li.append(meta, el('div', 'text', it.text));
  return li;
}

function card(g) {
  const editing = state.edit && state.edit.key === g.key && state.edit.mode === 'card';
  const c = el('article', 'card' + (g.done ? ' done' : '') + (editing ? ' editing' : ''));

  const head = el('div', 'card-head');
  const who = el('div', 'who');
  who.append(el('span', 'no', String(g.no)), el('span', 'name', g.name));
  head.append(who);

  const right = el('div', 'head-right');
  if (!editing) {
    right.append(button(g.confirmed ? '수정' : '확정', 'edit-btn' + (g.confirmed ? '' : ' primary-soft'), () => openEditor(g, 'card')));
  }
  const chk = el('label', 'check');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = g.done;
  box.addEventListener('change', () => setChecked(g, box.checked));
  chk.append(box, el('span', '', '나이스 입력'));
  right.append(chk);
  head.append(right);
  c.append(head);

  const tags = el('div', 'tags');
  for (const t of g.types) tags.append(el('span', `chip t-${t}` + (g.confirmed ? ' confirmed' : ''), g.confirmed ? `✔ ${t}` : t));
  for (const r of g.reasons) tags.append(el('span', 'chip reason' + (g.confirmed ? ' confirmed' : ''), r));
  if (!g.confirmed) tags.append(el('span', 'guess', '자동 추정'));
  for (const m of g.cmemos) tags.append(el('span', 'chip cmemo', '📝 ' + m));
  if (!g.confirmed) for (const m of g.memos) tags.append(el('span', 'chip memo', m));
  c.append(tags);

  if (g.recvOther.length) {
    c.append(el('div', 'recv-note', `${g.recvOther.map(shortLabel).join(', ')}에 미리 받은 연락`));
  }

  if (editing) c.append(editor(g));

  if (!g.done || editing) {
    const msgs = el('ul', 'msgs');
    for (const it of g.att) msgs.append(msgItem(it));
    if (g.chat.length) {
      const open = state.expanded.has(g.key);
      if (open) for (const it of g.chat) msgs.append(msgItem(it, 'chat'));
      const more = button(open ? '대화 접기' : `대화 ${g.chat.length}개 더 보기`, 'more-btn', () => {
        if (open) state.expanded.delete(g.key); else state.expanded.add(g.key);
        render();
      });
      msgs.append(more);
    }
    c.append(msgs);
  }
  return c;
}

function otherSection(other) {
  const sec = el('section', 'other' + (state.otherOpen ? ' open' : ''));
  const total = other.reduce((n, g) => n + g.chat.length, 0);
  const head = button('', 'other-head', () => { state.otherOpen = !state.otherOpen; render(); });
  head.append(el('span', 'caret', state.otherOpen ? '▾' : '▸'),
    el('span', '', `기타 대화 ${other.length}명 · ${total}개`),
    el('span', 'muted', '출결과 무관해 보이는 메시지'));
  sec.append(head);
  if (!state.otherOpen) return sec;

  for (const g of other) {
    const editing = state.edit && state.edit.key === g.key && state.edit.mode === 'other';
    const row = el('div', 'other-row');
    const top = el('div', 'other-top');
    const who = el('div', 'who');
    who.append(el('span', 'no', String(g.no)), el('span', 'name', g.name));
    top.append(who);
    if (!editing) top.append(button('출결로 전환', 'edit-btn', () => openEditor(g, 'other')));
    row.append(top);
    if (editing) row.append(editor(g));
    const msgs = el('ul', 'msgs');
    for (const it of g.chat) msgs.append(msgItem(it, 'chat'));
    row.append(msgs);
    sec.append(row);
  }
  return sec;
}

/* ---------- 확정·수정 도구 ---------- */

function openEditor(g, mode) {
  let type = '';
  let reason = '';
  let memo = '';
  if (mode === 'card') {
    const conf = g.att.find((i) => i.ctype);
    if (conf) {
      type = conf.ctype;
      reason = conf.creason;
      memo = conf.cmemo || '';
    } else {
      const guess = g.att.map((i) => i.type).find((t) => EDIT_TYPES.includes(t));
      type = guess || '';
      if (g.att.some((i) => String(i.reason).startsWith('질병'))) reason = '질병';
    }
  }
  state.edit = { key: g.key, mode, type, reason, date: state.date, memo, saving: false, msg: '' };
  render();
}

function closeEditor() {
  state.edit = null;
  render();
}

function seg(options, value, onPick) {
  const wrap = el('div', 'seg');
  for (const [v, text] of options) {
    const b = button(text, v === value ? 'on' : '', () => onPick(v));
    wrap.append(b);
  }
  return wrap;
}

function editor(g) {
  const e = state.edit;
  const box = el('div', 'editor');

  const f1 = el('div', 'field');
  f1.append(el('span', 'flabel', '유형'), seg(EDIT_TYPES.map((t) => [t, t]), e.type, (v) => { e.type = v; e.msg = ''; render(); }));
  const f2 = el('div', 'field');
  f2.append(el('span', 'flabel', '사유'), seg(EDIT_REASONS, e.reason, (v) => { e.reason = v; render(); }));

  const f3 = el('div', 'field-row2');
  const dl = el('label', 'field');
  dl.append(el('span', 'flabel', '적용 날짜'));
  const di = document.createElement('input');
  di.type = 'date';
  di.value = e.date;
  di.addEventListener('change', () => { e.date = di.value || state.date; });
  dl.append(di);
  const ml = el('label', 'field');
  ml.append(el('span', 'flabel', '메모 (예: 3교시 도착)'));
  const mi = document.createElement('input');
  mi.type = 'text';
  mi.value = e.memo;
  mi.maxLength = 100;
  mi.addEventListener('input', () => { e.memo = mi.value; });
  ml.append(mi);
  f3.append(dl, ml);

  const actions = el('div', 'row');
  const save = button(e.saving ? '저장 중…' : '확정', 'primary', () => saveEditor(g));
  save.disabled = e.saving;
  actions.append(save);
  if (e.mode === 'card') actions.append(button('출결 아님', 'ghost danger', () => notAttendance(g)));
  actions.append(button('취소', 'ghost', closeEditor));
  if (e.msg) actions.append(el('span', 'muted', e.msg));

  box.append(f1, f2, f3, actions);
  return box;
}

async function saveEditor(g) {
  const e = state.edit;
  if (!e.type) { e.msg = '유형을 고르세요.'; render(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) { e.msg = '날짜를 확인하세요.'; render(); return; }
  const ids = (e.mode === 'card' ? g.att : g.chat).map((i) => i.id);
  e.saving = true;
  render();
  try {
    await api({ action: 'settype', ids: ids.join(','), type: e.type, reason: e.reason, date: e.date, memo: e.memo.trim() });
    const moved = e.date !== state.date;
    state.edit = null;
    await load(true);
    flash(`${g.no}번 ${g.name} · ${e.type}${e.reason ? '·' + e.reason : ''} 확정` + (moved ? ` → ${shortLabel(e.date)}로 옮김` : ''));
  } catch (err) {
    e.saving = false;
    e.msg = '저장 실패: ' + err.message;
    render();
  }
}

async function notAttendance(g) {
  const e = state.edit;
  e.saving = true;
  render();
  try {
    await api({ action: 'settype', ids: g.att.map((i) => i.id).join(','), type: '해당없음', reason: '' });
    state.edit = null;
    await load(true);
    flash(`${g.no}번 ${g.name} · 기타 대화로 옮겼습니다`);
  } catch (err) {
    e.saving = false;
    e.msg = '저장 실패: ' + err.message;
    render();
  }
}

/* ---------- 상단·설정 ---------- */

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

function goDate(d) {
  state.date = d;
  state.items = [];
  state.notices = [];
  state.edit = null;
  state.expanded.clear();
  load();
}

$('prev').addEventListener('click', () => goDate(shift(state.date, -1)));
$('next').addEventListener('click', () => goDate(shift(state.date, 1)));
$('dateLabel').addEventListener('click', () => goDate(todayStr()));
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

/* ---------- 직접 추가 ---------- */

function segValue(id) { return $(id).dataset.value; }

function setSeg(id, v) {
  const s = $(id);
  s.dataset.value = v;
  for (const b of s.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === v);
}

for (const id of ['fRel', 'fType', 'fReason']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { setSeg(id, b.dataset.v); $('fMsg').textContent = ''; }
  });
}

let nameTouched = false;
$('fName').addEventListener('input', () => { nameTouched = true; });
$('fNo').addEventListener('input', () => {
  const known = state.roster[Number($('fNo').value)];
  if (!nameTouched || !$('fName').value) {
    $('fName').value = known || '';
    nameTouched = false;
  }
  $('fName').placeholder = known ? '' : (/^\d+$/.test($('fNo').value) ? '처음 연락한 학생은 이름을 입력하세요' : '번호를 입력하면 자동 표시');
});

function openAddForm(show) {
  $('addForm').hidden = !show;
  $('addBtn').classList.toggle('on', show);
  if (!show) return;
  $('fMsg').textContent = '';
  $('fNo').value = '';
  $('fName').value = '';
  $('fText').value = '';
  $('fMemo').value = '';
  nameTouched = false;
  setSeg('fRel', '학생');
  setSeg('fType', '');
  setSeg('fReason', '');
  $('fNo').focus();
}

$('addBtn').addEventListener('click', () => {
  if (!state.url) { showSettings(true); return; }
  openAddForm($('addForm').hidden);
});
$('fCancel').addEventListener('click', () => openAddForm(false));

$('fSubmit').addEventListener('click', async () => {
  const no = Number($('fNo').value);
  const name = $('fName').value.trim();
  const type = segValue('fType');
  const msg = $('fMsg');
  if (!(no >= 1 && no <= 99)) { msg.textContent = '번호를 입력하세요.'; $('fNo').focus(); return; }
  if (!name) { msg.textContent = '이름을 입력하세요.'; $('fName').focus(); return; }
  if (!type) { msg.textContent = '유형을 고르세요.'; return; }
  $('fSubmit').disabled = true;
  msg.textContent = '추가하는 중…';
  try {
    await api({
      action: 'add', date: state.date, no: String(no), name, rel: segValue('fRel'),
      type, reason: segValue('fReason'), text: $('fText').value, memo: $('fMemo').value.trim(),
    });
    openAddForm(false);
    await load(true);
    flash(`${no}번 ${name} · ${type} 추가했습니다.`);
  } catch (e) {
    msg.textContent = '추가 실패: ' + e.message;
  } finally {
    $('fSubmit').disabled = false;
  }
});

/* ---------- 자동 갱신 ---------- */

// 패널이 보이고, 오늘·내일을 보고 있고, 편집 중이 아닐 때만 1분마다 갱신 (입력하던 내용이 날아가지 않게)
function canAutoRefresh() {
  return !document.hidden && !state.edit && $('addForm').hidden &&
    (state.date === todayStr() || state.date === shift(todayStr(), 1));
}
setInterval(() => { if (canAutoRefresh()) load(true); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (canAutoRefresh()) load(true); });

chrome.storage.local.get(['url', 'secret']).then((v) => {
  state.url = v.url || '';
  state.secret = v.secret || '';
  load();
});
