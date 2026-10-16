/* sentence-engine.js — 句子練習引擎（規格見 SPEC-sentence-engine.md）
 * 掛 window.SentenceEngine。無外部依賴；ES2018；只用 DOM API + textContent。
 */
(function (root) {
  'use strict';

  var INTERVALS = [0, 1, 3, 7, 14];
  var MAX_BOX = INTERVALS.length - 1;
  var DEFAULT_KINDS = ['order', 'cloze', 'twoWords', 'type', 'parse'];
  var SESSION_SIZE = 10;
  var QTYPES = [
    { key: 'yesno', label: '是非問句 (Yes/No)' },
    { key: 'choice', label: '二選一問句 (A or B)' },
    { key: 'wh', label: '疑問詞問句 (Wh-)' },
    { key: 'request', label: '請求/建議 (Could you…?)' }
  ];

  /* ---------- 純函式 ---------- */

  function todayDefault() { return Math.floor(Date.now() / 86400000); }

  function shuffle(arr, rnd) {
    rnd = rnd || Math.random;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 比對用正規化：小寫、統一引號、去尾標點、壓縮空白、標點前不留空白
  function normalize(s) {
    s = String(s == null ? '' : s)
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .toLowerCase();
    s = s.replace(/\s+([.,;:!?。，；：！？])/g, '$1');
    s = s.replace(/[\s.,;:!?。，；：！？]+$/g, '');
    return s.replace(/\s+/g, ' ').trim();
  }

  function joinChunks(chunks) {
    var out = '';
    for (var i = 0; i < chunks.length; i++) {
      var c = String(chunks[i]);
      if (i === 0) out = c;
      else if (/^[.,;:!?。，；：！？]+$/.test(c)) out += c;
      else out += ' ' + c;
    }
    return out;
  }

  function checkOrder(placedChunks, answers) {
    var mine = normalize(joinChunks(placedChunks));
    for (var i = 0; i < answers.length; i++) {
      if (normalize(answers[i]) === mine) return true;
    }
    return false;
  }

  // 第一個錯位索引（對照 expectedChunks）；全對回 -1
  function firstWrongIndex(placedChunks, expectedChunks) {
    var n = Math.max(placedChunks.length, expectedChunks.length);
    for (var i = 0; i < n; i++) {
      if (normalize(placedChunks[i] || '') !== normalize(expectedChunks[i] || '')) return i;
    }
    return -1;
  }

  /* --- 打字組句：逐字比對 --- */

  // 切成字元單位：字（含 don't、well-known、1,200、3.5）或單一標點；比對只看字，標點不計分
  var TOKEN_RE = /[\p{L}\p{N}]+(?:(?:['\-.]|,(?=\p{N}))[\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
  function wordTokens(s) {
    s = String(s == null ? '' : s).replace(/[‘’`´]/g, "'").replace(/[‐-―]/g, '-');
    var m = s.match(TOKEN_RE) || [];
    return m.filter(function (t) { return /[\p{L}\p{N}]/u.test(t); });
  }

  function levenshtein(a, b) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  function similar(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    var n = Math.max(a.length, b.length);
    return n ? 1 - levenshtein(a, b) / n : 1;
  }

  // 使用者輸入 vs 一個標準答案 → {ops, miss, extra, wrong, caseErr, errors}
  // ops 依顯示順序：{t:'eq'|'case'|'sub'|'miss'|'extra', e:標準字, u:使用者字}
  function diffWords(userText, answerText) {
    var A = wordTokens(answerText), B = wordTokens(userText);
    var a = A.map(function (w) { return w.toLowerCase(); });
    var b = B.map(function (w) { return w.toLowerCase(); });
    var n = a.length, m = b.length, i, j;
    var L = [];
    for (i = 0; i <= n; i++) { L[i] = []; for (j = 0; j <= m; j++) L[i][j] = 0; }
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    var raw = [];
    i = 0; j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { raw.push({ t: 'eq', e: A[i], u: B[j] }); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { raw.push({ t: 'ins', u: B[j] }); j++; }
      else { raw.push({ t: 'del', e: A[i] }); i++; }
    }
    // 兩個相同字之間的差異段：相近的漏字＋多字配成「錯字」，其餘留為漏字／多字
    var ops = [];
    var k = 0;
    while (k < raw.length) {
      if (raw[k].t === 'eq') {
        ops.push({ t: raw[k].e === raw[k].u ? 'eq' : 'case', e: raw[k].e, u: raw[k].u });
        k++; continue;
      }
      var run = [];
      while (k < raw.length && raw[k].t !== 'eq') run.push(raw[k++]);
      var dels = run.filter(function (r) { return r.t === 'del'; });
      var inss = run.filter(function (r) { return r.t === 'ins'; });
      var pairOf = []; // dels 索引 → inss 索引
      var lastIns = -1;
      dels.forEach(function (d, di) {
        var best = -1, bestS = 0.4;
        for (var x = lastIns + 1; x < inss.length; x++) {
          var sc = similar(d.e, inss[x].u);
          if (sc > bestS) { bestS = sc; best = x; }
        }
        if (best >= 0) { pairOf[di] = best; lastIns = best; }
      });
      // 剩下的漏字與多字若數量相等，依序配成錯字（例：does → is）
      var leftD = [], leftI = [], usedI = {};
      pairOf.forEach(function (x) { if (x != null) usedI[x] = 1; });
      dels.forEach(function (d, di) { if (pairOf[di] == null) leftD.push(di); });
      inss.forEach(function (s, x) { if (!usedI[x]) leftI.push(x); });
      if (leftD.length && leftD.length === leftI.length) {
        leftD.forEach(function (di, q) { pairOf[di] = leftI[q]; usedI[leftI[q]] = 1; });
      }
      // 依標準句順序輸出；未配對的多字放在它前一個配對位置之後
      var insDone = {};
      function flushIns(upTo) {
        for (var x = 0; x <= upTo && x < inss.length; x++) {
          if (!insDone[x] && !usedI[x]) { ops.push({ t: 'extra', u: inss[x].u }); insDone[x] = 1; }
        }
      }
      dels.forEach(function (d, di) {
        if (pairOf[di] != null) { flushIns(pairOf[di] - 1); ops.push({ t: 'sub', e: d.e, u: inss[pairOf[di]].u }); insDone[pairOf[di]] = 1; }
        else ops.push({ t: 'miss', e: d.e });
      });
      flushIns(inss.length - 1);
    }
    var r = { ops: ops, miss: 0, extra: 0, wrong: 0, caseErr: 0 };
    ops.forEach(function (o) {
      if (o.t === 'miss') r.miss++; else if (o.t === 'extra') r.extra++;
      else if (o.t === 'sub') r.wrong++; else if (o.t === 'case') r.caseErr++;
    });
    r.errors = r.miss + r.extra + r.wrong;
    return r;
  }

  // 對所有可接受答案比對，取錯最少者；ok = 沒有漏／多／錯字（大小寫與標點只提示不扣分）
  function checkTyped(userText, answers) {
    var best = null, bestIdx = 0;
    (answers || []).forEach(function (ans, idx) {
      var d = diffWords(userText, ans);
      if (!best || d.errors < best.errors || (d.errors === best.errors && d.caseErr < best.caseErr)) { best = d; bestIdx = idx; }
    });
    if (!best) best = diffWords(userText, '');
    best.answer = (answers || [])[bestIdx] || '';
    best.ok = wordTokens(userText).length > 0 && best.errors === 0;
    return best;
  }

  // 提示：每個字只露首字母，例 "We n___ t_ s________ …"
  function typingHint(answer) {
    return wordTokens(answer).map(function (w) {
      return w.charAt(0) + w.slice(1).replace(/[\p{L}\p{N}]/gu, '_');
    }).join(' ');
  }

  function posOf(hint) {
    var m = /^\s*([a-zA-Z]+)\./.exec(hint || '');
    return m ? m[1].toLowerCase() : '';
  }

  // 建 cloze 題：回 {blankIndex, correct, options(已打亂)}
  function buildCloze(item, allSentences, rnd) {
    var blanks = item.blanks || [];
    if (!blanks.length) return null;
    var b = blanks[Math.floor((rnd || Math.random)() * blanks.length)];
    var correct = item.chunks[b.i];
    var pos = posOf(b.hint);
    var seen = {}; seen[normalize(correct)] = 1;
    var samePos = [], anyBlank = [], anyChunk = [];
    function add(list, text) {
      var k = normalize(text);
      if (!k || seen[k]) return;
      seen[k] = 1; list.push(text);
    }
    allSentences.forEach(function (s) {
      if (s === item || s.id === item.id) return;
      (s.blanks || []).forEach(function (bb) {
        var t = s.chunks[bb.i];
        if (t == null) return;
        if (pos && posOf(bb.hint) === pos) add(samePos, t); else add(anyBlank, t);
      });
    });
    allSentences.forEach(function (s) {
      if (s === item || s.id === item.id) return;
      s.chunks.forEach(function (c) { if (!/^[.,;:!?]+$/.test(c)) add(anyChunk, c); });
    });
    var pool = shuffle(samePos, rnd).concat(shuffle(anyBlank, rnd), shuffle(anyChunk, rnd));
    var opts = [correct].concat(pool.slice(0, 3));
    return { blankIndex: b.i, hint: b.hint || '', correct: correct, options: shuffle(opts, rnd) };
  }

  // Leitner 更新，回新狀態（不改輸入）
  function grade(state, ok, today) {
    var s = state ? { box: state.box || 0, due: state.due || today, seen: state.seen || 0, lapses: state.lapses || 0 }
                  : { box: 0, due: today, seen: 0, lapses: 0 };
    s.seen += 1;
    if (ok) {
      s.box = Math.min(MAX_BOX, s.box + 1);
      s.due = today + INTERVALS[s.box];
    } else {
      s.box = 0;
      s.due = today;
      s.lapses += 1;
    }
    return s;
  }

  function dueCount(items, getState, today) {
    if (today == null) today = todayDefault();
    items = items || {};
    var n = 0;
    ['sentences', 'questions'].forEach(function (k) {
      (items[k] || []).forEach(function (it) {
        var st = getState(it.id);
        if (st && st.due <= today) n++;
      });
    });
    return n;
  }

  function eligible(kind, it) {
    if (kind === 'parse') return !!(it.chunks && it.chunks.length && it.frames && it.frames.length && it.core);
    if (!it.chunks || it.chunks.length < 2 || !it.answers || !it.answers.length) return false;
    if (kind === 'cloze') return !!(it.blanks && it.blanks.length);
    if (kind === 'twoWords') return !!(it.words && it.words.length);
    return true;
  }

  // 選題：回 [{kind,item}]，到期優先，不足補新題（newLimit 限制）
  function pickSession(items, kinds, getState, today, opts) {
    opts = opts || {};
    var size = opts.size || SESSION_SIZE;
    var newLeft = opts.dailyNew == null ? 15 : opts.dailyNew;
    var rnd = opts.rnd || Math.random;
    var used = {};
    var out = [];
    function pool(kind) { return kind === 'parse' ? (items.questions || []) : (items.sentences || []); }
    function pick(kind) {
      var p = pool(kind).filter(function (it) { return !used[it.id] && eligible(kind, it); });
      var due = p.filter(function (it) { var s = getState(it.id); return s && s.due <= today; });
      if (due.length) {
        due.sort(function (a, b) { return getState(a.id).due - getState(b.id).due; });
        return due[0];
      }
      if (newLeft > 0) {
        var fresh = p.filter(function (it) { return !getState(it.id); });
        if (fresh.length) { newLeft--; return fresh[Math.floor(rnd() * fresh.length)]; }
      }
      return null;
    }
    var i = 0, guard = 0;
    while (out.length < size && guard++ < size * kinds.length * 2) {
      var got = null;
      for (var t = 0; t < kinds.length && !got; t++) {
        var k = kinds[(i + t) % kinds.length];
        var it = pick(k);
        if (it) { got = { kind: k, item: it }; used[it.id] = 1; }
      }
      if (!got) break;
      out.push(got);
      i++;
    }
    return out;
  }

  /* ---------- DOM 小工具 ---------- */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(cls, text, onClick) {
    var b = el('button', cls, text);
    b.setAttribute('type', 'button');
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  // 說明區塊：item.note（字串陣列）；ok=true 預設收合並給切換鈕；沒有 note 回 null
  function noteBlock(item, ok) {
    var notes = item && item.note;
    if (!notes || !notes.length) return null;
    var wrap = el('div', 'se-note-wrap');
    var box = el('div', 'se-note');
    notes.forEach(function (line) {
      var row = el('p', 'se-note-line');
      var m = /^([^：:]{1,8})[：:]\s*([\s\S]*)$/.exec(String(line));
      if (m) { row.appendChild(el('span', 'se-note-tag', m[1])); row.appendChild(document.createTextNode(m[2])); }
      else row.appendChild(document.createTextNode(String(line)));
      box.appendChild(row);
    });
    if (ok) {
      box.hidden = true;
      var t = btn('se-note-toggle', '看說明', function () {
        box.hidden = !box.hidden;
        t.textContent = box.hidden ? '看說明' : '收起說明';
      });
      wrap.appendChild(t);
    }
    wrap.appendChild(box);
    return wrap;
  }
  function insertAfter(ref, node) { if (node && ref.parentNode) ref.parentNode.insertBefore(node, ref.nextSibling); }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ---------- 引擎 ---------- */

  function create(opts) {
    opts = opts || {};
    var mount = opts.mount;
    var items = opts.items || {};
    var kinds = (opts.kinds && opts.kinds.length ? opts.kinds : DEFAULT_KINDS).filter(function (k) { return DEFAULT_KINDS.indexOf(k) >= 0; });
    var getState = opts.getState || function () { return undefined; };
    var setState = opts.setState || function () {};
    var speak = opts.speak || function () {};
    var onResult = opts.onResult || function () {};
    var onDone = opts.onDone || function () {};
    var todayFn = opts.today || todayDefault;
    var dailyNew = opts.dailyNew == null ? 15 : opts.dailyNew;
    var sessionSize = opts.size || SESSION_SIZE;

    var queue = [], pos = 0, startedAt = 0, destroyed = false;
    var summary = null, root_ = null;

    function sentences() { return items.sentences || []; }

    function start() {
      if (destroyed) return;
      var today = todayFn();
      queue = pickSession(items, kinds, getState, today, { size: sessionSize, dailyNew: dailyNew });
      pos = 0;
      summary = { total: queue.length, correct: 0, byKind: {} };
      if (!root_) { root_ = el('div', 'se-root'); mount.appendChild(root_); }
      if (!queue.length) { renderEmpty(); return; }
      renderQuestion();
    }

    function renderEmpty() {
      clear(root_);
      root_.appendChild(el('p', 'se-empty', '目前沒有到期或可出的新題。'));
    }

    function finishItem(kind, item, ok, extra) {
      var today = todayFn();
      setState(item.id, grade(getState(item.id), ok, today));
      var r = { itemId: item.id, kind: kind, ok: ok, ms: Date.now() - startedAt };
      if (extra) for (var k in extra) r[k] = extra[k];
      summary.byKind[kind] = summary.byKind[kind] || { n: 0, ok: 0 };
      summary.byKind[kind].n++;
      if (ok) { summary.byKind[kind].ok++; summary.correct++; }
      try { onResult(r); } catch (e) { /* 宿主錯誤不影響引擎 */ }
    }

    function nextBtn(label) {
      return btn('se-btn se-next', label || (pos + 1 >= queue.length ? '完成' : '下一題'), function () {
        pos++;
        if (pos >= queue.length) renderSummary(); else renderQuestion();
      });
    }

    function renderSummary() {
      clear(root_);
      root_.appendChild(el('h3', 'se-title', '本輪完成'));
      root_.appendChild(el('p', 'se-sum', '答對 ' + summary.correct + ' / ' + summary.total));
      var ul = el('ul', 'se-sumlist');
      Object.keys(summary.byKind).forEach(function (k) {
        ul.appendChild(el('li', '', kindLabel(k) + '：' + summary.byKind[k].ok + ' / ' + summary.byKind[k].n));
      });
      root_.appendChild(ul);
      try { onDone(summary); } catch (e) {}
    }

    function header(kind, item, textToSpeak) {
      var h = el('div', 'se-head');
      h.appendChild(el('span', 'se-progress', (pos + 1) + ' / ' + queue.length));
      h.appendChild(el('span', 'se-kind', kindLabel(kind)));
      var tts = btn('se-tts', '🔊', function () { speak(textToSpeak); });
      tts.setAttribute('aria-label', '朗讀');
      h.appendChild(tts);
      return h;
    }
    function kindLabel(k) {
      return { order: '積木排序', cloze: '骨架挖空', twoWords: '兩字造句', type: '打字組句', parse: '問句拆解' }[k] || k;
    }

    function renderQuestion() {
      clear(root_);
      startedAt = Date.now();
      var q = queue[pos];
      if (q.kind === 'order') renderOrder(q.item, 'order', false);
      else if (q.kind === 'twoWords') renderTwoWords(q.item);
      else if (q.kind === 'cloze') renderCloze(q.item);
      else if (q.kind === 'type') renderType(q.item);
      else renderParse(q.item);
    }

    /* --- order / twoWords 的排序部分 --- */
    function renderOrder(item, kind, skipHeader, extra) {
      var main = item.answers[0];
      if (!skipHeader) { clear(root_); }
      root_.appendChild(header(kind, item, main));
      root_.appendChild(el('p', 'se-zh', item.zh));
      if (kind === 'twoWords' && item.words) root_.appendChild(wordsRow(item));
      var answerArea = el('div', 'se-answer');
      var bank = el('div', 'se-bank');
      var msg = el('div', 'se-msg');
      var actions = el('div', 'se-actions');
      root_.appendChild(answerArea); root_.appendChild(bank); root_.appendChild(msg); root_.appendChild(actions);

      var order = shuffle(item.chunks.map(function (c, i) { return i; }));
      // 避免剛好排成原序
      if (order.length > 1 && order.every(function (v, i) { return v === i; })) order.push(order.shift());
      var placed = []; // chunk 索引
      var done = false;
      var chipBtns = {};

      var checkBtn = btn('se-btn se-check', '檢查', check);
      checkBtn.disabled = true;
      var resetBtn = btn('se-btn se-ghost', '重排', function () { if (done) return; placed = []; redraw(); });
      actions.appendChild(checkBtn); actions.appendChild(resetBtn);

      function redraw() {
        clear(answerArea); clear(bank);
        placed.forEach(function (ci, pi) {
          var b = btn('se-chip se-placed', item.chunks[ci], function () {
            if (done) return;
            placed.splice(pi, 1); redraw();
          });
          b.setAttribute('data-pos', String(pi));
          answerArea.appendChild(b);
        });
        if (!placed.length) answerArea.appendChild(el('span', 'se-placeholder', '點下方積木依序排入'));
        order.forEach(function (ci) {
          var used = placed.indexOf(ci) >= 0;
          var b = btn('se-chip' + (used ? ' se-used' : ''), item.chunks[ci], function () {
            if (done || used) return;
            placed.push(ci); redraw();
          });
          b.disabled = used;
          bank.appendChild(b);
        });
        checkBtn.disabled = done || placed.length !== item.chunks.length;
      }

      function check() {
        if (done) return;
        done = true;
        var texts = placed.map(function (ci) { return item.chunks[ci]; });
        var ok = checkOrder(texts, item.answers);
        if (ok) {
          msg.className = 'se-msg se-ok'; msg.textContent = '正確！';
          speak(main);
        } else {
          msg.className = 'se-msg se-err';
          var w = firstWrongIndex(texts, item.chunks);
          var kids = answerArea.childNodes;
          if (w >= 0 && kids[w]) kids[w].className += ' se-wrong';
          msg.textContent = '正解：' + main;
        }
        insertAfter(msg, noteBlock(item, ok));
        checkBtn.disabled = true;
        finishItem(kind, item, ok, extra);
        actions.appendChild(nextBtn());
      }
      redraw();
    }

    function wordsRow(item) {
      var r = el('div', 'se-words');
      item.words.forEach(function (w) { r.appendChild(el('span', 'se-word', w)); });
      return r;
    }

    function renderTwoWords(item) {
      root_.appendChild(header('twoWords', item, item.answers[0]));
      root_.appendChild(el('p', 'se-zh', item.zh));
      root_.appendChild(wordsRow(item));
      root_.appendChild(el('p', 'se-hint', '先在心裡用這兩個字造句，想好再翻面。'));
      var row = el('div', 'se-actions');
      function flip(self) {
        clear(root_);
        renderOrder(item, 'twoWords', true, { selfEval: self });
      }
      row.appendChild(btn('se-btn', '我會（想好了）', function () { flip('know'); }));
      row.appendChild(btn('se-btn se-ghost', '不會', function () { flip('unknown'); }));
      root_.appendChild(row);
    }

    /* --- type：看中文自己打整句 --- */
    function renderType(item) {
      var main = item.answers[0];
      root_.appendChild(header('type', item, main));
      root_.appendChild(el('p', 'se-zh', item.zh));
      var hintEl = el('p', 'se-hint se-type-hint');
      hintEl.hidden = true;
      root_.appendChild(hintEl);
      var input = el('textarea', 'se-type-input');
      input.setAttribute('rows', '2');
      input.setAttribute('placeholder', '用英文打出整句…');
      input.setAttribute('aria-label', '輸入整句');
      // 大小寫也是練習的一部分：關掉自動大寫／自動校正
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('enterkeyhint', 'done');
      input.setAttribute('lang', opts.lang || 'en');
      root_.appendChild(input);
      var result = el('div', 'se-type-result');
      var msg = el('div', 'se-msg');
      var actions = el('div', 'se-actions');
      root_.appendChild(actions); root_.appendChild(result); root_.appendChild(msg);
      var done = false, hinted = false;

      var checkBtn = btn('se-btn se-check', '檢查', function () { check(false); });
      checkBtn.disabled = true;
      var hintBtn = btn('se-btn se-ghost', '提示', function () {
        if (done) return;
        hinted = true; hintEl.textContent = '提示：' + typingHint(main); hintEl.hidden = false;
        hintBtn.disabled = true;
      });
      var giveUpBtn = btn('se-btn se-ghost', '不會，看答案', function () { check(true); });
      actions.appendChild(checkBtn); actions.appendChild(hintBtn); actions.appendChild(giveUpBtn);

      input.addEventListener('input', function () { checkBtn.disabled = done || !input.value.trim(); });
      input.addEventListener('keydown', function (e) {
        // Enter 送出；輸入法組字中（isComposing / 229）不攔
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          if (!done && input.value.trim()) check(false);
        }
      });
      // 手機鍵盤彈出後把輸入框捲到可視區中間，避免被鍵盤蓋住
      function keepVisible() {
        if (!input.isConnected) { if (root.visualViewport) root.visualViewport.removeEventListener('resize', keepVisible); return; }
        setTimeout(function () {
          if (!done && document.activeElement === input && input.scrollIntoView) input.scrollIntoView({ block: 'center' });
        }, 300);
      }
      input.addEventListener('focus', keepVisible);
      if (root.visualViewport) root.visualViewport.addEventListener('resize', keepVisible);

      function check(gaveUp) {
        if (done) return;
        done = true;
        if (root.visualViewport) root.visualViewport.removeEventListener('resize', keepVisible);
        var typed = input.value;
        var r = checkTyped(gaveUp ? '' : typed, item.answers);
        if (gaveUp) r.answer = main;
        var ok = !gaveUp && r.ok;
        input.readOnly = true;
        input.blur();
        checkBtn.disabled = true; hintBtn.disabled = true; giveUpBtn.disabled = true;
        if (!gaveUp) result.appendChild(diffLine(r));
        if (!gaveUp && (r.errors || r.caseErr)) result.appendChild(legend(r));
        if (ok && !r.caseErr) { msg.className = 'se-msg se-ok'; msg.textContent = '正確！'; }
        else if (ok) { msg.className = 'se-msg se-warn'; msg.textContent = '單字全對，但大小寫要注意。正解：' + r.answer; }
        else {
          msg.className = 'se-msg se-err';
          var parts = [];
          if (r.miss) parts.push('漏 ' + r.miss + ' 字');
          if (r.extra) parts.push('多 ' + r.extra + ' 字');
          if (r.wrong) parts.push('錯 ' + r.wrong + ' 字');
          msg.textContent = (gaveUp ? '' : (parts.length ? parts.join('・') + '。' : '')) + '正解：' + r.answer;
        }
        insertAfter(msg, noteBlock(item, ok));
        if (ok) speak(main);
        finishItem('type', item, ok, {
          typed: typed, miss: r.miss, extra: r.extra, wrong: r.wrong, caseErr: r.caseErr, hinted: hinted, gaveUp: !!gaveUp
        });
        var nb = nextBtn();
        actions.appendChild(nb);
        if (result.scrollIntoView) result.scrollIntoView({ block: 'nearest' });
      }

      function diffLine(r) {
        var line = el('p', 'se-diff');
        line.appendChild(el('span', 'se-diff-label', '你的答案'));
        r.ops.forEach(function (o, i) {
          if (i > 0) line.appendChild(document.createTextNode(' '));
          if (o.t === 'eq') line.appendChild(el('span', 'se-tk', o.u));
          else if (o.t === 'case') {
            var c = el('span', 'se-tk se-tk-case', o.u); c.title = '大小寫：' + o.e;
            line.appendChild(c); line.appendChild(el('span', 'se-tk-fix', o.e));
          } else if (o.t === 'sub') {
            line.appendChild(el('s', 'se-tk se-tk-wrong', o.u)); line.appendChild(el('span', 'se-tk-fix', o.e));
          } else if (o.t === 'miss') line.appendChild(el('span', 'se-tk se-tk-miss', o.e));
          else if (o.t === 'extra') line.appendChild(el('s', 'se-tk se-tk-extra', o.u));
        });
        return line;
      }
      function legend(r) {
        var g = el('p', 'se-legend');
        if (r.miss) g.appendChild(el('span', 'se-tk se-tk-miss', '漏字'));
        if (r.extra) g.appendChild(el('s', 'se-tk se-tk-extra', '多字'));
        if (r.wrong) g.appendChild(el('s', 'se-tk se-tk-wrong', '錯字'));
        if (r.caseErr) g.appendChild(el('span', 'se-tk se-tk-case', '大小寫'));
        return g;
      }

      // 桌機直接聚焦；觸控裝置等使用者點了再叫鍵盤，避免一進題就蓋住中文題目
      if (root.matchMedia && root.matchMedia('(pointer: fine)').matches) {
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
      }
    }

    /* --- cloze --- */
    function renderCloze(item) {
      var c = buildCloze(item, sentences());
      var full = item.answers[0];
      root_.appendChild(header('cloze', item, full));
      root_.appendChild(el('p', 'se-zh', item.zh));
      var line = el('p', 'se-cloze');
      var blankEl = null;
      item.chunks.forEach(function (ch, i) {
        if (i > 0 && !/^[.,;:!?]+$/.test(ch)) line.appendChild(document.createTextNode(' '));
        if (i === c.blankIndex) { blankEl = el('span', 'se-blank', '＿＿＿'); line.appendChild(blankEl); }
        else line.appendChild(document.createTextNode(ch));
      });
      root_.appendChild(line);
      if (c.hint) root_.appendChild(el('p', 'se-hint', c.hint));
      var opts = el('div', 'se-options');
      var msg = el('div', 'se-msg');
      var actions = el('div', 'se-actions');
      var done = false;
      var btns = [];
      c.options.forEach(function (o) {
        var b = btn('se-opt', o, function () {
          if (done) return;
          done = true;
          var ok = normalize(o) === normalize(c.correct);
          b.className += ok ? ' se-opt-ok' : ' se-opt-err';
          btns.forEach(function (x) { x.disabled = true; if (normalize(x.textContent) === normalize(c.correct)) x.className += ' se-opt-ok'; });
          blankEl.textContent = c.correct; blankEl.className += ' se-filled';
          msg.className = 'se-msg ' + (ok ? 'se-ok' : 'se-err');
          msg.textContent = ok ? '正確！' : '正解：' + c.correct;
          insertAfter(msg, noteBlock(item, ok));
          if (ok) speak(full);
          finishItem('cloze', item, ok);
          actions.appendChild(nextBtn());
        });
        btns.push(b); opts.appendChild(b);
      });
      root_.appendChild(opts); root_.appendChild(msg); root_.appendChild(actions);
    }

    /* --- parse --- */
    function slotOptions(q) {
      var correct = q.frames[0].slot[0];
      var seen = {}; seen[normalize(correct)] = 1;
      var out = [correct];
      (q.frames[0].slot || []).slice(1).forEach(function (s) { var k = normalize(s); if (!seen[k]) { seen[k] = 1; out.push(s); } });
      var more = [];
      (items.questions || []).forEach(function (o) {
        if (o.id === q.id) return;
        (o.frames || []).forEach(function (f) { (f.slot || []).forEach(function (s) { more.push(s); }); });
      });
      shuffle(more).forEach(function (s) { var k = normalize(s); if (out.length < 4 && !seen[k]) { seen[k] = 1; out.push(s); } });
      return shuffle(out);
    }

    function renderParse(q) {
      var steps = []; // 每步 true/false
      var correctFrame = q.frames[0];
      speakIfNeeded();
      function speakIfNeeded() { /* 題目由 TTS 鍵朗讀 */ }

      function frame(stepNo, title, build) {
        clear(root_);
        root_.appendChild(header('parse', q, q.q));
        root_.appendChild(el('p', 'se-q', q.q));
        root_.appendChild(el('p', 'se-zh', q.zh || ''));
        root_.appendChild(el('p', 'se-step', '步驟 ' + stepNo + ' / 4　' + title));
        var area = el('div', 'se-options');
        var msg = el('div', 'se-msg');
        var actions = el('div', 'se-actions');
        root_.appendChild(area); root_.appendChild(msg); root_.appendChild(actions);
        build(area, msg, actions);
      }
      function whyFor(i) { return (q.stepWhy && q.stepWhy[i]) || q.why || ''; }
      function answerStep(ok, msg, actions, btns, goNext, rightText) {
        steps.push(ok);
        btns.forEach(function (b) { b.disabled = true; });
        msg.className = 'se-msg ' + (ok ? 'se-ok' : 'se-err');
        msg.textContent = ok ? '正確！' : ((rightText ? '正解：' + rightText + '。' : '') + whyFor(steps.length - 1));
        actions.appendChild(btn('se-btn', steps.length >= 4 ? '看結果' : '下一步', goNext));
      }

      function step1() {
        frame(1, '這是哪一種問句？', function (area, msg, actions) {
          var btns = [];
          shuffle(QTYPES).forEach(function (t) {
            var b = btn('se-opt', t.label, function () {
              var ok = t.key === q.qtype;
              b.className += ok ? ' se-opt-ok' : ' se-opt-err';
              answerStep(ok, msg, actions, btns, step2, labelOf(q.qtype));
            });
            btns.push(b); area.appendChild(b);
          });
        });
      }
      function labelOf(key) { for (var i = 0; i < QTYPES.length; i++) if (QTYPES[i].key === key) return QTYPES[i].label; return key; }

      function step2() {
        frame(2, '點出主要動詞所在的積木', function (area, msg, actions) {
          area.className = 'se-bank';
          var btns = [];
          q.chunks.forEach(function (ch, i) {
            var b = btn('se-chip', ch, function () {
              var ok = i === q.core.verb;
              b.className += ok ? ' se-opt-ok' : ' se-opt-err';
              if (!ok && btns[q.core.verb]) btns[q.core.verb].className += ' se-opt-ok';
              answerStep(ok, msg, actions, btns, step3, q.chunks[q.core.verb]);
            });
            btns.push(b); area.appendChild(b);
          });
          if (q.core.ask) msg.textContent = '';
        });
      }

      function step3() {
        frame(3, '選一個自然的回答骨架', function (area, msg, actions) {
          var list = [correctFrame.f].concat(q.distractorFrames || []);
          var btns = [];
          shuffle(list).forEach(function (f) {
            var b = btn('se-opt', f, function () {
              var ok = f === correctFrame.f;
              b.className += ok ? ' se-opt-ok' : ' se-opt-err';
              btns.forEach(function (x) { if (x.textContent === correctFrame.f) x.className += ' se-opt-ok'; });
              answerStep(ok, msg, actions, btns, step4, correctFrame.f);
            });
            btns.push(b); area.appendChild(b);
          });
        });
      }

      function step4() {
        frame(4, '填入骨架的空格：' + correctFrame.f, function (area, msg, actions) {
          var good = correctFrame.slot[0];
          var btns = [];
          slotOptions(q).forEach(function (s) {
            var b = btn('se-opt', s, function () {
              var ok = normalize(s) === normalize(good);
              b.className += ok ? ' se-opt-ok' : ' se-opt-err';
              btns.forEach(function (x) { if (normalize(x.textContent) === normalize(good)) x.className += ' se-opt-ok'; });
              steps.push(ok);
              btns.forEach(function (x) { x.disabled = true; });
              var all = steps.every(function (v) { return v; });
              if (all) speak(correctFrame.f.replace('___', good));
              msg.className = 'se-msg ' + (ok ? 'se-ok' : 'se-err');
              msg.textContent = ok ? '正確！' : '正解：' + good + '。' + whyFor(3);
              actions.appendChild(btn('se-btn', '看結果', finish));
            });
            btns.push(b); area.appendChild(b);
          });
        });
      }

      function finish() {
        var all = steps.length === 4 && steps.every(function (v) { return v; });
        finishItem('parse', q, all, { steps: steps.slice() });
        clear(root_);
        root_.appendChild(header('parse', q, q.q));
        root_.appendChild(el('p', 'se-q', q.q));
        root_.appendChild(el('p', 'se-msg ' + (all ? 'se-ok' : 'se-err'), all ? '四步全對！' : '答對 ' + steps.filter(Boolean).length + ' / 4 步'));
        if (q.why) root_.appendChild(el('p', 'se-hint', q.why));
        var actions = el('div', 'se-actions');
        actions.appendChild(nextBtn());
        root_.appendChild(actions);
      }
      step1();
    }

    function destroy() {
      destroyed = true;
      if (root_ && root_.parentNode) root_.parentNode.removeChild(root_);
      root_ = null; queue = [];
    }

    return { start: start, destroy: destroy };
  }

  root.SentenceEngine = {
    create: create,
    due: dueCount,
    _pure: {
      normalize: normalize, joinChunks: joinChunks, checkOrder: checkOrder, firstWrongIndex: firstWrongIndex,
      buildCloze: buildCloze, grade: grade, wordTokens: wordTokens, diffWords: diffWords, checkTyped: checkTyped, typingHint: typingHint, pickSession: pickSession, shuffle: shuffle, INTERVALS: INTERVALS
    }
  };
})(typeof window !== 'undefined' ? window : this);
