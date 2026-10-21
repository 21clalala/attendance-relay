/**
 * 우리반 출결 연락 자동 정리 (Google Apps Script)
 *
 * 흐름: 갤럭시 '출결 알림 전달기' 앱이 우리반 연락처의 문자/카톡 알림만 골라 POST
 *       → 발신자 이름에서 번호·이름·관계 해석 → 수신로그 기록
 *       → 엣지 '출결 연락 패널'이 조회·확정·수정
 *
 * 연락처 이름 규칙 (선생님 폰)
 *   학생   : 2630201권민준
 *   학부모 : #30201권민준어머니 / #30201권민준아버지
 *   (26=연도, 3=학년, 02=반, 01=번호 — 학부모는 연도 없이 #+학년+반+번호)
 *
 * 처음 설정
 *  1) 비밀키: 편집기 왼쪽 톱니(프로젝트 설정) > 스크립트 속성 > 속성 추가
 *     속성 이름 SECRET, 값은 아무도 모르는 긴 문자열 (앱·패널에도 같은 값 입력)
 *     → 이렇게 하면 코드를 통째로 다시 붙여넣어도 비밀키를 다시 입력할 필요 없음
 *     (스크립트 속성이 없으면 아래 CONFIG.SECRET을 사용)
 *  2) 편집기에서 setup 함수 실행(권한 승인)
 *  3) 배포 > 새 배포 > 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자 → 웹 앱 URL 복사
 *  ※ 코드를 고친 뒤에는 배포 > 배포 관리 > 연필 > 버전: 새 버전 > 배포 (URL 유지)
 *
 * 개인정보: 반 코드가 맞지 않는 발신자의 메시지는 저장하지 않고 버립니다.
 *          외부 AI 서비스로 아무것도 보내지 않으며, 유형/사유/날짜는 키워드 규칙으로만 '추정'합니다.
 */

const CONFIG = {
  SECRET: 'CHANGE_ME_길고_랜덤한_문자열',   // 스크립트 속성 SECRET이 있으면 그쪽을 씀
  CLASS_CODE: '26302',          // 연도(26) + 학년(3) + 반(02). 내년엔 이 값만 바꾸기
  SHEET_LOG: '수신로그',
  SHEET_TODAY: '오늘현황',
  TZ: 'Asia/Seoul',
};

const SCRIPT_VERSION = '2026-10-21b';

// 열 순서를 바꾸지 말 것 (뒤에 추가만). 기존 시트는 setup/첫 실행 때 빠진 머리글을 자동으로 채움
const LOG_HEADERS = ['수신시각', '날짜', '앱', '발신자', '번호', '이름', '관계',
  '유형(추정)', '사유(추정)', '메모', '원문', '담임확인', 'ID', '유형(담임)', '사유(담임)',
  '적용날짜', '담임메모'];
const TYPE_CHOICES = ['결석', '지각', '조퇴', '결과', '해당없음'];
const REASON_CHOICES = ['질병', '미인정', '기타', '출석인정', ''];
const COL = {}; LOG_HEADERS.forEach((h, i) => { COL[h] = i; });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- 초기 설정 ---------- */

function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, CONFIG.SHEET_LOG, LOG_HEADERS);
  ensureSheet_(ss, CONFIG.SHEET_TODAY, []);
  refreshToday();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('출결정리')
    .addItem('오늘현황 새로고침 (시트 보기용)', 'refreshToday')
    .addItem('테스트 메시지 넣기', 'testInsert')
    .addToUi();
}

/* ---------- 수신 ---------- */

/** 브라우저로 웹 앱 URL을 열면 보이는 상태 확인용 (비밀 정보 없음) */
function doGet() {
  return json_({ ok: true, service: '출결 연락 수집기', version: SCRIPT_VERSION,
    message: '정상 배포됨. 폰 앱과 엣지 패널에서 연결 테스트를 해 보세요.' });
}

/**
 * 비밀키: '프로젝트 설정 > 스크립트 속성'의 SECRET을 우선 사용 (코드를 통째로 붙여넣어도 유지됨).
 * 스크립트 속성이 없으면 위 CONFIG.SECRET 사용. 둘 다 기본값이면 모든 요청 거부.
 */
function secret_() {
  let s = '';
  try { s = PropertiesService.getScriptProperties().getProperty('SECRET') || ''; } catch (_) { /* 없음 */ }
  s = s || CONFIG.SECRET;
  return s.indexOf('CHANGE_ME') === 0 ? null : s;
}

