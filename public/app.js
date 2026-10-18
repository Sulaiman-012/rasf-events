/* Rasf events platform: browser app (employee page, results, my account, admin, LG screen).
   All data comes from the Worker API under /api. User text is always written with textContent. */
'use strict';
(() => {
const CFG = Object.assign({ screenPollMs: 5000, phonePollMs: 8000, adminPollMs: 10000, heartbeatMs: 60000, kioskResetMs: 7000 }, window.RASF_CONFIG || {});
const DEFAULT_LOGO = '/rasf-logo.png';
const DEFAULT_IDENTITY = { primary: '#8d6d52', accent: '#c6ab8c', background: '#f3eee7', logoUrl: null };
const ORIGIN = location.origin;
const EMPLOYEE_URL = ORIGIN + '/';
const PATH = location.pathname.replace(/\/+$/, '') || '/';
const MODE = PATH === '/admin' ? 'admin' : PATH === '/setup' ? 'setup' : PATH.startsWith('/screen') ? 'screen' : 'employee';
const SCREEN_KEY = MODE === 'screen' ? decodeURIComponent(PATH.split('/')[2] || '').slice(0, 40) : '';
const MAX_UPLOAD = 1500000;
const LETTERS = ['أ', 'ب', 'ج', 'د'];
const TEXT_TYPES = ['short', 'essay'];
if (MODE === 'screen') document.documentElement.classList.add('screen-mode');

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ar = (n) => new Intl.NumberFormat('ar-SA').format(n);
const ar1 = (n) => new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 1 }).format(n);

const S = {
  pub: null,          // public state from /api/state
  me: null,           // employee participant {id,name}
  staff: null,        // signed-in owner/manager
  needsSetup: false,
  admin: null,        // admin data from /api/admin
  rec: null, recQid: null, recLoading: false,
  run: null, kioskName: '', renaming: false,
  insights: {}, staffList: null, people: null,
  skew: 0,
};
const serverNow = () => Date.now() + S.skew;

/* ---------------- helpers ---------------- */
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach((k) => k != null && e.append(k));
  return e;
}
function toast(t) { const n = $('#toast'); n.textContent = t; n.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (n.hidden = true), 3600); }
function note(t, soft) { const n = $('#access-note'); n.hidden = !t; n.textContent = t || ''; n.classList.toggle('soft', !!soft); }
const fmtDate = (ms) => ms ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) : '';
const fmtDay = (ms) => ms ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { dateStyle: 'medium' }).format(new Date(ms)) : '';
const toLocalInput = (ms) => { if (!ms) return ''; const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v) => v ? new Date(v).getTime() : null;
function ago(ms) { const m = Math.round((serverNow() - ms) / 60000); if (m < 60) return 'قبل ' + ar(Math.max(1, m)) + ' دقيقة'; const h = Math.round(m / 60); if (h < 48) return 'قبل ' + ar(h) + ' ساعة'; return fmtDate(ms); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('تم نسخ الرابط.'); } catch { toast('انسخ الرابط يدويًا من المربع.'); } }

/** Two-step confirm (no confirm() dialogs). */
function confirmButton(label, action, okMsg) {
  const b = el('button', { class: 'mini-button delete', type: 'button', text: label });
  let armed = false, timer;
  b.onclick = async () => {
    if (!armed) { armed = true; b.textContent = 'تأكيد ' + label + '؟'; timer = setTimeout(() => { armed = false; b.textContent = label; }, 4000); return; }
    clearTimeout(timer); b.disabled = true;
    try { await action(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message || 'تعذر التنفيذ، حاول مرة أخرى.'); b.disabled = false; armed = false; b.textContent = label; }
  };
  return b;
}

/* ---------------- API ---------------- */
async function api(method, url, body) {
  const opt = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body || {}); }
  let res;
  try { res = await fetch(url, opt); } catch { const e = new Error('تعذر الاتصال بالخادم. تحقق من الإنترنت ثم حاول.'); e.code = 'network'; throw e; }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error((data && data.message) || 'حدث خطأ، حاول مرة أخرى.'); e.code = data && data.error; e.status = res.status; throw e; }
  return data || {};
}
const etags = {};
/** Conditional GET: returns null when the server says nothing changed (304). */
async function poll(url, force) {
  const headers = {};
  if (etags[url] && !force) headers['If-None-Match'] = etags[url];
  let res;
  try { res = await fetch(url, { headers, cache: 'no-store', credentials: 'same-origin' }); } catch { const e = new Error('network'); e.code = 'network'; throw e; }
  if (res.status === 304) return null;
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error((data && data.message) || 'error'); e.status = res.status; e.code = data && data.error; throw e; }
  const et = res.headers.get('ETag'); if (et) etags[url] = et;
  return data;
}

/* ---------------- identity ---------------- */
function applyIdentity() {
  const src = (S.admin && S.admin.identity) || (S.pub && S.pub.identity) || {};
  const i = { ...DEFAULT_IDENTITY, ...src };
  const r = document.documentElement.style;
  r.setProperty('--page-bg', i.background); r.setProperty('--teal', i.primary); r.setProperty('--lime', i.accent);
  const logo = i.logoUrl || DEFAULT_LOGO;
  $$('#brand-mark img').forEach((img) => { if (img.getAttribute('src') !== logo) img.src = logo; });
  if (!pendingLogo) { const p = $('#identity-logo-preview img'); if (p.getAttribute('src') !== logo) p.src = logo; }
  if (!identityDirty) { $('#primary-color').value = i.primary; $('#accent-color').value = i.accent; $('#background-color').value = i.background; }
  let st = $('#identity-style'); if (!st) { st = el('style', { id: 'identity-style' }); document.head.append(st); }
  const ok = (c) => /^#[0-9a-f]{6}$/i.test(c);
  if (!ok(i.primary) || !ok(i.accent)) return;
  st.textContent = `.primary-button{background:${i.primary}!important;border-color:${i.primary}!important}.secondary-button{color:${i.primary}!important;border-color:${i.primary}!important}.timer-track div,.nav-link.active{background:${i.primary}!important}.timer-number,.eyebrow,.round-label,.people-icon,.podium p,.results-table strong,.mini-button{color:${i.primary}!important}.featured-message{border-right-color:${i.primary}!important}.live-pill i{background:${i.accent}!important}.option-letter,.join-icon,.control-icon{background:${i.accent}55!important}`;
}

/* ---------------- competition window ---------------- */
function compWindow(c) { const t = serverNow(); if (!c) return 'none'; if (c.start && t < c.start) return 'before'; if (c.end && t > c.end) return 'after'; return 'open'; }

/* ---------------- results ---------------- */
function renderResults() {
  const c = S.pub && S.pub.competition;
  const rows = (S.pub && S.pub.leaderboard) || [];
  $('#participant-count').textContent = ar((S.pub && S.pub.participantCount) || 0);
  const label = (r) => r.name + (S.me && r.id === S.me.id ? ' (أنت)' : '');
  $('#results-sub').textContent = c ? `${c.name}: ١٠٠ نقطة لكل إجابة صحيحة، وعند التعادل يتقدم الأسبق.` : 'لا توجد مسابقة نشطة حاليًا.';
  const pod = $('#podium'); pod.replaceChildren();
  if (!rows.length) pod.append(el('div', { class: 'podium glass-panel', style: 'grid-column:1/-1' }, el('h3', { text: 'لا توجد نتائج بعد' }), el('p', { text: c ? 'أول إجابة صحيحة تتصدر اللوحة.' : 'تظهر النتائج هنا عند تفعيل مسابقة.' })));
  rows.slice(0, 3).forEach((r, i) => pod.append(el('div', { class: 'podium glass-panel' }, el('span', { class: 'medal ' + ['gold', 'silver', 'bronze'][i], text: ar(i + 1) }), el('h3', { text: label(r) }), el('p', { text: ar(r.points) + ' نقطة' }))));
  const rest = rows.slice(3, 50); const t = $('#results-table'); t.hidden = !rest.length; t.replaceChildren();
  t.append(el('div', {}, el('span', { text: 'الترتيب' }), el('span', { text: 'المشارك' }), el('span', { text: 'النقاط' })));
  rest.forEach((r, i) => t.append(el('div', {}, el('b', { text: ar(i + 4) }), el('span', { text: label(r) }), el('strong', { text: ar(r.points) }))));
}

/* ---------------- display ---------------- */
function setLive(text, on) { $('#live-pill span').textContent = text; $('#live-pill i').style.opacity = on ? 1 : 0.35; }
function renderFeatured() {
  const f = S.pub && S.pub.featured;
  $('#featured-message').hidden = !f; $('#stage-msg').hidden = !f;
  if (f) { $('#featured-text').textContent = '«' + f.text + '»'; $('#stage-msg-text').textContent = '«' + f.text + '»'; }
}
function setFeedback(t, ok) { const f = $('#feedback'); f.textContent = t || ''; f.className = 'feedback' + (t ? (ok ? ' success' : ' error') : ''); }
function status(t) { $('#participant-status').textContent = t || ''; }

function currentRec(q) {
  if (MODE === 'screen' && !S.kioskName) return null;
  return S.recQid === q.id ? S.rec : null;
}

