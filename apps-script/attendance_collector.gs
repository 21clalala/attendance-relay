/**
 * 우리반 출결 연락 자동 정리 (Google Apps Script)
 *
 * 흐름: 갤럭시 '출결 알림 전달기' 앱이 우리반 연락처의 문자/카톡 알림만 골라 POST
 *       → 발신자 이름에서 번호·이름·관계 해석 → 수신로그 기록 → 오늘현황 시트 갱신
 *
 * 연락처 이름 규칙 (선생님 폰)
 *   학생   : 2630201권민준
 *   학부모 : #2630201권민준어머니 / #2630201권민준아버지
 *   (26=연도, 3=학년, 02=반, 01=번호)
 *
 * 처음 설정
 *  1) 아래 SECRET 값을 아무도 모르는 긴 문자열로 바꾸기 (앱에도 같은 값 입력)
 *  2) 편집기에서 setup 함수 실행(권한 승인)
 *  3) 배포 > 새 배포 > 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자 → 웹 앱 URL 복사
 *
 * 개인정보: 반 코드가 맞지 않는 발신자의 메시지는 저장하지 않고 버립니다.
 *          외부 AI 서비스로 아무것도 보내지 않으며, 유형/사유는 키워드 규칙으로만 '추정'합니다.
 */

const CONFIG = {
  SECRET: 'CHANGE_ME_길고_랜덤한_문자열',
  CLASS_CODE: '26302',          // 연도(26) + 학년(3) + 반(02). 내년엔 이 값만 바꾸기
  SHEET_LOG: '수신로그',
  SHEET_TODAY: '오늘현황',
  TZ: 'Asia/Seoul',
};

const LOG_HEADERS = ['수신시각', '날짜', '앱', '발신자', '번호', '이름', '관계',
  '유형(추정)', '사유(추정)', '메모', '원문', '담임확인', 'ID', '유형(담임)', '사유(담임)'];
const TYPE_CHOICES = ['결석', '지각', '조퇴', '결과', '해당없음'];
const REASON_CHOICES = ['질병', '미인정', '기타', '출석인정', ''];
const COL = {}; LOG_HEADERS.forEach((h, i) => { COL[h] = i; });

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
    .addItem('오늘현황 새로고침', 'refreshToday')
    .addItem('테스트 메시지 넣기', 'testInsert')
    .addToUi();
}

/* ---------- 수신 ---------- */

const SCRIPT_VERSION = '2026-10-20b';

/**
 * 브라우저로 웹 앱 URL을 열었을 때 보이는 상태 확인용.
 * 이 글이 보이면 '배포된 버전에 이 코드가 들어 있다'는 뜻. (비밀 정보는 내보내지 않음)
 */
