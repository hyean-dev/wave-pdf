// Claude panel: ask about the open PDF, extract tables, auto-highlight passages
import { S, on } from './state.js';
import { $, el, icon, toast } from './util.js';
import { goToPage } from './viewer.js';
import { addAnnotations } from './annots.js';

const API = 'https://api.anthropic.com/v1/messages';
export const MODELS = [
  ['claude-sonnet-5-5', 'Sonnet 5.5 (기본)'],
  ['claude-opus-5-5', 'Opus 5.5 (정밀)'],
  ['claude-haiku-5-5', 'Haiku 5.5 (빠름·저렴)'],
];
export const getKey = () => localStorage.getItem('claudeKey') || '';
export const setKey = (k) => (k ? localStorage.setItem('claudeKey', k.trim()) : localStorage.removeItem('claudeKey'));
export const getModel = () => localStorage.getItem('claudeModel') || MODELS[0][0];
export const setModel = (m) => localStorage.setItem('claudeModel', m);

const SYSTEM = `너는 PDF 문서를 함께 읽는 금융 실무 보조자다. 사용자는 캐피탈사 IB 부서에서 대출 심사 자료를 다룬다.
규칙:
- 한국어로, 짧고 간결하게. 물어본 것에만 답한다.
- 모든 사실·수치 뒤에 근거 쪽을 (3쪽) 형식으로 붙인다.
- 문서에 적힌 사실과 너의 추론을 구분한다. 추론은 "추론:"으로 시작한다.
- 문서에 없는 내용은 "문서에 없음"이라고 쓰고 추측으로 채우지 않는다.
- 자료 안에서 수치가 서로 다르면 임의로 고르지 말고 둘 다 쪽 번호와 함께 표시한다.
- 영어 약어는 한글 정식 명칭을 먼저 쓰고 약어는 괄호로 병기한다(예: 부채상환능력비율(DSCR)).
- 딜의 승인 여부·투자 판단 같은 결론은 먼저 내리지 않는다. 요청받으면 근거와 함께 쟁점만 정리한다.
- 표는 마크다운 표로 쓴다.`;

let ctx = null;          // {docKey, block, pages, mode}
let history = [];        // [{role, content}]
let busy = false;
let panel, list, input;

on('docloaded', () => { ctx = null; history = []; if (list) renderEmpty(); });

// ---------------- document context ----------------
async function buildContext() {
  const doc = S.pdfDoc;
  const key = S.baseVer + ':' + doc.numPages;
  if (ctx?.docKey === key) return ctx;
  let text = '', total = 0;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    let t = '';
    for (const it of tc.items) { t += it.str || ''; if (it.hasEOL) t += '\n'; }
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    pages.push(t);
    total += t.length;
  }
  const LIMIT = 280000;
  if (total < 40 * doc.numPages && S.baseBytes.length < 25 * 1024 * 1024) {
    // scanned / image PDF → send the PDF itself
    let bin = '';
    const b = S.baseBytes;
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    ctx = { docKey: key, pages, mode: 'pdf', block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: btoa(bin) }, title: S.fileName, cache_control: { type: 'ephemeral' } } };
  } else {
    let used = 0;
    for (let i = 0; i < pages.length; i++) {
      const chunk = `\n\n===== ${i + 1}쪽 =====\n${pages[i]}`;
      if (used + chunk.length > LIMIT) { text += `\n\n[문서가 길어 ${i + 1}쪽부터는 생략됨]`; break; }
      text += chunk; used += chunk.length;
    }
    ctx = { docKey: key, pages, mode: 'text', block: { type: 'text', text: `<document name="${S.fileName}" pages="${doc.numPages}">${text}\n</document>`, cache_control: { type: 'ephemeral' } } };
  }
  return ctx;
}

// ---------------- API ----------------
async function callClaude(messages, { maxTokens = 16000, onText, onThinking } = {}) {
  const key = getKey();
  if (!key) throw new Error('NO_KEY');
  let r;
  try {
    r = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: getModel(), max_tokens: maxTokens, system: SYSTEM, messages, stream: true }),
    });
  } catch {
    throw new Error('api.anthropic.com에 연결하지 못했어요. 애드가드 같은 광고 차단 앱이나 회사망이 막고 있는지 확인해 주세요.');
  }
  if (!r.ok) {
    let msg = `${r.status}`;
    try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* */ }
    if (r.status === 401) msg = 'API 키가 올바르지 않아요 (Claude Console에서 발급한 sk-ant-api… 키인지 확인)';
    if (r.status === 429) msg = '요청이 많아 잠시 막혔어요. 조금 뒤 다시 해주세요';
    throw new Error(msg);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '', stop = null, thought = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const evt = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = evt.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
      if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') { out += d.delta.text; onText?.(out); }
      if (d.type === 'content_block_delta' && d.delta?.type === 'thinking_delta' && !out) { thought += (d.delta.thinking || '').length; onThinking?.(thought); }
      if (d.type === 'message_delta' && d.delta?.stop_reason) stop = d.delta.stop_reason;
      if (d.type === 'error') throw new Error(d.error?.message || 'API 오류');
    }
  }
  if (!out.trim()) {
    if (stop === 'max_tokens') throw new Error('Claude가 생각하는 데 답변 분량을 다 써버렸어요. 질문을 조금 좁혀서 다시 물어봐 주세요.');
    if (stop === 'refusal') throw new Error('Claude가 이 요청에는 답하지 않았어요. 표현을 바꿔 다시 물어봐 주세요.');
    throw new Error(`빈 답변이 왔어요 (종료 사유: ${stop || '알 수 없음'}). 다시 시도해 주세요.`);
  }
  if (stop === 'max_tokens') out += '\n\n_(답변이 길어 여기서 잘렸어요. "이어서"라고 보내면 계속해요.)_';
  return out;
}