function renderDisplay() {
  renderFeatured();
  const c = S.pub && S.pub.competition, q = S.pub && S.pub.question;
  if (S.run && (!q || S.run.qid !== q.id)) { stopRun(); setFeedback('انتهى عرض هذا السؤال.', false); }
  $('#round-label').textContent = c ? c.name : 'مسابقة رصف';
  const win = compWindow(c);
  const idle = (title, sub, pill) => {
    setLive(pill, false); $('#competition-title').textContent = title; $('#question-support').textContent = sub;
    $('#question-number').textContent = ''; $('#timer-row').hidden = true; $('#participant-entry').hidden = true;
    $('#options').replaceChildren(); status(''); if (!S.run && !S.kioskReset) setFeedback('');
  };
  if (!S.pub) return idle('جارٍ التحميل…', 'لحظات ويظهر المحتوى.', 'جارٍ الاتصال');
  if (!c) return idle('ترقّبوا المسابقة القادمة', 'تظهر المسابقة هنا فور تفعيلها من الإدارة.', 'لا توجد مسابقة نشطة');
  if (win === 'before') return idle('المسابقة تبدأ قريبًا', 'موعد البداية: ' + fmtDate(c.start), 'لم تبدأ بعد');
  if (win === 'after') return idle('انتهت المسابقة، شكرًا لمشاركتكم', 'تابع النتائج النهائية من تبويب «النتائج».', 'انتهت المسابقة');
  if (!q) return idle('ترقّبوا السؤال القادم', 'يظهر السؤال هنا فور تفعيله من الإدارة.', 'بانتظار السؤال');

  setLive('المسابقة نشطة', true);
  $('#question-number').textContent = q.index ? `السؤال ${ar(q.index)} من ${ar(q.total)}` : '';
  $('#competition-title').textContent = q.text;
  $('#question-support').textContent = TEXT_TYPES.includes(q.type) ? 'اكتب إجابتك وأرسلها قبل انتهاء الوقت.' : 'اختر إجابتك قبل انتهاء الوقت، وسيظهر لك التقييم فورًا.';
  if (S.run) return;

  const kiosk = MODE === 'screen';
  if (!kiosk && S.me && S.recQid !== q.id) ensureRecord(q.id);
  $('#participant-entry').hidden = false;
  const askName = kiosk || !S.me || S.renaming;
  $('#participant-name').hidden = !askName;
  if (!kiosk && S.renaming && !$('#participant-name').value) $('#participant-name').value = S.me ? S.me.name : '';
  const greet = $('#greet'); greet.hidden = askName; greet.replaceChildren();
  if (!askName && S.me) greet.append(document.createTextNode('أهلًا ' + S.me.name), el('button', { class: 'change-name', type: 'button', text: 'تغيير الاسم', onclick: () => { S.renaming = true; $('#participant-name').value = S.me.name; renderDisplay(); $('#participant-name').focus(); } }));
  const rec = currentRec(q);
  const done = !!(rec && rec.done);
  $('#timer-row').hidden = true;
  renderOptions(q, false, done ? rec : null);
  if (done) {
    $('#start-answer').hidden = true; status('');
    setFeedback(rec.correct === true ? 'أجبت إجابة صحيحة، حصلت على ١٠٠ نقطة.' : rec.correct === null ? 'وصلتنا إجابتك، شكرًا لمشاركتك.' : 'انتهت محاولاتك لهذا السؤال.', rec.correct !== false);
    return;
  }
  $('#start-answer').hidden = false; $('#start-answer').disabled = false;
  if (!S.kioskReset) setFeedback('');
  const used = rec ? rec.tries.length : 0;
  status(kiosk ? 'اكتب اسمك ثم اضغط «بدء المشاركة».'
    : !S.me ? `اكتب اسمك ثم اضغط «بدء المشاركة». لديك ${ar(q.attempts)} ${q.attempts > 1 ? 'محاولات' : 'محاولة'} و${ar(q.duration)} ثانية.`
    : used ? `بقي لك ${ar(q.attempts - used)} من ${ar(q.attempts)} محاولة. يبدأ العدّاد عند الضغط.`
    : `لديك ${ar(q.attempts)} ${q.attempts > 1 ? 'محاولات' : 'محاولة'} و${ar(q.duration)} ثانية. يبدأ العدّاد عند الضغط.`);
}

async function ensureRecord(qid) {
  if (S.recLoading === qid) return;
  S.recLoading = qid;
  try { const r = await api('POST', '/api/play/record', { questionId: qid }); if (S.pub && S.pub.question && S.pub.question.id === qid) { S.rec = r.record; S.recQid = qid; if (!S.run) renderDisplay(); } }
  catch { /* retried on the next poll */ }
  finally { S.recLoading = false; }
}

function renderOptions(q, enabled, rec) {
  const box = $('#options'); box.replaceChildren();
  if (TEXT_TYPES.includes(q.type)) {
    if (!enabled) return;
    const input = q.type === 'essay' ? el('textarea', { id: 'written-response', maxlength: '1000', placeholder: 'اكتب إجابتك هنا' }) : el('input', { id: 'written-response', maxlength: '200', placeholder: 'اكتب إجابتك هنا' });
    box.append(el('div', { class: 'written-answer' }, input, el('button', { id: 'submit-written', class: 'primary-button', type: 'button', text: 'إرسال الإجابة', onclick: () => { const v = $('#written-response').value.trim(); if (v) submit(v); else setFeedback('اكتب إجابتك أولًا.', false); } })));
    return;
  }
  const opts = q.type === 'truefalse' ? ['صح', 'خطأ'] : q.options;
  const live = currentRec(q);
  opts.forEach((o, i) => {
    const b = el('button', { class: 'option', type: 'button' }, el('span', { class: 'option-letter', text: LETTERS[i] }), el('span', { text: o }));
    b.disabled = !enabled; b.dataset.i = i;
    if (rec) {
      if (rec.tries.includes(i) && i !== rec.correctIndex) b.classList.add('wrong');
      if (i === rec.correctIndex) b.classList.add('correct');
    } else if (enabled && live && live.tries.includes(i)) { b.classList.add('wrong'); b.disabled = true; }
    b.onclick = () => submit(i, b);
    box.append(b);
  });
}

function playBody(q) {
  const body = { questionId: q.id };
  if (MODE === 'screen') { body.screenKey = SCREEN_KEY; body.name = S.kioskName; }
  return body;
}

async function startRun() {
  const q = S.pub && S.pub.question; if (!q) return;
  const btn = $('#start-answer');
  const typed = $('#participant-name').value.trim();
  if (MODE === 'screen') {
    if (typed.length < 2) { status('فضلاً اكتب اسمك (حرفين على الأقل).'); $('#participant-name').focus(); return; }
    S.kioskName = typed; S.kioskReset = false;
  } else if (!S.me || S.renaming) {
    if (typed.length < 2) { status('فضلاً اكتب اسمك (حرفين على الأقل).'); $('#participant-name').focus(); return; }
    if (!S.me || typed !== S.me.name) {
      btn.disabled = true;
      try { const r = await api('POST', '/api/join', { name: typed }); S.me = r.participant; S.recQid = null; }
      catch (e) { btn.disabled = false; status(e.message); return; }
    }
    S.renaming = false; updateChrome();
  }
  btn.disabled = true;
  let r;
  try { r = await api('POST', '/api/play/start', playBody(q)); }
  catch (e) { btn.disabled = false; status(e.message); if (MODE === 'screen') S.kioskName = ''; return; }
  S.rec = r.record; S.recQid = q.id;
  if (r.record.done) {
    renderDisplay();
    if (MODE === 'screen') scheduleKioskReset();
    return;
  }
  S.run = { qid: q.id, left: q.duration, busy: false, endsAt: Date.now() + q.duration * 1000 };
  btn.hidden = true; $('#participant-name').hidden = true; $('#greet').hidden = true; $('#timer-row').hidden = false;
  status(MODE === 'screen' ? `أهلًا ${S.kioskName}، بالتوفيق!` : 'بالتوفيق!');
  renderOptions(q, true); setFeedback('');
  tick(); S.run.timer = setInterval(tick, 250);
}
function tick() {
  const q = S.pub && S.pub.question; if (!S.run || !q) return;
  const left = Math.max(0, Math.ceil((S.run.endsAt - Date.now()) / 1000));
  $('#timer-number').textContent = ar(left); $('#timer-progress').style.width = (left / q.duration * 100) + '%';
  if (left <= 0 && !S.run.busy) endRun('انتهى الوقت.', false);
}
function scheduleKioskReset() {
  S.kioskReset = true;
  clearTimeout(scheduleKioskReset.t);
  scheduleKioskReset.t = setTimeout(() => { S.kioskName = ''; S.kioskReset = false; S.rec = null; S.recQid = null; $('#participant-name').value = ''; setFeedback(''); renderDisplay(); }, CFG.kioskResetMs);
}
function endRun(msg, ok) {
  if (S.run) clearInterval(S.run.timer);
  $$('.option, #written-response, #submit-written').forEach((b) => (b.disabled = true));
  setFeedback(msg, ok); S.run = null; $('#timer-row').hidden = true;
  if (MODE === 'screen') scheduleKioskReset();
  else setTimeout(() => { if (!S.run) renderDisplay(); }, 2500);
}
function stopRun() { if (S.run) { clearInterval(S.run.timer); S.run = null; } }

