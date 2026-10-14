/* sentence-engine.js — 句子練習引擎（規格見 SPEC-sentence-engine.md）
 * 掛 window.SentenceEngine。無外部依賴；ES2018；只用 DOM API + textContent。
 */
(function (root) {
  'use strict';

  var INTERVALS = [0, 1, 3, 7, 14];
  var MAX_BOX = INTERVALS.length - 1;
  var DEFAULT_KINDS = ['order', 'cloze', 'twoWords', 'parse'];
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
      return { order: '積木排序', cloze: '骨架挖空', twoWords: '兩字造句', parse: '問句拆解' }[k] || k;
    }

    function renderQuestion() {
      clear(root_);
      startedAt = Date.now();
      var q = queue[pos];
      if (q.kind === 'order') renderOrder(q.item, 'order', false);
      else if (q.kind === 'twoWords') renderTwoWords(q.item);
      else if (q.kind === 'cloze') renderCloze(q.item);
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
      function answerStep(ok, msg, actions, btns, goNext, rightText) {
        steps.push(ok);
        btns.forEach(function (b) { b.disabled = true; });
        msg.className = 'se-msg ' + (ok ? 'se-ok' : 'se-err');
        msg.textContent = ok ? '正確！' : ((rightText ? '正解：' + rightText + '。' : '') + (q.why || ''));
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
              msg.textContent = ok ? '正確！' : '正解：' + good + '。' + (q.why || '');
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
      buildCloze: buildCloze, grade: grade, pickSession: pickSession, shuffle: shuffle, INTERVALS: INTERVALS
    }
  };
})(typeof window !== 'undefined' ? window : this);