// ---------------- markdown (minimal) ----------------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\((\d{1,4})\s*쪽\)|(\d{1,4})\s*쪽|p\.\s?(\d{1,4})/g, (m, a, b, c) => `<a class="pg" data-p="${a || b || c}">${m}</a>`);
}
function md(src) {
  const lines = src.split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l); i += 2;
      let t = '<div class="ai-table"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { t += '<tr>' + row(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++; }
      html += t + '</tbody></table></div>';
      continue;
    }
    if (/^#{1,4}\s/.test(l)) html += `<div class="ai-h">${inline(l.replace(/^#+\s/, ''))}</div>`;
    else if (/^\s*[-*•]\s+/.test(l)) {
      html += '<ul>';
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*[-*•]\s+/, ''))}</li>`; i++; }
      html += '</ul>'; continue;
    } else if (/^\s*\d+[.)]\s+/.test(l)) {
      html += '<ol>';
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`; i++; }
      html += '</ol>'; continue;
    } else if (l.trim()) html += `<p>${inline(l)}</p>`;
    i++;
  }
  return html;
}
function tablesToTSV(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
    if (/^\s*\|.*\|\s*$/.test(lines[i])) out.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\*\*/g, '')).join('\t'));
    else if (out.length && out[out.length - 1] !== '') out.push('');
  }
  return out.join('\n').trim();
}

// ---------------- UI ----------------
function bubble(role, text = '') {
  const b = el('div', { class: `ai-msg ${role}` });
  const body = el('div', { class: 'ai-body' });
  b.append(body);
  if (role === 'user') body.textContent = text;
  list.append(b);
  list.scrollTop = list.scrollHeight;
  return { b, body };
}
function finishBubble({ b, body }, text) {
  body.innerHTML = md(text);
  const tools = el('div', { class: 'ai-tools' },
    el('button', { class: 'btn small', onclick: () => copy(text, '답변을 복사했어요') }, '복사'));
  if (/^\s*\|.*\|\s*$/m.test(text)) tools.append(el('button', { class: 'btn small', onclick: () => copy(tablesToTSV(text), '표를 복사했어요 (엑셀에 붙여넣기)') }, '표 복사(엑셀)'));
  b.append(tools);
}
async function copy(t, msg) { try { await navigator.clipboard.writeText(t); toast(msg); } catch { toast('복사하지 못했어요'); } }

function renderEmpty() {
  list.replaceChildren(el('div', { class: 'ai-empty' },
    getKey() ? (S.pdfDoc ? '열린 문서에 대해 물어보거나 아래 버튼을 눌러 보세요.' : '먼저 PDF를 여세요.')
      : el('div', {}, '설정에서 Claude API 키를 넣으면 쓸 수 있어요. ', el('button', { class: 'btn small', onclick: keyDialog }, 'API 키 입력'))));
}