async function submit(value, btn) {
  const q = S.pub && S.pub.question; if (!S.run || S.run.busy || !q) return;
  S.run.busy = true;
  let r;
  try { r = await api('POST', '/api/play/answer', { ...playBody(q), value }); }
  catch (e) {
    if (!S.run) return;
    S.run.busy = false;
    if (['time_up', 'question_closed', 'closed', 'not_started'].includes(e.code)) return endRun(e.message, false);
    setFeedback(e.message, false); return;
  }
  if (!S.run) return;
  S.run.busy = false; S.rec = r.record; S.recQid = q.id;
  refreshPublic();
  const rec = r.record;
  if (TEXT_TYPES.includes(q.type)) return endRun('تم استلام إجابتك وتسجيلها. شكرًا لمشاركتك!', true);
  if (rec.correct === true) { if (btn) btn.classList.add('correct'); return endRun('إجابة صحيحة! سُجّلت لك ١٠٠ نقطة.', true); }
  if (btn) { btn.classList.add('wrong'); btn.disabled = true; }
  if (rec.triesLeft > 0) { setFeedback(`إجابة غير صحيحة، لديك ${ar(rec.triesLeft)} ${rec.triesLeft > 1 ? 'محاولات' : 'محاولة'} أخرى.`, false); return; }
  $$('.option').forEach((b) => { if (Number(b.dataset.i) === rec.correctIndex) b.classList.add('correct'); });
  endRun('انتهت محاولاتك، الإجابة الصحيحة موضحة باللون الأخضر.', false);
}
$('#start-answer').onclick = startRun;
$('#participant-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') startRun(); });

/* ---------------- employee messages ---------------- */
$('#send-message').onclick = async () => {
  const text = $('#employee-message').value.trim();
  const st = $('#message-status');
  if (text.length < 2) { st.textContent = 'اكتب رسالتك أولًا.'; return; }
  const btn = $('#send-message'); btn.disabled = true;
  try {
    if (!S.me) {
      const n = $('#message-name').value.trim() || $('#participant-name').value.trim();
      if (n.length < 2) { $('#message-name').hidden = false; $('#message-name').focus(); st.textContent = 'اكتب اسمك أولًا ليعرف فريق رصف صاحب الرسالة.'; return; }
      const r = await api('POST', '/api/join', { name: n }); S.me = r.participant; updateChrome(); renderDisplay();
    }
    st.textContent = 'جارٍ الإرسال…';
    await api('POST', '/api/messages', { text });
    $('#employee-message').value = ''; st.textContent = 'وصلت للإدارة، وتظهر بعد اعتمادها. تابع حالتها من «حسابي».';
  } catch (e) { st.textContent = e.message; }
  finally { btn.disabled = false; }
};

/* ---------------- LG screen ---------------- */
function renderScreen() {
  if (MODE !== 'screen' || !S.pub) return;
  const sc = S.pub.screen;
  if (sc === null) note('هذه الشاشة غير موجودة أو تغيّر رابطها. انسخ رابط الشاشة من لوحة الإدارة ← «شاشات العرض».');
  else note('');
  const media = sc && sc.media;
  const stage = $('#media-stage'); stage.hidden = !media;
  if (media) {
    const box = $('#stage-media');
    if (box.dataset.id !== String(media.id)) {
      box.dataset.id = String(media.id); box.replaceChildren(el('img', { src: media.url, alt: media.name || 'صورة العرض' }));
    }
  } else $('#stage-media').dataset.id = '';
}

/* ---------------- QR (vendored qrcode-generator, MIT) ---------------- */
function drawQR(target) {
  if (typeof window.qrcode !== 'function') return;
  const qr = window.qrcode(0, 'M'); qr.addData(EMPLOYEE_URL); qr.make();
  // The SVG is generated locally from our own origin URL (no user text).
  target.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  const svg = target.querySelector('svg'); if (svg) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'رمز QR: ' + EMPLOYEE_URL); }
}

/* ======================================================================
   Admin
   ====================================================================== */
const A = () => S.admin || { competitions: [], questions: [], groups: [], screens: [], events: [], media: [], pendingMessages: [], state: {} };
const isOwner = () => S.staff && S.staff.role === 'owner';
const activeComp = () => { const id = A().state.activeCompetitionId; return A().competitions.find((c) => c.id === id) || null; };
const compQuestions = (cid) => A().questions.filter((q) => q.competitionId === cid);
const byId = (list, id) => list.find((x) => x.id === id) || null;

/** Runs an admin action, shows a toast, then refreshes admin + public data. */
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); await Promise.all([refreshAdmin(true), refreshPublic(true)]); return r; }
  catch (e) { toast(e.message || 'تعذر الحفظ.'); if (e.status === 401) handleSignedOut(); throw e; }
}
const quiet = (p) => p.catch(() => {});
const setState = (patch, msg) => quiet(act(() => api('POST', '/api/admin/state', patch), msg));

function renderAdmin() {
  if (!S.staff || !S.admin || !$('#admin').classList.contains('active')) return;
  const a = A(); const c = activeComp();
  // competitions
  const cl = $('#competition-list'); cl.replaceChildren();
  if (!a.competitions.length) cl.append(el('div', { class: 'empty', text: 'لا توجد مسابقات بعد. أضف أول مسابقة من «+ مسابقة».' }));
  a.competitions.forEach((x) => {
    const on = x.id === a.state.activeCompetitionId; const w = compWindow(x);
    const status = on ? (w === 'before' ? 'نشطة · لم تبدأ' : w === 'after' ? 'نشطة · انتهت' : 'نشطة الآن') : (w === 'after' ? 'منتهية' : x.start ? 'مجدولة' : 'مسودة');
    cl.append(el('div', { class: 'resource-item' }, el('span', { class: 'ri-name', text: x.name }), el('span', { class: 'resource-status' + (on ? ' on' : ''), text: status }),
      el('span', { class: 'ri-actions' },
        on ? null : el('button', { class: 'mini-button', type: 'button', text: 'تفعيل', onclick: () => setState({ activeCompetitionId: x.id }, 'تم تفعيل «' + x.name + '».') }),
        w === 'open' ? el('button', { class: 'mini-button', type: 'button', text: 'إنهاء الآن', onclick: () => quiet(act(() => api('POST', `/api/admin/competitions/${x.id}/close`), 'تم إنهاء المسابقة.')) })
          : el('button', { class: 'mini-button', type: 'button', text: 'ابدأ الآن', onclick: () => quiet(act(() => api('POST', `/api/admin/competitions/${x.id}/open`), 'بدأت المسابقة الآن.')) }),
        el('button', { class: 'mini-button', type: 'button', text: 'تعديل', onclick: () => openResource('competition', x.id) }),
        confirmButton('حذف', () => act(() => api('DELETE', `/api/admin/competitions/${x.id}`), 'تم حذف المسابقة وأسئلتها.')))));
  });
  // groups
  const gl = $('#group-list'); gl.replaceChildren();
  if (!a.groups.length) gl.append(el('div', { class: 'empty', text: 'لا توجد مجموعات بعد. مثال: «الاستقبال» أو «الدور الثاني».' }));
  a.groups.forEach((g) => {
    const count = a.screens.filter((s) => s.groupId === g.id).length;
    gl.append(el('div', { class: 'resource-item' }, el('span', { class: 'ri-name', text: g.name }), el('strong', { text: ar(count) + ' شاشة' }),
      el('span', { class: 'ri-actions' }, contentSelect('', (v) => { if (!count) return toast('لا توجد شاشات في هذه المجموعة.'); quiet(act(() => api('POST', `/api/admin/groups/${g.id}/content`, { content: v }), (r) => 'تم تحديث ' + ar(r.updated) + ' شاشة.')); }, 'عرض على المجموعة…'),
        el('button', { class: 'mini-button', type: 'button', text: 'تعديل', onclick: () => openResource('group', g.id) }),
        confirmButton('حذف', () => act(() => api('DELETE', `/api/admin/groups/${g.id}`), 'تم حذف المجموعة.')))));
  });
  // screens
  const sl = $('#screen-list'); sl.replaceChildren();
  if (!a.screens.length) sl.append(el('div', { class: 'empty', text: 'أضف شاشة لتحصل على رابطها الخاص، ثم افتح الرابط في متصفح شاشة LG.' }));
  a.screens.forEach((s) => {
    const g = byId(a.groups, s.groupId); const url = ORIGIN + '/screen/' + s.key;
    const online = s.lastSeen && serverNow() - s.lastSeen < 180000;
    sl.append(el('div', { class: 'resource-item' },
      el('span', { class: 'ri-name' }, el('span', { class: 'dot' + (online ? ' on' : '') }), document.createTextNode(s.name), el('br'), el('small', { style: 'color:#8a7462', text: online ? 'متصلة الآن' : s.lastSeen ? 'آخر اتصال ' + ago(s.lastSeen) : 'لم تتصل بعد' })),
      el('span', { class: 'resource-status', text: g ? g.name : 'بدون مجموعة' }),
      el('span', { class: 'ri-actions' }, contentSelect(s.mediaId ? String(s.mediaId) : 'quiz', (v) => quiet(act(() => api('POST', `/api/admin/screens/${s.id}/content`, { content: v }), 'تم تحديث محتوى الشاشة.'))),
        el('button', { class: 'mini-button', type: 'button', text: 'نسخ الرابط', onclick: () => copy(url) }),
        el('button', { class: 'mini-button', type: 'button', text: 'تعديل', onclick: () => openResource('screen', s.id) }),
        confirmButton('رابط جديد', () => act(() => api('POST', `/api/admin/screens/${s.id}/rekey`), 'تم إنشاء رابط جديد؛ الرابط القديم توقف. حدّث رابط جهاز LG.')),
        confirmButton('حذف', () => act(() => api('DELETE', `/api/admin/screens/${s.id}`), 'تم حذف الشاشة.'))),
      el('div', { class: 'link-row', style: 'width:100%;border:0;padding-top:0' }, el('code', { text: url }))));
  });
  // events
  const evl = $('#event-list'); evl.replaceChildren();
  if (!a.events.length) evl.append(el('div', { class: 'empty', text: 'جهّز أول فعالية: مثل يوم التأسيس أو اليوم العالمي للسلامة.' }));
  a.events.forEach((e) => {
    const parts = [e.date ? fmtDay(e.date) : null, (byId(a.competitions, e.competitionId) || {}).name, (byId(a.media, e.mediaId) || {}).name, e.groupId ? (byId(a.groups, e.groupId) || {}).name : 'كل الشاشات'].filter(Boolean).join(' · ');
    evl.append(el('div', { class: 'resource-item' }, el('span', { class: 'ri-name' }, el('b', { text: e.name }), el('br'), el('small', { style: 'color:#8a7462', text: parts || 'باقة فارغة' })),
      el('span', { class: 'ri-actions' }, el('button', { class: 'mini-button', type: 'button', text: 'تشغيل', onclick: () => quiet(act(() => api('POST', `/api/admin/events/${e.id}/run`), (r) => 'تم تشغيل «' + e.name + '» على ' + ar(r.updated) + ' شاشة.')) }),
        el('button', { class: 'mini-button', type: 'button', text: 'تعديل', onclick: () => openResource('event', e.id) }),
        confirmButton('حذف', () => act(() => api('DELETE', `/api/admin/events/${e.id}`), 'تم حذف الفعالية.')))));
  });
  renderMessagesAdmin(); renderLinks(); renderMedia(); renderQuestionsAdmin();
  $('#identity-lock').hidden = isOwner();
  ['#logo-upload', '#primary-color', '#accent-color', '#background-color', '#save-identity', '#reset-identity'].forEach((x) => ($(x).disabled = !isOwner()));
  $('#schedule-for').textContent = c ? 'المسابقة النشطة: ' + c.name : 'فعّل مسابقة أولًا لضبط جدولتها.';
  if (document.activeElement !== $('#start-date') && document.activeElement !== $('#end-date') && !scheduleDirty) { $('#start-date').value = toLocalInput(c && c.start); $('#end-date').value = toLocalInput(c && c.end); }
  $('#save-schedule').disabled = !c;
  $('#next-question').disabled = !c; $('#stop-question').disabled = !a.state.activeQuestionId;
  if (!$('#pane-insights').hidden) renderInsights();
  if (!$('#pane-roles').hidden) renderRoles();
}