function doGet() {
  return json_({ ok: true, service: '출결 연락 수집기', version: SCRIPT_VERSION,
    message: '정상 배포됨. 폰 앱과 엣지 패널에서 연결 테스트를 해 보세요.' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const p = readParams_(e);
    if (p.secret !== CONFIG.SECRET) return json_({ ok: false, error: 'auth' });
    if (String(p.test || '') === '1') return json_({ ok: true, test: true }); // 앱의 '연결 테스트'

    // 엣지 사이드 패널용
    if (p.action === 'list') {
      return json_({ ok: true, date: p.date || todayStr_(), items: listItems_(p.date), roster: roster_() });
    }
    // 패널에서 직접 추가 (PC 카톡에서 먼저 읽어 폰 알림이 안 온 경우 등)
    if (p.action === 'add') {
      const r = addManual_(p);
      if (r.error) return json_({ ok: false, error: r.error });
      refreshToday();
      return json_({ ok: true, id: r.id });
    }
    if (p.action === 'check') {
      const n = checkItems_(String(p.ids || '').split(',').filter(Boolean), String(p.value) !== 'false');
      return json_({ ok: true, updated: n });
    }
    // 담임이 폰 알림/입력창(또는 패널)에서 유형·사유를 직접 지정
    if (p.action === 'settype') {
      const type = String(p.type || '');
      const reason = String(p.reason || '');
      if (TYPE_CHOICES.indexOf(type) < 0 || REASON_CHOICES.indexOf(reason) < 0) return json_({ ok: false, error: 'bad type' });
      const n = setTypeItems_(String(p.ids || '').split(',').filter(Boolean), type, reason);
      refreshToday();
      return json_({ ok: true, updated: n });
    }

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

    const saved = storeMessage_(app, sender, text, who, when);
    refreshToday();
    // 폰 앱이 '유형 입력' 알림을 띄울 수 있도록 저장 결과를 돌려줌
    return json_({ ok: true, stored: true, id: saved.id, no: who.no, name: who.name, rel: who.rel,
      type: saved.type, reason: saved.reason });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function readParams_(e) {
  // 앱은 폼 파라미터(x-www-form-urlencoded)로 보냄. JSON 본문도 받아 줌
  if (e && e.parameter && e.parameter.secret) return e.parameter;
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (_) { /* fallthrough */ }
  }
  return {};
}

/**
 * '2630201권민준' → {no: 1, name: '권민준', rel: '학생'}
 * '#2630201권민준어머니' → {no: 1, name: '권민준', rel: '어머니'}
 */
function parseSender_(sender) {
  const s = String(sender).replace(/\s+/g, '');
  const m = s.match(/^(#?)(\d{5})(\d{2})(.+)$/);
  if (!m || m[2] !== CONFIG.CLASS_CODE) return null;
  const no = Number(m[3]);
  let name = m[4];
  let rel = m[1] === '#' ? '보호자' : '학생';
  const r = name.match(/^(.+?)(어머니|아버지|엄마|아빠|어머님|아버님|할머니|할아버지|보호자)$/);
  if (r) { name = r[1]; rel = r[2]; }
  return { no, name, rel };
}

function storeMessage_(app, sender, text, who, when) {
  const ss = SpreadsheetApp.getActive();
  const log = ensureSheet_(ss, CONFIG.SHEET_LOG, LOG_HEADERS);
  const now = when || new Date();
  const c = classify_(text);
  const id = Utilities.getUuid().slice(0, 8);
  log.appendRow([
    txt_(Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss')),
    txt_(Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd')),
    app, txt_(sender), who.no, txt_(who.name), who.rel,
    c.type, c.reason, c.memo, txt_(text), false, id, '', '',
  ]);
  log.getRange(log.getLastRow(), COL['담임확인'] + 1).insertCheckboxes();
  return { id, type: c.type, reason: c.reason };
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
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : todayStr_();
  const text = String(p.text || '').trim() || '(내용 없이 직접 추가)';
  const time = Utilities.formatDate(new Date(), CONFIG.TZ, 'HH:mm:ss');
  const c = classify_(text);
  const id = Utilities.getUuid().slice(0, 8);
  const code = CONFIG.CLASS_CODE + ('0' + no).slice(-2);
  const sender = (rel === '학생' ? '' : '#') + code + name + (rel === '학생' ? '' : rel);

  const log = ensureSheet_(SpreadsheetApp.getActive(), CONFIG.SHEET_LOG, LOG_HEADERS);
  log.appendRow([
    txt_(date + ' ' + time), txt_(date), '직접추가', txt_(sender), no, txt_(name), rel,
    c.type, c.reason, c.memo, txt_(text), false, id, type, reason,
  ]);
  log.getRange(log.getLastRow(), COL['담임확인'] + 1).insertCheckboxes();
  return { id };
}

function setTypeItems_(ids, type, reason) {
  if (!ids.length) return 0;
  const { log, rows } = logRows_();
  const want = new Set(ids);
  let n = 0;
  rows.forEach((r, i) => {
    if (want.has(r[COL['ID']])) {
      log.getRange(i + 2, COL['유형(담임)'] + 1, 1, 2).setValues([[type, reason]]);
      n++;
    }
  });
  return n;
}

/* ---------- 사이드 패널용 조회 / 체크 ---------- */

function todayStr_() {
  return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
}

function logRows_() {
  const log = ensureSheet_(SpreadsheetApp.getActive(), CONFIG.SHEET_LOG, LOG_HEADERS);
  if (log.getLastRow() < 2) return { log, rows: [] };
  return { log, rows: log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getDisplayValues() };
}

function listItems_(date) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : todayStr_();
  return logRows_().rows
    .filter(r => r[COL['날짜']] === d)
    .map(r => ({
      id: r[COL['ID']],
      time: r[COL['수신시각']].slice(11, 16),
      app: r[COL['앱']],
      no: Number(r[COL['번호']]),
      name: r[COL['이름']],
      rel: r[COL['관계']],
      type: r[COL['유형(추정)']],
      reason: r[COL['사유(추정)']],
      memo: r[COL['메모']],
      text: r[COL['원문']],
      checked: String(r[COL['담임확인']]).toUpperCase() === 'TRUE',
      ctype: r[COL['유형(담임)']] || '',     // 담임 확정값 (비어 있으면 추정값 사용)
      creason: r[COL['사유(담임)']] || '',
    }));
}

function checkItems_(ids, value) {
  if (!ids.length) return 0;
  const { log, rows } = logRows_();
  const want = new Set(ids);
  let n = 0;
  rows.forEach((r, i) => {
    if (want.has(r[COL['ID']])) {
      log.getRange(i + 2, COL['담임확인'] + 1).setValue(value);
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
  if (/내일/.test(t)) memo.push('내일 언급');
  if (/모레|다음\s*주/.test(t)) memo.push('이후 날짜 언급');
  if (reason.startsWith('질병')) memo.push('증빙 확인');

  return { type, reason, memo: memo.join(', ') };
}

/* ---------- 오늘현황 ---------- */

function refreshToday() {
  const ss = SpreadsheetApp.getActive();
  const log = ensureSheet_(ss, CONFIG.SHEET_LOG, LOG_HEADERS);
  const out = ensureSheet_(ss, CONFIG.SHEET_TODAY, []);
  const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');

  const data = log.getLastRow() > 1
    ? log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getDisplayValues()
    : [];

  const byStudent = {};
  data.filter(r => r[COL['날짜']] === today).forEach(r => {
    const k = r[COL['번호']] + '|' + r[COL['이름']];
    (byStudent[k] = byStudent[k] || []).push(r);
  });

  out.clear();
  out.appendRow([today + ' 출결 연락 현황', '', '', '', '', '마지막 갱신: ' +
    Utilities.formatDate(new Date(), CONFIG.TZ, 'HH:mm')]);
  out.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  out.appendRow(['번호', '이름', '유형(추정)', '사유(추정)', '메모', '메시지 (시각 · 보낸 사람)']);
  out.getRange(2, 1, 1, 6).setFontWeight('bold').setBackground('#eeeeee');

  const keys = Object.keys(byStudent).sort((a, b) => Number(a.split('|')[0]) - Number(b.split('|')[0]));
  if (!keys.length) out.appendRow(['', '오늘 수신된 연락 없음']);

  keys.forEach(k => {
    const rows = byStudent[k];
    const [no, name] = k.split('|');
    // 담임이 지정한 값이 하나라도 있으면 그것만, 없으면 추정값 사용
    const confirmed = rows.filter(r => r[COL['유형(담임)']]);
    const types = confirmed.length
      ? uniq_(confirmed.map(r => r[COL['유형(담임)']] + '✔'))
      : uniq_(rows.map(r => r[COL['유형(추정)']]).filter(v => v !== '확인필요'));
    const reasons = confirmed.length
      ? uniq_(confirmed.map(r => r[COL['사유(담임)']]).filter(Boolean))
      : uniq_(rows.map(r => r[COL['사유(추정)']]).filter(Boolean));
    const memos = uniq_(rows.flatMap(r => r[COL['메모']].split(', ')).filter(Boolean));
    const msgs = rows.map(r => r[COL['수신시각']].slice(11, 16) + ' · ' + r[COL['관계']] + ': ' + r[COL['원문']]).join('\n');
    out.appendRow([no, name, types.join(', ') || '확인필요', reasons.join(', '), memos.join(', '), msgs]);
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
  doPost({ parameter: { secret: CONFIG.SECRET, app: '테스트', sender: '#' + code + '01권민준어머니',
    text: '선생님 민준이가 밤새 열이 나서 오늘 병원 들렀다가 2교시쯤 늦게 등교하겠습니다.' } });
  doPost({ parameter: { secret: CONFIG.SECRET, app: '테스트', sender: code + '31황시윤',
    text: '쌤 저 오늘 배가 너무 아파서 조퇴해야 할 것 같아요' } });
  doPost({ parameter: { secret: CONFIG.SECRET, app: '테스트', sender: '김철수',
    text: '이 메시지는 우리반 형식이 아니므로 저장되면 안 됩니다.' } });
}

/* ---------- 유틸 ---------- */

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (headers.length && sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
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