/** 패널이 보고 있는 날짜(view)의 목록. 쓰기 요청 응답에 같이 담아 패널이 다시 조회하지 않게 함 */
function listPayload_(view) {
  const d = DATE_RE.test(String(view || '')) ? view : todayStr_();
  const r = listItems_(d);
  return { date: d, items: r.items, notices: r.notices, roster: roster_() };
}

function withList_(p, obj) {
  if (p.view) Object.assign(obj, { list: listPayload_(p.view) });
  return json_(obj);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const p = readParams_(e);
    const secret = secret_();
    if (!secret || p.secret !== secret) return json_({ ok: false, error: 'auth' });
    if (String(p.test || '') === '1') return json_({ ok: true, test: true, version: SCRIPT_VERSION });

    // ---- 조회: 읽기만 하므로 잠금 없이 (다른 저장이 오래 걸려도 기다리지 않음) ----
    if (p.action === 'list') {
      return json_(Object.assign({ ok: true }, listPayload_(p.date)));
    }

    // ---- 여기부터 쓰기: 동시에 시트를 고치지 않도록 잠금 ----
    lock.waitLock(25000);

    if (p.action === 'add') {
      const r = addManual_(p);
      if (r.error) return json_({ ok: false, error: r.error });
      return withList_(p, { ok: true, id: r.id });
    }
    if (p.action === 'check') {
      const n = checkItems_(ids_(p), String(p.value) !== 'false');
      return withList_(p, { ok: true, updated: n });
    }
    // 담임 확정·수정 (패널, 폰 알림/입력창). date·memo는 보낸 경우에만 바꿈
    if (p.action === 'settype') {
      const type = String(p.type || '');
      const reason = String(p.reason || '');
      if (TYPE_CHOICES.indexOf(type) < 0 || REASON_CHOICES.indexOf(reason) < 0) return json_({ ok: false, error: 'bad type' });
      if (p.date !== undefined && p.date !== '' && !DATE_RE.test(String(p.date))) return json_({ ok: false, error: 'bad date' });
      const n = setTypeItems_(ids_(p), type, reason, p.date || null, p.memo !== undefined ? String(p.memo) : null);
      return withList_(p, { ok: true, updated: n });
    }

    // ---- 폰 앱에서 온 메시지 ----
    const sender = String(p.sender || '').trim();
    const text = String(p.text || '').trim();
    const app = String(p.app || '').trim();
    if (!sender || !text) return json_({ ok: false, error: 'empty' });

    const who = parseSender_(sender);
    if (!who) return json_({ ok: true, stored: false }); // 우리반 형식이 아닌 발신자: 저장 안 함

    // 같은 메시지가 두 번 오는 경우(재전송 등) 대비 → 6시간 동안 중복 제거
    const cache = CacheService.getScriptCache();
    const key = hash_(sender + '|' + text + '|' + String(p.ts || ''));
    if (cache.get(key)) return json_({ ok: true, stored: false, dup: true });
    cache.put(key, '1', 21600);

    // 폰이 오프라인이어서 늦게 전송된 경우에도 실제 받은 시각으로 기록
    const ts = Number(p.ts);
    const when = ts > 0 && Math.abs(Date.now() - ts) < 3 * 24 * 3600 * 1000 ? new Date(ts) : new Date();

    const s = storeMessage_(app, sender, text, who, when);
    // att=false(출결과 무관해 보임)면 폰 앱은 알림을 띄우지 않음
    return json_({ ok: true, stored: true, id: s.id, no: who.no, name: who.name, rel: who.rel,
      type: s.type, reason: s.reason, date: s.date, recvDate: s.recvDate, att: s.att });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) { /* 잠금을 못 얻은 경우 */ }
  }
}

function readParams_(e) {
  // 앱·패널은 폼 파라미터(x-www-form-urlencoded)로 보냄. JSON 본문도 받아 줌
  if (e && e.parameter && e.parameter.secret) return e.parameter;
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (_) { /* fallthrough */ }
  }
  return {};
}

function ids_(p) { return String(p.ids || '').split(',').filter(Boolean); }

/**
 * '2630201권민준' → {no: 1, name: '권민준', rel: '학생'}
 * '#2630201권민준어머니' → {no: 1, name: '권민준', rel: '어머니'}
 */