function contentSelect(value, onChange, placeholder) {
  const s = el('select', { 'aria-label': 'محتوى العرض' });
  if (placeholder) s.append(el('option', { value: '', text: placeholder }));
  s.append(el('option', { value: 'quiz', text: 'المسابقة' }));
  A().media.forEach((m) => s.append(el('option', { value: String(m.id), text: 'صورة: ' + (m.name || 'بدون اسم') })));
  s.value = value; s.onchange = () => { if (s.value) onChange(s.value); if (placeholder) s.value = ''; };
  return s;
}

function renderMessagesAdmin() {
  const a = A();
  $('#message-badge').textContent = ar(a.pendingCount || 0) + ' جديدة';
  const ml = $('#message-list'); ml.replaceChildren();
  const f = a.state.featured;
  if (f) ml.append(el('div', { class: 'resource-item message-row' }, el('span', { class: 'ri-name', text: 'المعروضة الآن: «' + f.text + '»' }), el('span', { class: 'ri-actions' }, el('button', { class: 'mini-button delete', type: 'button', text: 'إزالتها من الشاشات', onclick: () => setState({ featuredMessageId: null }, 'أُزيلت الرسالة من الشاشات.') }))));
  if (!a.pendingMessages.length) ml.append(el('div', { class: 'empty', text: 'لا توجد رسائل بانتظار المراجعة.' }));
  a.pendingMessages.slice(0, 12).forEach((m) => {
    ml.append(el('div', { class: 'resource-item message-row' }, el('span', { class: 'ri-name' }, el('small', { style: 'color:#8a7462', text: m.name + ' · ' + fmtDate(m.at) }), el('br'), document.createTextNode('«' + m.text + '»')),
      el('span', { class: 'ri-actions' }, el('button', { class: 'mini-button', type: 'button', text: 'اعتماد وعرض', onclick: () => quiet(act(() => api('POST', `/api/admin/messages/${m.id}/approve`), 'اعتُمدت الرسالة وتظهر الآن على الشاشات.')) }),
        el('button', { class: 'mini-button delete', type: 'button', text: 'إخفاء', onclick: () => quiet(act(() => api('POST', `/api/admin/messages/${m.id}/hide`), 'أُخفيت الرسالة.')) }))));
  });
}

function renderLinks() {
  const ll = $('#link-list'); ll.replaceChildren();
  const row = (label, url) => el('div', { class: 'link-row' }, el('div', { class: 'row' }, el('b', { text: label }), el('button', { class: 'mini-button', type: 'button', text: 'نسخ', onclick: () => copy(url) })), el('code', { text: url }));
  ll.append(row('رابط الموظفين (QR)', EMPLOYEE_URL), row('رابط الإدارة', ORIGIN + '/admin'));
  ll.append(el('div', { class: 'empty', text: 'رابط كل شاشة LG خاص بها، تجده تحت اسمها في «شاشات العرض».' }));
}

function renderMedia() {
  const a = A(); const g = $('#media-grid'); g.replaceChildren();
  if (!a.media.length) g.append(el('div', { class: 'empty', style: 'grid-column:1/-1', text: 'لا توجد صور بعد. ارفع صورة الفعالية لتعرضها على الشاشات.' }));
  a.media.forEach((m) => {
    const used = a.screens.filter((s) => s.mediaId === m.id).length;
    g.append(el('div', { class: 'media-tile' }, el('div', { class: 'thumb' }, el('img', { src: m.url, alt: m.name || '', loading: 'lazy' })),
      el('div', { class: 'mt-body' }, el('span', { class: 'mt-name', text: m.name || 'بدون اسم' }), el('span', { style: 'color:#8a7462', text: used ? 'معروضة على ' + ar(used) + ' شاشة' : 'غير معروضة' }),
        el('button', { class: 'mini-button', type: 'button', text: 'اعرضها على كل الشاشات', onclick: () => { if (!a.screens.length) return toast('أضف شاشة أولًا.'); quiet(act(() => api('POST', `/api/admin/media/${m.id}/show-all`), 'تم العرض على كل الشاشات.')); } }),
        confirmButton('حذف', () => act(() => api('DELETE', `/api/admin/media/${m.id}`), 'تم حذف الصورة.')))));
  });
}

/* ---- image compression before upload (keeps each file small enough for D1) ---- */
function loadImage(file) {
  return new Promise((res, rej) => { const url = URL.createObjectURL(file); const i = new Image(); i.onload = () => res({ img: i, url }); i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('bad')); }; i.src = url; });
}
async function compressImage(file, maxW, maxH, mime) {
  const { img, url } = await loadImage(file);
  try {
    let w = img.naturalWidth, h = img.naturalHeight; if (!w || !h) throw new Error('bad');
    const [MW, MH] = w > h ? [maxH, maxW] : [maxW, maxH];
    const scale = Math.min(1, MW / w, MH / h); w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d');
    if (mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    const qualities = mime === 'image/jpeg' ? [0.82, 0.72, 0.62, 0.5] : [undefined];
    for (const q of qualities) { const blob = await new Promise((r) => c.toBlob(r, mime, q)); if (blob && blob.size <= MAX_UPLOAD) return blob; }
    return null;
  } finally { URL.revokeObjectURL(url); }
}
const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });

$('#media-upload').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  const st = $('#upload-status'); let ok = 0;
  for (const [i, f] of files.entries()) {
    st.textContent = `جارٍ تجهيز ورفع ${ar(i + 1)} من ${ar(files.length)}…`;
    if (!/^image\//.test(f.type)) { toast('«' + f.name + '» ليس صورة. المنصة تقبل الصور فقط.'); continue; }
    try {
      const blob = await compressImage(f, 1080, 1920, 'image/jpeg');
      if (!blob) { toast('الصورة «' + f.name + '» أكبر من ١٫٥ ميجابايت حتى بعد الضغط.'); continue; }
      await api('POST', '/api/admin/media', { name: f.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'صورة', mime: 'image/jpeg', data: await toBase64(blob) });
      ok++;
    } catch (err) { toast(err && err.message && err.message !== 'bad' ? err.message : 'تعذر قراءة «' + f.name + '». جرّب صورة JPG أو PNG.'); }
  }
  st.textContent = ok ? 'تم رفع ' + ar(ok) + ' صورة.' : '';
  if (ok) await refreshAdmin(true);
});