export function initAI() {
  input = el('textarea', { class: 'ai-input', rows: 2, placeholder: '문서에 대해 질문하기 (Enter 전송, Shift+Enter 줄바꿈)' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); } });
  list = el('div', { class: 'ai-list' });
  const modelSel = el('select', { class: 'ai-model', onchange: (e) => setModel(e.target.value) }, MODELS.map(([v, l]) => el('option', { value: v, selected: v === getModel() }, l)));
  panel = el('aside', { id: 'aiPanel', hidden: true },
    el('div', { class: 'ai-head' },
      el('span', { class: 'ai-title', html: `${icon('sparkles')} Claude` }), modelSel,
      el('button', { class: 'icon dark', title: 'API 키', html: icon('key'), onclick: keyDialog }),
      el('button', { class: 'icon dark', title: '대화 지우기', html: icon('trash'), onclick: () => { history = []; renderEmpty(); } }),
      el('button', { class: 'icon dark', title: '닫기', html: icon('x'), onclick: () => toggleAI(false) })),
    el('div', { class: 'ai-quick' },
      el('button', { class: 'btn small', onclick: () => ask('이 문서를 요약해줘. 거래 구조, 차주·담보·상환재원, 주요 조건(금액·금리·만기·약정), 확인이 필요한 쟁점 순서로.') }, '요약'),
      el('button', { class: 'btn small', onclick: () => ask('문서에 나온 재무 수치와 주요 대출 조건을 표로 뽑아줘. 열: 항목 | 값 | 단위·기준일 | 쪽. 자료 간 서로 다른 수치는 따로 표시해줘.', { maxTokens: 24000 }) }, '수치·조건 표'),
      el('button', { class: 'btn small', onclick: highlightFlow }, '찾아서 하이라이트')),
    list,
    el('div', { class: 'ai-compose' }, input, el('button', { class: 'icon dark ai-send', title: '보내기', html: icon('send'), onclick: () => ask(input.value) })));
  document.querySelector('#main').append(panel);
  list.addEventListener('click', (e) => { const a = e.target.closest('a.pg'); if (a) goToPage(+a.dataset.p); });
  renderEmpty();
}
export function toggleAI(force) {
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  document.body.classList.toggle('ai-open', open);
  if (open) { if (!history.length) renderEmpty(); setTimeout(() => input.focus(), 50); }
}

async function keyDialog() {
  const { modal } = await import('./util.js');
  const inp = el('input', { class: 'input', type: 'password', placeholder: 'sk-ant-api03-…', autocomplete: 'off' });
  inp.value = getKey();
  const v = await modal({
    title: 'Claude API 키',
    body: el('div', {}, inp, el('p', { class: 'muted small' }, '키는 이 기기의 브라우저에만 저장돼요. 기기마다 한 번씩 넣어야 해요. 문서 내용은 질문할 때 Anthropic API로 전송돼요.')),
    buttons: [{ label: '삭제', value: '' }, { label: '취소', value: null }, { label: '저장', primary: true, value: () => inp.value }],
  });
  if (v == null) return;
  setKey(v);
  toast(v ? 'API 키를 저장했어요' : 'API 키를 지웠어요');
  if (!history.length) renderEmpty();
}

async function ask(q, { maxTokens = 16000 } = {}) {
  q = (q || '').trim();
  if (!q || busy) return;
  if (!S.pdfDoc) return toast('먼저 PDF를 여세요');
  if (!getKey()) return keyDialog();
  busy = true;
  input.value = '';
  if (!history.length) list.replaceChildren();
  bubble('user', q);
  const out = bubble('assistant');
  out.body.innerHTML = '<span class="ai-typing">문서 읽는 중…</span>';
  try {
    const c = await buildContext();
    const msgs = history.length
      ? [...history, { role: 'user', content: q }]
      : [{ role: 'user', content: [c.block, { type: 'text', text: q }] }];
    out.body.innerHTML = '<span class="ai-typing">Claude가 문서를 읽고 있어요…</span>';
    const text = await callClaude(msgs, {
      maxTokens,
      onThinking: (n) => { out.body.innerHTML = `<span class="ai-typing">생각하는 중… (${Math.round(n / 100) / 10}k자)</span>`; },
      onText: (t) => { out.body.innerHTML = md(t); list.scrollTop = list.scrollHeight; },
    });
    history = [...msgs, { role: 'assistant', content: text }];
    finishBubble(out, text);
  } catch (e) {
    out.body.innerHTML = `<span class="ai-err">${esc(e.message === 'NO_KEY' ? 'API 키를 먼저 넣어주세요' : e.message)}</span>`;
  } finally { busy = false; }
}