function parseSender_(sender) {
  const s = String(sender).replace(/\s+/g, '');
  // 학생 2630201권민준 (26302+번호) / 학부모 #30201권민준어머니 (#302+번호)
  const m = s.match(/^(#?)(\d+?)(\d{2})(\D.*)$/);
  if (!m) return null;
  const code = CONFIG.CLASS_CODE;              // '26302'
  const ok = m[1] === '#' ? (m[2] === code.slice(2) || m[2] === code) : m[2] === code;
  if (!ok) return null;
  const no = Number(m[3]);
  let name = m[4];
  let rel = m[1] === '#' ? '보호자' : '학생';
  const r = name.match(/^(.+?)(어머니|아버지|엄마|아빠|어머님|아버님|할머니|할아버지|보호자)$/);
  if (r) { name = r[1]; rel = r[2]; }
  return { no, name, rel };
}

function storeMessage_(app, sender, text, who, when) {
  const now = when || new Date();
  // 폰 메시지 저장은 목록이 필요 없으므로 로그 전체를 읽지 않고 바로 추가 (가장 빠른 경로)
  const recvDate = Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd');
  const c = classify_(text);
  const t = detectTargetDate_(text, recvDate);
  const memo = [c.memo, t.note].filter(Boolean).join(', ');
  const id = Utilities.getUuid().slice(0, 8);
  appendLog_([
    txt_(Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss')), txt_(recvDate),
    app, txt_(sender), who.no, txt_(who.name), who.rel,
    c.type, c.reason, memo, txt_(text), false, id, '', '',
    txt_(t.date), '',
  ]);
  return { id, type: c.type, reason: c.reason, date: t.date, recvDate,
    att: isAttendance_(c.type, c.reason, '') };
}

/** 출결 관련으로 볼지: 담임이 정했으면 그 값, 아니면 유형이나 사유 키워드가 잡혔는지 */
function isAttendance_(type, reason, ctype) {
  if (ctype) return ctype !== '해당없음';
  return (type && type !== '확인필요') || !!reason;
}

/** 지금까지 받은 연락에서 번호 → 이름 목록을 만든다 (가장 최근 이름 우선) */
function roster_() {
  const map = {};
  logRows_().rows.forEach(r => {
    const no = Number(r[COL['번호']]);
    if (no > 0 && r[COL['이름']]) map[no] = r[COL['이름']];
  });
  return map;
}

function addManual_(p) {
  const no = Number(p.no);
  if (!(no >= 1 && no <= 99 && Math.floor(no) === no)) return { error: '번호가 올바르지 않습니다' };
  const name = String(p.name || '').trim() || roster_()[no] || '';
  if (!name) return { error: '이름을 입력하세요' };
  const rel = ['학생', '어머니', '아버지', '보호자'].indexOf(p.rel) >= 0 ? p.rel : '학생';
  const type = String(p.type || '');
  const reason = String(p.reason || '');
  if (TYPE_CHOICES.indexOf(type) < 0 || REASON_CHOICES.indexOf(reason) < 0) return { error: '유형/사유가 올바르지 않습니다' };
  const date = DATE_RE.test(String(p.date || '')) ? p.date : todayStr_();
  const text = String(p.text || '').trim() || '(내용 없이 직접 추가)';
  const recvDate = todayStr_();
  const time = Utilities.formatDate(new Date(), CONFIG.TZ, 'HH:mm:ss');
  const c = classify_(text);
  const id = Utilities.getUuid().slice(0, 8);
  const nn = ('0' + no).slice(-2);
  const sender = rel === '학생' ? CONFIG.CLASS_CODE + nn + name : '#' + CONFIG.CLASS_CODE.slice(2) + nn + name + rel;

  appendLog_([
    txt_(recvDate + ' ' + time), txt_(recvDate), '직접추가', txt_(sender), no, txt_(name), rel,
    c.type, c.reason, c.memo, txt_(text), false, id, type, reason,
    txt_(date), txt_(String(p.memo || '')),
  ]);
  return { id };
}

/** 담임 확정값 기록. date/memo가 null이면 기존 값 유지 */
function setTypeItems_(ids, type, reason, date, memo) {
  if (!ids.length) return 0;
  const { log, rows } = logRows_();
  const want = new Set(ids);
  let n = 0;
  rows.forEach((r, i) => {
    if (!want.has(r[COL['ID']])) return;
    const d = date || r[COL['적용날짜']] || r[COL['날짜']];
    const m = memo !== null ? memo : r[COL['담임메모']];
    // 유형(담임)·사유(담임)·적용날짜·담임메모는 붙어 있는 4칸
    log.getRange(i + 2, COL['유형(담임)'] + 1, 1, 4).setValues([[type, reason, txt_(d), txt_(m)]]);
    r[COL['유형(담임)']] = type;
    r[COL['사유(담임)']] = reason;
    r[COL['적용날짜']] = d;
    r[COL['담임메모']] = m;
    n++;
  });
  return n;
}

/* ---------- 사이드 패널용 조회 / 체크 ---------- */

function todayStr_() {
  return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
}

/**
 * 수신로그를 요청당 한 번만 읽는다 (시트 읽기가 가장 느린 작업이라).
 * 같은 요청 안에서 쓰기를 하면 이 메모리 사본도 같이 고쳐서, 다시 읽지 않고 최신 목록을 돌려준다.
 */
let LOG_CACHE_ = null;
function logRows_() {
  if (LOG_CACHE_) return LOG_CACHE_;
  const log = ensureSheet_(SpreadsheetApp.getActive(), CONFIG.SHEET_LOG, LOG_HEADERS);
  const rows = log.getLastRow() < 2 ? []
    : log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getDisplayValues();
  LOG_CACHE_ = { log, rows };
  return LOG_CACHE_;
}

/** 새 행 추가. 이미 읽어 둔 사본이 있으면 거기에도 추가 (없으면 로그를 읽지 않음) */
function appendLog_(values) {
  const log = LOG_CACHE_ ? LOG_CACHE_.log : ensureSheet_(SpreadsheetApp.getActive(), CONFIG.SHEET_LOG, LOG_HEADERS);
  log.appendRow(values);
  log.getRange(log.getLastRow(), COL['담임확인'] + 1).insertCheckboxes();
  if (LOG_CACHE_) {
    LOG_CACHE_.rows.push(values.map(v => typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE')
      : String(v).replace(/^'/, '')));
  }
}

function appliedDate_(r) { return r[COL['적용날짜']] || r[COL['날짜']]; }

/**
 * d 날짜에 '적용되는' 메시지 목록 + 예고 목록
 *  items  : 적용날짜가 d인 메시지 (출결 여부 att 포함 → 패널이 출결 카드 / 기타 대화로 나눔)
 *  notices: d에 받았지만 다른 날짜로 적용되는 출결 메시지 (예: 오늘 받은 '내일 결석')
 */
function listItems_(d) {
  const items = [];
  const notices = [];
  logRows_().rows.forEach(r => {
    const applied = appliedDate_(r);
    const ctype = r[COL['유형(담임)']] || '';
    const att = isAttendance_(r[COL['유형(추정)']], r[COL['사유(추정)']], ctype);
    if (applied === d) {
      items.push({
        id: r[COL['ID']],
        time: r[COL['수신시각']].slice(11, 16),
        recvDate: r[COL['날짜']],
        date: applied,
        app: r[COL['앱']],
        no: Number(r[COL['번호']]),
        name: r[COL['이름']],
        rel: r[COL['관계']],
        type: r[COL['유형(추정)']],
        reason: r[COL['사유(추정)']],
        memo: r[COL['메모']],
        text: r[COL['원문']],
        checked: String(r[COL['담임확인']]).toUpperCase() === 'TRUE',
        ctype: ctype,                         // 담임 확정값 (비어 있으면 추정값 사용)
        creason: r[COL['사유(담임)']] || '',
        cmemo: r[COL['담임메모']] || '',
        att: att,
      });
    } else if (r[COL['날짜']] === d && att) {
      notices.push({ no: Number(r[COL['번호']]), name: r[COL['이름']], date: applied,
        type: ctype || r[COL['유형(추정)']], time: r[COL['수신시각']].slice(11, 16) });
    }
  });
  return { items, notices };
}

function checkItems_(ids, value) {
  if (!ids.length) return 0;
  const { log, rows } = logRows_();
  const want = new Set(ids);
  let n = 0;
  rows.forEach((r, i) => {
    if (want.has(r[COL['ID']])) {
      log.getRange(i + 2, COL['담임확인'] + 1).setValue(value);
      r[COL['담임확인']] = value ? 'TRUE' : 'FALSE';
      n++;
    }
  });
  return n;
}

/* ---------- 키워드 분류 (추정일 뿐, 최종 판단은 담임) ---------- */

function classify_(text) {
  const t = text.replace(/\s+/g, ' ');
  let type = '확인필요';
  if (/조퇴/.test(t)) type = '조퇴';
  else if (/결과|\d\s*교시.*(빠|불참|못\s*들)/.test(t)) type = '결과';
  else if (/지각|늦(을|게|어|었|는|잠)|늦습니다|늦겠/.test(t)) type = '지각';
  else if (/결석|못\s*(가|와|갈|올|나가)|등교\s*(못|어렵|안)|쉬(겠|어야|게|려)|안\s*(갈|가겠)/.test(t)) type = '결석';
  // 늦는다는 말 없이 상황만 말하는 경우 (알람, 기상, 교통) — 결석 표현이 없을 때만 지각으로 추정
  else if (/알람|못\s*일어|(방금|이제|지금)\s*일어|깼|(버스|지하철|차)\s*(를|을)?\s*놓|차가\s*막|지금\s*출발|가는\s*중/.test(t)) type = '지각';

  let reason = '';
  if (/아프|아파|아팠|고열|미열|열이|발열|감기|독감|장염|복통|두통|몸살|코로나|구토|설사|병원|진료|입원|수술|응급/.test(t)) reason = '질병(추정)';
  else if (/장례|빈소|상을\s*당|돌아가|결혼식/.test(t)) reason = '경조사(추정)';
  else if (/체험학습/.test(t)) reason = '체험학습(추정)';

  const memo = [];
  if (reason.startsWith('질병')) memo.push('증빙 확인');
  return { type, reason, memo: memo.join(', ') };
}

/* ---------- 적용 날짜 추정 ---------- */

const WEEKDAYS = '일월화수목금토';

function addDays_(ds, n) {
  const [y, m, d] = ds.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function weekday_(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * 메시지 속 날짜 표현으로 '적용할 날짜'를 추정한다. 못 찾으면 받은 날짜.
 *  - 'M월 D일' → 그 날짜 (이미 30일 넘게 지났으면 내년)
 *  - '다음 주 X요일' → 다음 주의 그 요일 / 'X요일' → 오늘 포함 가장 가까운 그 요일
 *  - '모레' → +2, '내일' → +1 ('오늘'도 같이 있으면 오늘로 두고 확인 표시)
 * note: 패널 메모에 붙는 확인 문구
 */
function detectTargetDate_(text, recvDate) {
  const t = String(text).replace(/\s+/g, '');
  let date = recvDate;
  let note = '';

  const md = t.match(/(\d{1,2})월(\d{1,2})일/);
  const wk = t.match(/(다음주|담주|다음)?([월화수목금토일])요일/);
  if (md) {
    const y = Number(recvDate.slice(0, 4));
    const cand = `${y}-${('0' + md[1]).slice(-2)}-${('0' + md[2]).slice(-2)}`;
    date = cand < addDays_(recvDate, -30) ? `${y + 1}${cand.slice(4)}` : cand;
    note = '날짜 언급';
  } else if (wk) {
    const target = WEEKDAYS.indexOf(wk[2]);
    const today = weekday_(recvDate);
    let diff = (target - today + 7) % 7;
    if (wk[1]) {
      // 다음 주 X요일: 이번 주(월요일 시작) 다음 주의 그 요일
      const toNextMon = ((8 - today) % 7) || 7;
      diff = toNextMon + ((target + 6) % 7);
    }
    date = addDays_(recvDate, diff);
    note = '요일 언급';
  } else if (/모레/.test(t)) {
    date = addDays_(recvDate, 2);
    note = '모레 언급';
  } else if (/내일/.test(t)) {
    if (/오늘/.test(t)) {
      note = '오늘·내일 언급 — 날짜 확인';
    } else {
      date = addDays_(recvDate, 1);
      note = '내일 언급';
    }
  }
  const w = weekday_(date);
  if (date !== recvDate && (w === 0 || w === 6)) note += ' (주말 — 날짜 확인)';
  return { date, note };
}

/* ---------- 오늘현황 시트 (출결 관련만) ---------- */

function refreshToday() {
  const ss = SpreadsheetApp.getActive();
  const out = ensureSheet_(ss, CONFIG.SHEET_TODAY, []);
  const today = todayStr_();
  const rows = logRows_().rows.filter(r => appliedDate_(r) === today &&
    isAttendance_(r[COL['유형(추정)']], r[COL['사유(추정)']], r[COL['유형(담임)']]));

  const byStudent = {};
  rows.forEach(r => {
    const k = r[COL['번호']] + '|' + r[COL['이름']];
    (byStudent[k] = byStudent[k] || []).push(r);
  });

  out.clear();
  out.appendRow([today + ' 출결 연락 현황', '', '', '', '', '마지막 갱신: ' +
    Utilities.formatDate(new Date(), CONFIG.TZ, 'HH:mm')]);
  out.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  out.appendRow(['번호', '이름', '유형', '사유', '메모', '메시지 (받은 날 시각 · 보낸 사람)']);
  out.getRange(2, 1, 1, 6).setFontWeight('bold').setBackground('#eeeeee');

  const keys = Object.keys(byStudent).sort((a, b) => Number(a.split('|')[0]) - Number(b.split('|')[0]));
  if (!keys.length) out.appendRow(['', '오늘 출결 연락 없음']);

  keys.forEach(k => {
    const rs = byStudent[k];
    const [no, name] = k.split('|');
    // 담임이 지정한 값이 하나라도 있으면 그것만, 없으면 추정값 사용
    const confirmed = rs.filter(r => r[COL['유형(담임)']]);
    const types = confirmed.length
      ? uniq_(confirmed.map(r => r[COL['유형(담임)']] + '✔'))
      : uniq_(rs.map(r => r[COL['유형(추정)']]).filter(v => v !== '확인필요'));
    const reasons = confirmed.length
      ? uniq_(confirmed.map(r => r[COL['사유(담임)']]).filter(Boolean))
      : uniq_(rs.map(r => r[COL['사유(추정)']]).filter(Boolean));
    const memos = uniq_(rs.flatMap(r => [r[COL['담임메모']]].concat(r[COL['메모']].split(', '))).filter(Boolean));
    const msgs = rs.map(r => r[COL['수신시각']].slice(5, 16) + ' · ' + r[COL['관계']] + ': ' + r[COL['원문']]).join('\n');
    out.appendRow([no, name, types.join(', ') || '확인필요', reasons.join(', '), memos.join(', '), txt_(msgs)]);
  });

  out.setColumnWidths(1, 2, 70);
  out.setColumnWidths(3, 3, 110);
  out.setColumnWidth(6, 480);
  if (out.getLastRow() > 2) {
    out.getRange(3, 1, out.getLastRow() - 2, 6).setWrap(true).setVerticalAlignment('top');
  }
}

/* ---------- 테스트 ---------- */

function testInsert() {
  const code = CONFIG.CLASS_CODE;
  doPost({ parameter: { secret: secret_(), app: '테스트', sender: '#' + code.slice(2) + '01권민준어머니',
    text: '선생님 민준이가 밤새 열이 나서 오늘 병원 들렀다가 2교시쯤 늦게 등교하겠습니다.' } });
  doPost({ parameter: { secret: secret_(), app: '테스트', sender: code + '31황시윤',
    text: '쌤 저 내일 배가 아파서 병원 가야 해서 결석할 것 같아요' } });
  doPost({ parameter: { secret: secret_(), app: '테스트', sender: code + '31황시윤',
    text: '넵 알겠습니다 ㅎㅎ' } });
  doPost({ parameter: { secret: secret_(), app: '테스트', sender: '김철수',
    text: '이 메시지는 우리반 형식이 아니므로 저장되면 안 됩니다.' } });
  refreshToday();
}

/* ---------- 유틸 ---------- */

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (!headers.length) return sh;
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else if (sh.getLastColumn() < headers.length) {
    // 이전 버전으로 만든 시트: 뒤에 추가된 머리글만 채움 (기존 데이터는 그대로)
    const start = sh.getLastColumn() + 1;
    sh.getRange(1, start, 1, headers.length - start + 1)
      .setValues([headers.slice(start - 1)]).setFontWeight('bold');
  }
  return sh;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function hash_(s) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
}

function uniq_(a) { return Array.from(new Set(a)); }

/**
 * 시트에 '글자 그대로' 저장되게 함.
 *  - 날짜처럼 생긴 문자열이 날짜로 자동 변환되는 것 방지 (그러면 날짜 필터가 깨짐)
 *  - '='로 시작하는 메시지가 수식으로 실행되는 것 방지
 * 맨 앞 작은따옴표는 시트에 보이지 않고, 읽을 때도 빠진 값으로 돌아옴.
 */
function txt_(s) { return "'" + String(s); }