function renderQuestionsAdmin() {
  const c = activeComp(); const box = $('#admin-questions'); box.replaceChildren();
  $('#questions-for').textContent = c ? 'أسئلة «' + c.name + '» بالترتيب. السؤال المعروض يظهر على كل الشاشات والجوالات.' : 'فعّل مسابقة لعرض أسئلتها.';
  if (!c) return;
  const qs = compQuestions(c.id);
  if (!qs.length) box.append(el('div', { class: 'empty', text: 'لا توجد أسئلة في هذه المسابقة. اضغط «+ إضافة سؤال».' }));
  const typeName = { choice: 'اختيارات متعددة', truefalse: 'صح أو خطأ', short: 'نص قصير', essay: 'إجابة مقالية' };
  qs.forEach((q, i) => {
    const on = A().state.activeQuestionId === q.id;
    const correctTxt = q.type === 'choice' ? q.options[q.correct] : q.type === 'truefalse' ? ['صح', 'خطأ'][q.correct] : null;
    box.append(el('div', { class: 'question-row' }, el('span', { text: ar(i + 1) }), el('p', { text: q.text }),
      on ? el('span', { class: 'resource-status on', text: 'معروض الآن' }) : el('button', { class: 'mini-button', type: 'button', text: 'اعرضه الآن', onclick: () => setState({ activeQuestionId: q.id }, 'السؤال معروض الآن.') }),
      el('button', { class: 'mini-button', type: 'button', text: 'تعديل', onclick: () => openEditor(q.id) }),
      confirmButton('حذف', () => act(() => api('DELETE', `/api/admin/questions/${q.id}`), 'تم حذف السؤال.')),
      el('span', { class: 'q-tags', text: [typeName[q.type], ar(q.attempts) + ' محاولة', ar(q.duration) + ' ثانية', correctTxt ? 'الصحيحة: ' + correctTxt : null, 'أجاب ' + ar(q.answered || 0)].filter(Boolean).join(' · ') })));
  });
}

$('#next-question').onclick = () => quiet(act(() => api('POST', '/api/admin/next-question'), 'تم عرض السؤال التالي.'));
$('#stop-question').onclick = () => setState({ activeQuestionId: null }, 'تم إيقاف السؤال.');

/* question editor */
function buildOptionInputs(type, values = []) {
  const box = $('#edit-options'); box.replaceChildren();
  $('#edit-correct-label').hidden = !['choice', 'truefalse'].includes(type);
  const sel = $('#edit-correct'); const keep = sel.value; sel.replaceChildren();
  if (type === 'choice') ['الأول', 'الثاني', 'الثالث', 'الرابع'].forEach((n, i) => { const inp = el('input', { 'data-option': i, maxlength: '120' }); inp.value = values[i] || ''; box.append(el('label', {}, 'الخيار ' + n + (i > 1 ? ' (اختياري)' : ''), inp)); sel.append(el('option', { value: i, text: 'الخيار ' + n })); });
  if (type === 'truefalse') sel.append(el('option', { value: 0, text: 'صح' }), el('option', { value: 1, text: 'خطأ' }));
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
function openEditor(id) {
  const c = activeComp();
  const q = id ? byId(A().questions, id) : { text: '', type: 'choice', options: ['', '', '', ''], correct: 0, attempts: 1, duration: 20, competitionId: c && c.id };
  if (!q) return;
  if (!A().competitions.length) return toast('أنشئ مسابقة أولًا من بطاقة «المسابقات».');
  const cs = $('#edit-comp'); cs.replaceChildren(); A().competitions.forEach((x) => cs.append(el('option', { value: x.id, text: x.name }))); cs.value = String(q.competitionId || A().competitions[0].id);
  $('#edit-id').value = id || ''; $('#edit-question').value = q.text; $('#edit-type').value = q.type; $('#edit-attempts').value = q.attempts; $('#edit-duration').value = q.duration;
  $('#edit-correct').replaceChildren(); buildOptionInputs(q.type, q.options); $('#edit-correct').value = String(q.correct ?? 0); $('#question-error').textContent = '';
  $('#edit-show').checked = !id || A().state.activeQuestionId !== id; $('#edit-show-label').hidden = !!id && A().state.activeQuestionId === id;
  $('#question-dialog').showModal();
}
$('#edit-type').onchange = () => buildOptionInputs($('#edit-type').value, $$('[data-option]').map((i) => i.value));
$('#new-question').onclick = () => openEditor(null);
$('#question-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#question-error');
  const type = $('#edit-type').value, text = $('#edit-question').value.trim();
  const clamp = (v, a, b, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  let options = [], correct = null;
  if (!text) { err.textContent = 'اكتب نص السؤال.'; return; }
  if (type === 'choice') {
    const raw = $$('[data-option]').map((i) => i.value.trim()); const ci = Number($('#edit-correct').value);
    if (!raw[ci]) { err.textContent = 'الإجابة الصحيحة تشير إلى خيار فارغ.'; return; }
    const kept = raw.map((v, i) => ({ v, i })).filter((x) => x.v); options = kept.map((x) => x.v); correct = kept.findIndex((x) => x.i === ci);
    if (options.length < 2) { err.textContent = 'أدخل خيارين على الأقل.'; return; }
  }
  if (type === 'truefalse') correct = Number($('#edit-correct').value);
  const id = $('#edit-id').value;
  const body = { competitionId: Number($('#edit-comp').value), text, type, options, correct, attempts: clamp($('#edit-attempts').value, 1, 10, 1), duration: clamp($('#edit-duration').value, 5, 300, 20) };
  const show = $('#edit-show').checked && !$('#edit-show-label').hidden;
  try {
    const r = await act(() => id ? api('PUT', `/api/admin/questions/${id}`, body) : api('POST', '/api/admin/questions', body), show ? null : 'تم حفظ السؤال.');
    $('#question-dialog').close();
    const qid = Number(id) || (r && r.id);
    // Show it right away: also activates its competition if another one is active.
    if (show && qid) await setState({ activeCompetitionId: body.competitionId, activeQuestionId: qid }, 'تم حفظ السؤال، وهو معروض الآن على الشاشات والجوالات.');
  }
  catch (x) { err.textContent = x.message; }
});

/* resource editor (competition / group / screen / event) */
function openResource(type, id) {
  const lists = { competition: A().competitions, group: A().groups, screen: A().screens, event: A().events };
  const cur = id ? byId(lists[type], id) || {} : {};
  const titles = { competition: 'مسابقة', group: 'مجموعة عرض', screen: 'شاشة عرض', event: 'فعالية' };
  $('#resource-title').textContent = (id ? 'تعديل ' : 'إضافة ') + titles[type]; $('#resource-type').value = type; $('#resource-id').value = id || ''; $('#resource-error').textContent = '';
  const w = $('#field-wrap'); w.replaceChildren();
  const field = (label, input) => w.append(el('label', {}, label, input));
  const input = (attrs, value) => { const i = el('input', attrs); i.value = value || ''; return i; };
  const select = (sid, opts, val, empty) => { const s = el('select', { id: sid }); if (empty) s.append(el('option', { value: '', text: empty })); opts.forEach((o) => s.append(el('option', { value: o.id, text: o.name }))); s.value = val ? String(val) : ''; return s; };
  const nameLabels = { competition: 'اسم المسابقة', group: 'اسم المجموعة', screen: 'اسم الشاشة', event: 'اسم الفعالية أو اليوم العالمي' };
  field(nameLabels[type], input({ id: 'r-name', maxlength: '80' }, cur.name));
  if (type === 'competition') { field('بداية المسابقة (اختياري)', input({ id: 'r-start', type: 'datetime-local' }, toLocalInput(cur.start))); field('نهاية المسابقة (اختياري)', input({ id: 'r-end', type: 'datetime-local' }, toLocalInput(cur.end))); }
  if (type === 'screen') field('مجموعة العرض', select('r-group', A().groups, cur.groupId, 'بدون مجموعة'));
  if (type === 'event') {
    field('تاريخ الفعالية', input({ id: 'r-date', type: 'date' }, cur.date ? toLocalInput(cur.date).slice(0, 10) : ''));
    field('المسابقة المرتبطة', select('r-comp', A().competitions, cur.competitionId, 'بدون مسابقة'));
    field('صورة الفعالية على الشاشات', select('r-media', A().media.map((m) => ({ id: m.id, name: m.name || 'بدون اسم' })), cur.mediaId, 'بدون صورة (تعرض المسابقة)'));
    field('الشاشات', select('r-egroup', A().groups, cur.groupId, 'كل الشاشات'));
  }
  $('#resource-dialog').showModal(); setTimeout(() => $('#r-name').focus(), 50);
}
$$('[data-resource]').forEach((b) => (b.onclick = () => openResource(b.dataset.resource)));
$('#resource-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = $('#resource-type').value, id = $('#resource-id').value, name = $('#r-name').value.trim();
  const err = $('#resource-error');
  if (!name) { err.textContent = 'اكتب الاسم.'; return; }
  const coll = { competition: 'competitions', group: 'groups', screen: 'screens', event: 'events' }[type];
  const data = { name };
  if (type === 'competition') { data.start = fromLocalInput($('#r-start').value); data.end = fromLocalInput($('#r-end').value); if (data.start && data.end && data.end <= data.start) { err.textContent = 'النهاية يجب أن تكون بعد البداية.'; return; } }
  if (type === 'screen') data.groupId = $('#r-group').value || null;
  if (type === 'event') { const d = $('#r-date').value; data.date = d ? new Date(d + 'T12:00').getTime() : null; data.competitionId = $('#r-comp').value || null; data.mediaId = $('#r-media').value || null; data.groupId = $('#r-egroup').value || null; }
  try { await act(() => id ? api('PUT', `/api/admin/${coll}/${id}`, data) : api('POST', `/api/admin/${coll}`, data), 'تم الحفظ.'); $('#resource-dialog').close(); }
  catch (x) { err.textContent = x.message; }
});
$$('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));

/* identity (owner) + schedule */
let pendingLogo = null, identityDirty = false, scheduleDirty = false;
['#primary-color', '#accent-color', '#background-color'].forEach((s) => $(s).addEventListener('input', () => (identityDirty = true)));
['#start-date', '#end-date'].forEach((s) => $(s).addEventListener('input', () => (scheduleDirty = true)));
$('#logo-upload').addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; pendingLogo = f; $('#identity-logo-preview img').src = URL.createObjectURL(f); });
$('#save-identity').onclick = async () => {
  const body = { primary: $('#primary-color').value, accent: $('#accent-color').value, background: $('#background-color').value };
  try {
    if (pendingLogo) {
      let blob = await compressImage(pendingLogo, 800, 800, 'image/png');
      if (!blob) blob = await compressImage(pendingLogo, 800, 800, 'image/jpeg');
      if (!blob) return toast('الشعار كبير جدًا، جرّب ملفًا أصغر.');
      body.logo = { mime: blob.type, data: await toBase64(blob) };
    }
    await act(() => api('PUT', '/api/admin/identity', body), 'تم حفظ الهوية على كل الأجهزة.');
    pendingLogo = null; identityDirty = false; $('#logo-upload').value = ''; applyIdentity();
  } catch (x) { if (x && x.message === 'bad') toast('تعذر قراءة ملف الشعار.'); }
};
$('#reset-identity').onclick = async () => { try { await act(() => api('POST', '/api/admin/identity/reset'), 'تمت استعادة هوية رصف.'); pendingLogo = null; identityDirty = false; $('#logo-upload').value = ''; applyIdentity(); } catch { /* toast shown */ } };
$('#save-schedule').onclick = async () => {
  const c = activeComp(); if (!c) return;
  const start = fromLocalInput($('#start-date').value), end = fromLocalInput($('#end-date').value);
  if (start && end && end <= start) return toast('النهاية يجب أن تكون بعد البداية.');
  try { await act(() => api('POST', `/api/admin/competitions/${c.id}/schedule`, { start, end }), 'تم حفظ الجدولة.'); scheduleDirty = false; } catch { /* toast shown */ }
};