// ---------------- find & highlight ----------------
async function highlightFlow() {
  if (!S.pdfDoc) return toast('먼저 PDF를 여세요');
  if (!getKey()) return keyDialog();
  const { promptDialog } = await import('./util.js');
  const what = await promptDialog('무엇을 찾아 하이라이트할까요?', '', { placeholder: '예: 상환재원, 기한이익상실 사유, 담보 관련 조항' });
  if (!what || busy) return;
  busy = true;
  if (!history.length) list.replaceChildren();
  bubble('user', `하이라이트: ${what}`);
  const out = bubble('assistant');
  out.body.innerHTML = '<span class="ai-typing">관련 부분 찾는 중…</span>';
  try {
    const c = await buildContext();
    if (c.mode !== 'text') throw new Error('스캔(이미지) PDF라 글자 위치를 찾을 수 없어요. 요약·질문은 가능해요.');
    const instr = `다음과 관련된 문서 부분을 찾아라: "${what}"
JSON만 출력한다. 다른 말은 쓰지 않는다.
{"items":[{"page":쪽번호(정수),"quote":"문서 원문을 글자 그대로 복사한 연속 구간(한 문장 이내, 150자 이하)","note":"관련 이유 한 줄"}]}
최대 15개. quote는 반드시 해당 쪽 원문과 정확히 일치해야 한다.`;
    const raw = await callClaude([{ role: 'user', content: [c.block, { type: 'text', text: instr }] }], {
      maxTokens: 16000,
      onThinking: (n) => { out.body.innerHTML = `<span class="ai-typing">관련 부분 찾는 중… (${Math.round(n / 100) / 10}k자 검토)</span>`; },
    });
    const json = JSON.parse(raw.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1'));
    const items = json.items || [];
    const found = [], missed = [];
    for (const it of items) {
      const rects = await locateQuote(it.page - 1, it.quote || '');
      if (rects?.length) found.push({ page: it.page - 1, type: 'highlight', rects, quote: it.quote, text: it.note || '', color: [1, 0.8, 0.5], opacity: 1, author: 'Claude' });
      else missed.push(it);
    }
    if (found.length) addAnnotations(found);
    let msg = `**${found.length}곳 하이라이트했어요.** 각 하이라이트에 이유를 메모로 달았어요.\n`;
    for (const f of found) msg += `\n- ${f.page + 1}쪽: ${f.text}`;
    if (missed.length) { msg += `\n\n위치를 못 찾은 ${missed.length}곳:`; for (const m of missed) msg += `\n- ${m.page}쪽: "${(m.quote || '').slice(0, 60)}" — ${m.note || ''}`; }
    if (!items.length) msg = '문서에서 관련 부분을 찾지 못했어요.';
    finishBubble(out, msg);
  } catch (e) {
    out.body.innerHTML = `<span class="ai-err">${esc(e.message === 'NO_KEY' ? 'API 키를 먼저 넣어주세요' : e.message)}</span>`;
  } finally { busy = false; }
}

const mctx = document.createElement('canvas').getContext('2d');
mctx.font = '10px sans-serif';
const norm = (ch) => ch.normalize('NFKC').toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―−]/g, '-');

/** Find a quote on a page and return highlight rects in PDF coordinates */
export async function locateQuote(p, quote) {
  if (!S.pdfDoc || p < 0 || p >= S.pdfDoc.numPages || !quote) return null;
  const tc = await (await S.pdfDoc.getPage(p + 1)).getTextContent();
  let flat = '';
  const map = [];
  tc.items.forEach((it, ii) => {
    const s = it.str || '';
    for (let k = 0; k < s.length; k++) { if (/\s/.test(s[k])) continue; const n = norm(s[k]); for (const c of n) { flat += c; map.push([ii, k]); } }
  });
  const q = [...quote].filter((c) => !/\s/.test(c)).map(norm).join('');
  if (q.length < 2) return null;
  let at = flat.indexOf(q), len = q.length;
  if (at < 0 && q.length > 24) { // fall back to matching start and end separately
    const a = flat.indexOf(q.slice(0, 16));
    const b = a >= 0 ? flat.indexOf(q.slice(-16), a) : -1;
    if (a >= 0 && b >= 0 && b - a < q.length * 1.6) { at = a; len = b + 16 - a; }
  }
  if (at < 0) return null;
  const spans = new Map();
  for (let i = at; i < at + len; i++) {
    const [ii, k] = map[i];
    const s = spans.get(ii);
    if (!s) spans.set(ii, [k, k]); else { s[0] = Math.min(s[0], k); s[1] = Math.max(s[1], k); }
  }
  const rects = [];
  for (const [ii, [k0, k1]] of spans) {
    const it = tc.items[ii];
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // rotated text not supported
    const h = Math.hypot(c, d) || Math.abs(d) || 10;
    const ws = [...it.str].map((ch) => mctx.measureText(ch).width || 5);
    const tot = ws.reduce((x, y) => x + y, 0) || 1;
    const pre = ws.slice(0, k0).reduce((x, y) => x + y, 0);
    const mid = ws.slice(k0, k1 + 1).reduce((x, y) => x + y, 0);
    const x1 = e + (it.width * pre) / tot, x2 = e + (it.width * (pre + mid)) / tot;
    rects.push([x1, f - h * 0.22, x2, f + h * 0.88].map((v) => Math.round(v * 100) / 100));
  }
  // merge rects on the same line
  rects.sort((r1, r2) => r2[1] - r1[1] || r1[0] - r2[0]);
  const merged = [];
  for (const r of rects) {
    const m = merged[merged.length - 1];
    if (m && Math.abs(m[1] - r[1]) < (m[3] - m[1]) * 0.5 && r[0] - m[2] < (m[3] - m[1]) * 1.5) { m[0] = Math.min(m[0], r[0]); m[2] = Math.max(m[2], r[2]); m[3] = Math.max(m[3], r[3]); }
    else merged.push([...r]);
  }
  return merged;
}