/* ---------------- roles & staff ---------------- */
const ROLES = {
  owner: { name: 'مالك المنصة', how: 'حساب ببريد وكلمة مرور (يُنشأ مرة واحدة من صفحة الإعداد)', can: 'كل الصلاحيات: هوية الشركة والشعار، إضافة المديرين وحذفهم، المسابقات والأسئلة، الشاشات والصور، الرسائل، التحليلات والتصدير.' },
  manager: { name: 'مدير', how: 'حساب يضيفه المالك', can: 'إدارة المسابقات والأسئلة والجدولة، الشاشات والمجموعات والصور والفعاليات، اعتماد الرسائل، التحليلات والتصدير. لا يعدّل هوية الشركة ولا الحسابات.' },
  employee: { name: 'موظف', how: 'بدون حساب: يمسح QR ويكتب اسمه', can: 'المشاركة في المسابقات، إرسال رسائل للشاشة، متابعة النتائج وصفحة «حسابي».' },
  kiosk: { name: 'شاشة اللمس (LG)', how: 'رابط سري خاص بكل شاشة', can: 'عرض المسابقة أو الصورة، وتسجيل مشاركة من يكتب اسمه على الشاشة.' },
};
async function renderRoles() {
  const t = $('#role-table'); t.replaceChildren();
  t.append(el('div', { class: 'role-row' }, el('span', { text: 'الدور' }), el('span', { text: 'طريقة الدخول' }), el('span', { text: 'ما يقدر عليه' })));
  const mine = S.staff ? S.staff.role : null;
  ['owner', 'manager', 'employee', 'kiosk'].forEach((k) => t.append(el('div', { class: 'role-row' + (mine === k ? ' me' : '') }, el('b', { text: ROLES[k].name + (mine === k ? ' (أنت)' : '') }), el('span', { text: ROLES[k].how }), el('span', { text: ROLES[k].can }))));
  $('#staff-card').hidden = !isOwner();
  if (isOwner() && !renderRoles.loadingStaff) {
    renderRoles.loadingStaff = true;
    try { S.staffList = (await api('GET', '/api/admin/staff')).staff; } catch { /* keep previous */ } finally { renderRoles.loadingStaff = false; }
    renderStaff();
  }
  if (!renderRoles.loadingPeople) {
    renderRoles.loadingPeople = true;
    try { S.people = (await api('GET', '/api/admin/participants')).participants; } catch { /* keep previous */ } finally { renderRoles.loadingPeople = false; }
    renderPeople();
  }
}
function renderStaff() {
  const list = $('#staff-list'); list.replaceChildren();
  (S.staffList || []).forEach((s) => {
    const isMe = S.staff && s.id === S.staff.id;
    const row = el('div', { class: 'resource-item' },
      el('span', { class: 'ri-name' }, el('b', { text: s.name + (isMe ? ' (أنت)' : '') }), el('br'), el('small', { dir: 'ltr', style: 'color:#8a7462', text: s.email })),
      el('span', { class: 'resource-status' + (s.role === 'owner' ? ' on' : ''), text: s.role === 'owner' ? 'مالك المنصة' : s.must_change ? 'مدير · بانتظار تغيير كلمة المرور' : 'مدير' }));
    if (s.role === 'manager') {
      const pw = el('input', { dir: 'ltr', placeholder: 'كلمة مرور مؤقتة جديدة', minlength: '8', maxlength: '128', autocomplete: 'off', 'aria-label': 'كلمة مرور مؤقتة جديدة لـ ' + s.name });
      row.append(el('span', { class: 'ri-actions' },
        el('span', { class: 'reset-row' }, pw, el('button', { class: 'mini-button', type: 'button', text: 'إعادة تعيين', onclick: async () => { if (pw.value.length < 8) return toast('كلمة المرور ٨ أحرف على الأقل.'); try { await api('POST', `/api/admin/staff/${s.id}/reset`, { password: pw.value }); pw.value = ''; toast('تم تعيين كلمة مرور مؤقتة؛ سيُطلب منه تغييرها.'); renderRoles(); } catch (e) { toast(e.message); } } })),
        confirmButton('حذف الحساب', async () => { await api('DELETE', `/api/admin/staff/${s.id}`); toast('تم حذف الحساب.'); renderRoles(); })));
    }
    list.append(row);
  });
}
function renderPeople() {
  const list = $('#people-list'); list.replaceChildren();
  const people = S.people || [];
  if (!people.length) list.append(el('div', { class: 'empty', text: 'لم يشارك أحد بعد. أول من يمسح الرمز ويكتب اسمه يظهر هنا.' }));
  people.forEach((p) => list.append(el('div', { class: 'person' }, el('b', { text: p.name }),
    el('small', { text: (p.kiosk ? 'شاشة لمس' + (p.screenName ? ' · ' + p.screenName : '') + ' · ' : 'من الجوال · ') + ar(p.points) + ' نقطة إجمالًا' + (p.messages ? ' · ' + ar(p.messages) + ' رسالة' : '') }))));
}
$('#staff-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const err = $('#staff-error'); err.textContent = '';
  try {
    await api('POST', '/api/admin/staff', { name: $('#staff-name').value, email: $('#staff-email').value, password: $('#staff-password').value });
    toast('تمت إضافة المدير. أرسل له البريد وكلمة المرور المؤقتة.'); e.target.reset(); renderRoles();
  } catch (x) { err.textContent = x.message; }
});
$('#my-pw-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const err = $('#my-pw-error'); err.textContent = '';
  try { await api('POST', '/api/auth/password', { current: $('#my-pw-current').value, next: $('#my-pw-next').value }); e.target.reset(); toast('تم تغيير كلمة المرور.'); }
  catch (x) { err.textContent = x.message; }
});

/* ---------------- analytics ---------------- */
async function loadInsights(cid, force) {
  const key = cid + ':' + (S.admin ? S.admin.state && S.admin._v : '');
  if (!force && S.insights[cid] && S.insights[cid].key === key) return S.insights[cid].data;
  const data = await api('GET', `/api/admin/insights/${cid}`);
  S.insights[cid] = { key, data };
  return data;
}
async function renderInsights() {
  const sel = $('#insights-comp'); const comps = [...A().competitions].reverse();
  const keep = sel.value; sel.replaceChildren();
  comps.forEach((c) => sel.append(el('option', { value: c.id, text: c.name + (c.id === A().state.activeCompetitionId ? ' (النشطة)' : '') })));
  sel.value = comps.some((c) => String(c.id) === keep) ? keep : String(A().state.activeCompetitionId || (comps[0] && comps[0].id) || '');
  const cid = Number(sel.value) || null;
  const k = $('#insights-kpis'); const box = $('#insights-questions');
  $('#export-insights').disabled = !cid;
  if (!cid) { k.replaceChildren(); box.replaceChildren(el('div', { class: 'empty', text: 'أنشئ مسابقة لتظهر تحليلاتها هنا.' })); return; }
  let data;
  try { data = await loadInsights(cid); } catch (e) { box.replaceChildren(el('div', { class: 'empty', text: e.message })); return; }
  if (Number($('#insights-comp').value) !== cid) return;
  k.replaceChildren(); box.replaceChildren();
  const recs = data.answers; const qs = compQuestions(cid);
  const people = new Set(recs.map((x) => x.pid)); const graded = recs.filter((x) => x.correct !== null); const ok = graded.filter((x) => x.correct === 1);
  const tries = recs.reduce((n, x) => n + x.nTries, 0);
  const kpi = (label, val, sub) => el('div', { class: 'kpi glass-panel' }, el('span', { text: label }), el('b', { text: val }), sub ? el('small', { text: sub }) : null);
  k.append(kpi('المشاركون', ar(people.size)), kpi('إجابات مسجّلة', ar(recs.length), ar(tries) + ' محاولة'), kpi('نسبة الإجابات الصحيحة', graded.length ? ar(Math.round(ok.length / graded.length * 100)) + '٪' : '—'), kpi('الأسئلة', ar(qs.length)));
  if (!qs.length) box.append(el('div', { class: 'empty', text: 'لا توجد أسئلة في هذه المسابقة.' }));
  qs.forEach((q, i) => {
    const rs = recs.filter((x) => x.qid === q.id);
    const card = el('div', { class: 'iq glass-panel' });
    const okN = rs.filter((x) => x.correct === 1).length;
    card.append(el('div', { class: 'iq-head' }, el('h3', { text: ar(i + 1) + '. ' + q.text }), A().state.activeQuestionId === q.id ? el('span', { class: 'resource-status on', text: 'معروض الآن' }) : null));
    const avgTries = rs.length ? rs.reduce((n, x) => n + x.nTries, 0) / rs.length : 0;
    card.append(el('div', { class: 'iq-meta' }, el('span', { text: 'أجاب ' + ar(rs.length) }), TEXT_TYPES.includes(q.type) ? null : el('span', { text: 'الصحيحة ' + (rs.length ? ar(Math.round(okN / rs.length * 100)) + '٪' : '—') }), el('span', { text: 'متوسط المحاولات ' + (rs.length ? ar1(avgTries) : '—') })));
    if (TEXT_TYPES.includes(q.type)) {
      const ta = el('div', { class: 'text-answers' }); card.append(ta);
      if (!rs.length) ta.append(el('div', { class: 'empty', style: 'border:0', text: 'لا توجد إجابات بعد.' }));
      rs.forEach((x) => ta.append(el('div', {}, el('b', { text: x.name + (x.kiosk ? ' (شاشة لمس)' : '') + ': ' }), document.createTextNode(String(x.tries[x.tries.length - 1] ?? '')))));
    } else {
      const opts = q.type === 'truefalse' ? ['صح', 'خطأ'] : q.options;
      const counts = opts.map((_, j) => rs.filter((x) => x.tries.includes(j)).length); const max = Math.max(1, ...counts);
      const bars = el('div', { class: 'bars' });
      opts.forEach((o, j) => bars.append(el('div', { class: 'bar-row' + (j === q.correct ? ' ok' : '') }, el('span', { class: 'lbl', text: LETTERS[j] + '. ' + o + (j === q.correct ? ' ✓' : '') }), el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: 'width:' + (counts[j] / max * 100) + '%' })), el('span', { class: 'pct', text: ar(counts[j]) }))));
      card.append(bars, el('p', { class: 'empty', style: 'border:0;padding:0;margin-top:8px', text: 'الأعمدة تحسب كل من اختار الخيار في أي محاولة.' }));
    }
    box.append(card);
  });
}
$('#insights-comp').onchange = renderInsights;
$$('.admin-tab').forEach((b) => (b.onclick = () => {
  $$('.admin-tab').forEach((x) => x.classList.toggle('active', x === b));
  ['manage', 'insights', 'roles'].forEach((p) => ($('#pane-' + p).hidden = p !== b.dataset.pane));
  $('.admin-actions').hidden = b.dataset.pane !== 'manage';
  renderAdmin();
}));

/* ---------------- Excel export (SheetJS, vendored, lazy-loaded) ---------------- */
function loadXLSX() { return window.XLSX ? Promise.resolve() : new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = '/vendor/xlsx.full.min.js'; sc.onload = res; sc.onerror = rej; document.head.append(sc); }); }
async function exportExcel(cid) {
  if (!cid) return toast('اختر مسابقة أولًا.');
  toast('جارٍ تجهيز ملف Excel…');
  try { await loadXLSX(); } catch { return toast('تعذر تحميل أداة Excel، حدّث الصفحة وحاول.'); }
  let data; try { data = await loadInsights(cid, true); } catch (e) { return toast(e.message); }
  const comp = byId(A().competitions, cid) || data.competition; const qs = compQuestions(cid); const recs = data.answers;
  const qById = Object.fromEntries(qs.map((q) => [q.id, q]));
  const who = (x) => x.name + (x.kiosk ? ' (شاشة لمس)' : '');
  const when = (ms) => ms ? new Date(ms).toLocaleString('en-GB') : '';
  let rank = 0;
  const rowsResults = data.leaderboard.map((r) => ({ 'الترتيب': r.points > 0 ? ++rank : '', 'المشارك': who(r), 'النقاط': r.points, 'إجابات صحيحة': r.correctCount, 'أسئلة أجاب عنها': r.answered, 'آخر إجابة صحيحة': when(r.lastCorrect) }));
  const optText = (q, v) => typeof v === 'number' ? (q && q.type === 'truefalse' ? ['صح', 'خطأ'][v] : q && q.options[v]) : v;
  const rowsAnswers = recs.map((x) => { const q = qById[x.qid]; return { 'المشارك': who(x), 'السؤال': q ? q.text : '', 'المحاولات': x.tries.map((v) => optText(q, v)).join(' ← '), 'النتيجة': x.correct === 1 ? 'صحيحة' : x.correct === null ? 'نصية' : 'خاطئة', 'الوقت': when(x.at) }; });
  const rowsQ = qs.map((q, i) => { const rs = recs.filter((x) => x.qid === q.id); const okN = rs.filter((x) => x.correct === 1).length; return { '#': i + 1, 'السؤال': q.text, 'النوع': { choice: 'اختيارات', truefalse: 'صح أو خطأ', short: 'نص قصير', essay: 'مقالية' }[q.type], 'الإجابة الصحيحة': optText(q, q.correct) ?? '', 'عدد المجيبين': rs.length, 'نسبة الصحيحة': TEXT_TYPES.includes(q.type) || !rs.length ? '' : Math.round(okN / rs.length * 100) + '%' }; });
  const X = window.XLSX; const wb = X.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] };
  const add = (rows, name, cols) => { const ws = X.utils.json_to_sheet(rows.length ? rows : [{ 'لا توجد بيانات': '' }]); ws['!cols'] = cols.map((w) => ({ wch: w })); X.utils.book_append_sheet(wb, ws, name); };
  add(rowsResults, 'النتائج', [8, 30, 8, 12, 14, 22]); add(rowsAnswers, 'الإجابات', [30, 50, 40, 10, 22]); add(rowsQ, 'الأسئلة', [4, 50, 12, 30, 12, 12]);
  const buf = X.write(wb, { bookType: 'xlsx', type: 'array' });
  const safe = ((comp && comp.name) || 'مسابقة').replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const link = el('a', { href: url, download: 'نتائج ' + safe + '.xlsx', style: 'display:none' }); document.body.append(link); link.click();
  setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 2000);
  toast('تم تجهيز الملف.');
}
$('#export-insights').onclick = () => exportExcel(Number($('#insights-comp').value));
$('#export-results').onclick = () => exportExcel(S.pub && S.pub.competition && S.pub.competition.id);

/* ---------------- my account ---------------- */
async function renderAccount() {
  let d;
  try { d = await api('GET', '/api/account'); } catch (e) { $('#account-history').replaceChildren(el('div', { class: 'empty', text: e.message })); return; }
  const k = $('#account-kpis'); k.replaceChildren();
  const h = $('#account-history'); h.replaceChildren();
  const mm = $('#account-messages'); mm.replaceChildren();
  if (!d.participant) {
    $('#account-title').textContent = 'أهلًا بك';
    $('#account-role').textContent = 'اكتب اسمك في تبويب «المسابقة» وشارك، وبعدها يظهر هنا رصيدك وترتيبك ورسائلك.';
    h.append(el('div', { class: 'empty', text: 'لم تشارك بعد من هذا الجوال.' })); mm.append(el('div', { class: 'empty', text: 'لا توجد رسائل.' }));
    return;
  }
  $('#account-title').textContent = 'أهلًا ' + d.participant.name;
  $('#account-role').textContent = 'دورك: موظف. ' + ROLES.employee.can + ' حسابك محفوظ على هذا الجوال.';
  const total = d.competitions.reduce((n, c) => n + c.points, 0);
  const graded = d.answers.filter((a) => a.correct !== null); const correct = graded.filter((a) => a.correct === 1).length;
  const active = d.competitions.find((c) => c.id === d.activeCompetitionId);
  const kpi = (label, val, sub) => el('div', { class: 'kpi glass-panel' }, el('span', { text: label }), el('b', { text: val }), sub ? el('small', { text: sub }) : null);
  const activeName = S.pub && S.pub.competition ? S.pub.competition.name : null;
  k.append(kpi('نقاطي الإجمالية', ar(total)),
    kpi('ترتيبي الآن', active && active.points > 0 ? ar(active.rank) : '—', active && active.points > 0 ? 'من ' + ar(active.ranked) + ' في ' + active.name : activeName ? 'لم تسجّل نقاطًا في ' + activeName : 'لا توجد مسابقة نشطة'),
    kpi('أسئلة شاركت فيها', ar(d.answers.length)), kpi('دقة إجاباتي', graded.length ? ar(Math.round(correct / graded.length * 100)) + '٪' : '—'));
  if (!d.competitions.length) h.append(el('div', { class: 'empty', text: 'لم تشارك بعد. أول ما تجاوب على سؤال يظهر سجلك هنا.' }));
  d.competitions.forEach((c) => {
    const box = el('div', { class: 'hist' }, el('h3', {}, el('span', { text: c.name }), el('span', { class: 'tag wait', text: ar(c.points) + ' نقطة' + (c.points > 0 ? ' · المركز ' + ar(c.rank) : '') })));
    d.answers.filter((a) => a.cid === c.id).forEach((a) => {
      const tag = a.correct === 1 ? el('span', { class: 'tag ok', text: 'صحيحة' }) : a.correct === null ? el('span', { class: 'tag wait', text: 'إجابة نصية' }) : el('span', { class: 'tag no', text: a.nTries < a.attempts ? 'بقيت محاولات' : 'خاطئة' });
      box.append(el('div', { class: 'hist-q' }, el('span', { text: a.text }), tag));
    });
    h.append(box);
  });
  if (!d.messages.length) mm.append(el('div', { class: 'empty', text: 'لم ترسل رسائل بعد. تقدر ترسل من تبويب «المسابقة».' }));
  d.messages.forEach((m) => {
    const live = d.featuredId === m.id;
    const cls = m.status === 'approved' ? 'ok' : m.status === 'hidden' ? 'no' : 'wait';
    const label = live ? 'معروضة الآن' : m.status === 'approved' ? 'اعتُمدت' : m.status === 'hidden' ? 'لم تُعتمد' : 'بانتظار المراجعة';
    mm.append(el('div', { class: 'my-msg' }, el('span', { text: '«' + m.text + '»' }), el('span', {}, el('span', { class: 'tag ' + cls, text: label }), el('small', { style: 'color:#8a7462;margin-inline-start:8px', text: fmtDate(m.at) }))));
  });
}

/* ---------------- sign in / setup / password ---------------- */
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const err = $('#login-error'); err.textContent = '';
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  try { const r = await api('POST', '/api/auth/login', { email: $('#login-email').value, password: $('#login-password').value }); S.staff = r.staff; $('#login-password').value = ''; await enterAdmin(); }
  catch (x) { err.textContent = x.message; }
  finally { btn.disabled = false; }
});
$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const err = $('#setup-error'); err.textContent = '';
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  try { await api('POST', '/api/setup', { setupKey: $('#setup-key').value, name: $('#setup-name').value, email: $('#setup-email').value, password: $('#setup-password').value }); location.href = '/admin'; }
  catch (x) { err.textContent = x.message; btn.disabled = false; }
});
$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const err = $('#password-error'); err.textContent = '';
  try { await api('POST', '/api/auth/password', { current: $('#pw-current').value, next: $('#pw-next').value }); S.staff.mustChange = false; e.target.reset(); toast('تم تغيير كلمة المرور.'); await enterAdmin(); }
  catch (x) { err.textContent = x.message; }
});
$('#logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ } location.href = '/admin'; };

function handleSignedOut() { S.staff = null; S.admin = null; updateChrome(); openView('login'); }

async function enterAdmin() {
  updateChrome();
  if (S.staff.mustChange) { $('#password-intro').textContent = 'هذه كلمة مرور مؤقتة من مالك المنصة. اختر كلمة مرور جديدة خاصة بك قبل المتابعة.'; openView('password'); return; }
  await refreshAdmin(true);
  openView('admin');
}

/* ---------------- views & chrome ---------------- */
function updateChrome() {
  const admin = MODE === 'admin';
  $('#nav-admin').hidden = !(admin && S.staff && !S.staff.mustChange);
  $('#nav-account').hidden = admin || MODE === 'screen' || MODE === 'setup';
  $('#logout').hidden = !(admin && S.staff);
  $('#export-results').hidden = !(admin && S.staff && !S.staff.mustChange);
  const chip = $('#role-chip');
  if (admin && S.staff) { chip.hidden = false; chip.textContent = (S.staff.role === 'owner' ? 'مالك المنصة' : 'مدير') + ' · ' + S.staff.name; $('#admin-eyebrow').textContent = S.staff.role === 'owner' ? 'مالك المنصة' : 'مدير'; }
  else if (MODE === 'employee' && S.me) { chip.hidden = false; chip.textContent = 'موظف'; }
  else chip.hidden = true;
  $('#message-name').hidden = !!S.me || MODE === 'screen';
  $('.main-nav').hidden = MODE === 'setup' || (admin && !S.staff);
}

function openView(name) {
  if (name === 'admin' && !(S.staff && S.admin)) name = MODE === 'admin' ? 'login' : 'display';
  $$('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === name));
  if (name === 'admin') renderAdmin();
  if (name === 'results') renderResults();
  if (name === 'account') renderAccount();
  window.scrollTo(0, 0);
}
$$('.nav-link').forEach((b) => b.addEventListener('click', () => openView(b.dataset.view)));

function renderAll() {
  applyIdentity(); renderDisplay(); renderScreen(); renderResults();
  if ($('#admin').classList.contains('active')) renderAdmin();
}

/* ---------------- polling ---------------- */
let offline = false;
function setOffline(v) {
  if (v === offline) return; offline = v;
  if (v) note('انقطع الاتصال بالخادم، نحاول من جديد تلقائيًا…', true);
  else note(MODE === 'screen' && S.pub && S.pub.screen === null ? 'هذه الشاشة غير موجودة أو تغيّر رابطها. انسخ رابط الشاشة من لوحة الإدارة ← «شاشات العرض».' : '');
}
async function refreshPublic(force) {
  const url = '/api/state' + (MODE === 'screen' ? '?screen=' + encodeURIComponent(SCREEN_KEY) : '');
  const data = await poll(url, force).catch((e) => { if (e.code === 'network') setOffline(true); return null; });
  if (data) {
    setOffline(false);
    S.skew = data.serverNow - Date.now();
    const prevQ = S.pub && S.pub.question && S.pub.question.id;
    S.pub = data;
    if (MODE !== 'screen' && prevQ !== (data.question && data.question.id)) { S.recQid = null; S.rec = null; }
    renderAll();
  } else if (!offline) setOffline(false);
}
async function refreshAdmin(force) {
  if (!S.staff || S.staff.mustChange) return;
  try {
    const data = await poll('/api/admin', force);
    if (data) { data._v = (data.serverNow || 0); S.admin = data; S.skew = data.serverNow - Date.now(); applyIdentity(); renderAdmin(); }
  } catch (e) { if (e.status === 401 || e.status === 403) handleSignedOut(); }
}
function every(ms, fn) {
  const run = async () => {
    if (!document.hidden || MODE === 'screen') { try { await fn(); } catch { /* next round */ } }
    setTimeout(run, ms);
  };
  setTimeout(run, ms);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshPublic(); if (MODE === 'admin') refreshAdmin(); } });

/* ---------------- boot ---------------- */
async function boot() {
  $('#join-url').textContent = EMPLOYEE_URL;
  drawQR($('#qr-frame'));
  if (MODE === 'screen') { drawQR($('#stage-qr')); $('#message-box').hidden = true; $('#nav-account').hidden = true; }
  renderAll(); updateChrome();

  if (MODE === 'setup') {
    openView('setup');
    try {
      const st = await api('GET', '/api/setup');
      if (!st.needsSetup) { $('#setup-form').replaceChildren(el('p', { class: 'eyebrow', text: 'التشغيل لأول مرة' }), el('h1', { text: 'تم إعداد المنصة' }), el('p', { text: 'حساب مالك المنصة موجود. ادخل من صفحة الإدارة.' }), el('a', { class: 'primary-button', href: '/admin', style: 'display:block;text-align:center;text-decoration:none', text: 'الذهاب لصفحة الإدارة' })); }
      else if (!st.setupKeyConfigured || !st.secretConfigured) $('#setup-error').textContent = 'لم تُضبط المفاتيح السرية SETUP_KEY و SESSION_SECRET في إعدادات Cloudflare بعد. راجع دليل التشغيل.';
    } catch (e) { $('#setup-error').textContent = e.message; }
    return;
  }

  let me = null;
  try { me = await api('GET', '/api/me'); } catch (e) { note(e.message); }
  if (me) { S.me = me.participant && !me.participant.via_screen ? { id: me.participant.id, name: me.participant.name } : null; S.staff = me.staff; S.needsSetup = me.needsSetup; }
  updateChrome();
  await refreshPublic(true);

  if (MODE === 'admin') {
    if (S.staff) await enterAdmin();
    else { openView('login'); if (S.needsSetup) note('لم يُنشأ حساب مالك المنصة بعد. افتح صفحة الإعداد: ' + ORIGIN + '/setup', true); }
    every(CFG.adminPollMs, async () => { await refreshAdmin(); await refreshPublic(); });
  } else if (MODE === 'screen') {
    every(CFG.screenPollMs, () => refreshPublic());
    const beat = () => api('POST', `/api/screens/${encodeURIComponent(SCREEN_KEY)}/heartbeat`).catch(() => {});
    if (SCREEN_KEY) { beat(); setInterval(beat, CFG.heartbeatMs); }
  } else {
    every(CFG.phonePollMs, () => refreshPublic());
  }
  // Scheduled windows open/close on time without any server change.
  setInterval(() => { if (!S.run) { renderDisplay(); if ($('#admin').classList.contains('active') && !document.querySelector('dialog[open]')) renderAdmin(); } }, 30000);
}
boot();
})();
