/* Super Traders: shared engine. Used by index.html, admin.html and live.html.
   One state document holds teams, settings and the current market.
   Backend: Firestore (superTraders/game) when FIREBASE_CONFIG is set, otherwise localStorage. */
(function () {
  'use strict';

  const LOCAL_KEY = 'superTraders:game';
  const uid = () => Math.random().toString(36).slice(2, 8);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n).toLocaleString('en-IN');

  function initialState() {
    return {
      teams: [],
      settings: { initialPrice: 100, step: 10, floor: 10, decayAmt: 10, decayEvery: 4, closeIn: 8, answerTime: 30 },
      market: { phase: 'idle', qNo: 0, qType: 'mcq', question: '', options: [], answer: '', price: 0, ownerId: null, history: [], rev: 0, result: null, submitted: null, timeUp: false },
      log: []
    };
  }

  function normalise(raw) {
    const base = initialState();
    if (!raw) return base;
    return {
      teams: raw.teams || [],
      settings: Object.assign(base.settings, raw.settings || {}),
      market: Object.assign(base.market, raw.market || {}),
      log: raw.log || []
    };
  }

  const listeners = [];
  const statusFns = [];
  let lastStatus = null;
  let state = null, lastRev = null, revAt = Date.now();
  let backend = null, mode = 'local';

  function setStatus(kind, msg) { lastStatus = { kind, msg }; statusFns.forEach(f => f(kind, msg)); }
  function emit(s) {
    state = s;
    if (s.market.rev !== lastRev) { lastRev = s.market.rev; revAt = Date.now(); } // restart countdowns on every market change
    listeners.forEach(f => f(s));
  }
  function addLog(s, m) { s.log.unshift({ t: Date.now(), m }); if (s.log.length > 80) s.log.length = 80; }

  // ---------- backends ----------
  const cfg = window.FIREBASE_CONFIG;
  if (cfg && cfg.apiKey && window.firebase) {
    mode = 'firebase';
    firebase.initializeApp(cfg);
    const db = firebase.firestore();
    const ref = db.collection('superTraders').doc('game');
    ref.onSnapshot(snap => {
      if (!snap.exists) { ref.set(initialState()); return; }
      setStatus('live', 'Live: synced across devices');
      emit(normalise(snap.data()));
    }, err => setStatus('error', 'Firebase error: ' + err.message));
    backend = fn => db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const s = snap.exists ? normalise(snap.data()) : initialState();
      const r = fn(s);
      if (r && r.error) return r;
      tx.set(ref, s);
      return r || { ok: true };
    });
  } else {
    if (cfg && cfg.apiKey) setStatus('error', 'Firebase scripts did not load. Check the internet connection.');
    else setStatus('local', 'Local mode: only this browser (add Firebase config to sync devices)');
    const read = () => { try { return normalise(JSON.parse(localStorage.getItem(LOCAL_KEY))); } catch (e) { return initialState(); } };
    backend = fn => new Promise(resolve => {
      const s = read();
      const r = fn(s);
      if (r && r.error) return resolve(r);
      localStorage.setItem(LOCAL_KEY, JSON.stringify(s));
      emit(s);
      resolve(r || { ok: true });
    });
    window.addEventListener('storage', e => { if (e.key === LOCAL_KEY) emit(read()); });
    setTimeout(() => emit(read()), 0);
  }

  const update = fn => backend(fn).catch(e => ({ error: e.message || 'Could not save' }));

  // checks one question (used when opening the market and when saving to the bank)
  function cleanQuestion(q) {
    q = q || {};
    const type = ['mcq', 'blank', 'statement'].indexOf(q.qType) >= 0 ? q.qType : 'mcq';
    let options = [], answer = String(q.answer || '').trim();
    if (type === 'mcq') {
      options = [0, 1, 2, 3].map(i => String((q.options || [])[i] || '').trim());
      if (options.filter(Boolean).length < 2) return { error: 'Add at least two options' };
      if (!/^[A-D]$/.test(answer) || !options['ABCD'.indexOf(answer)]) return { error: 'Pick which option is correct' };
    }
    return { qType: type, question: String(q.question || '').trim(), options, answer };
  }

  // what the team answered, as text for the screens
  function givenText(m) {
    if (!m.submitted) return '';
    const a = m.submitted.answer;
    return m.qType === 'mcq' ? a + ': ' + (m.options['ABCD'.indexOf(a)] || '') : a;
  }
  // scores the owner team and closes the question (shared by auto-marking and the admin buttons)
  function finish(s, correct) {
    const m = s.market, t = s.teams.find(x => x.id === m.ownerId);
    if (!t) return { error: 'Owner not found' };
    const delta = correct ? 2 * m.price : -m.price;
    t.points += delta;
    m.result = { correct: !!correct, delta, teamId: t.id, teamName: t.name, price: m.price, answer: answerText(m), given: givenText(m) };
    m.phase = 'result'; m.rev += 1;
    addLog(s, `${t.name} answered ${correct ? 'correctly' : 'incorrectly'}: ${delta > 0 ? '+' : ''}${delta}`);
    return { ok: true, correct: !!correct, delta };
  }

  // ---------- question bank (its own document, only the admin page reads it) ----------
  const bankListeners = [];
  let bankState = null, bankBackend = null;
  function bankEmit(b) { bankState = b; bankListeners.forEach(f => f(b)); }
  function initBank() {
    if (bankBackend) return;
    const fresh = () => ({ items: [] });
    const norm = raw => ({ items: (raw && raw.items) || [] });
    if (mode === 'firebase') {
      const db = firebase.firestore();
      const ref = db.collection('superTraders').doc('bank');
      ref.onSnapshot(snap => {
        if (!snap.exists) { ref.set(fresh()); return; }
        bankEmit(norm(snap.data()));
      }, err => setStatus('error', 'Question bank error: ' + err.message));
      bankBackend = fn => db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const b = snap.exists ? norm(snap.data()) : fresh();
        const r = fn(b);
        if (r && r.error) return r;
        tx.set(ref, b);
        return r || { ok: true };
      });
    } else {
      const KEY = 'superTraders:bank';
      const read = () => { try { return norm(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return fresh(); } };
      bankBackend = fn => new Promise(resolve => {
        const b = read(); const r = fn(b);
        if (r && r.error) return resolve(r);
        localStorage.setItem(KEY, JSON.stringify(b)); bankEmit(b); resolve(r || { ok: true });
      });
      window.addEventListener('storage', e => { if (e.key === KEY) bankEmit(read()); });
      setTimeout(() => bankEmit(read()), 0);
    }
  }
  const bankUpdate = fn => { initBank(); return bankBackend(fn).catch(e => ({ error: e.message || 'Could not save' })); };
  const askPrice = p => { p = Math.round(Number(p)); return p > 0 ? p : null; };

  // ---------- game actions (all rules live here) ----------
  const actions = {
    addTeams(names, points) {
      return update(s => { names.forEach(n => s.teams.push({ id: uid(), name: n, points: points, claimedBy: null })); addLog(s, `Added ${names.length} team(s) with ${points} points`); });
    },
    claimTeam(id, deviceId) { // locks a team to one device
      return update(s => {
        const t = s.teams.find(x => x.id === id);
        if (!t) return { error: 'Team not found. Ask the admin.' };
        if (t.claimedBy && t.claimedBy !== deviceId) return { error: 'That team is already taken on another device. Ask the admin.' };
        s.teams.forEach(x => { if (x.id !== id && x.claimedBy === deviceId) x.claimedBy = null; }); // one team per device
        t.claimedBy = deviceId; addLog(s, t.name + ' joined and is now locked');
      });
    },
    releaseTeam(id) { // admin unlocks a team so it can be picked again
      return update(s => {
        const t = s.teams.find(x => x.id === id);
        if (!t) return { error: 'Team not found' };
        t.claimedBy = null; addLog(s, t.name + ' unlocked by admin');
      });
    },
    removeTeam(id) {
      return update(s => { s.teams = s.teams.filter(t => t.id !== id); });
    },
    setPoints(id, pts) {
      return update(s => { const t = s.teams.find(x => x.id === id); if (!t) return { error: 'Team not found' }; t.points = Math.round(pts); addLog(s, `${t.name}: points set to ${t.points}`); });
    },
    saveSettings(obj) {
      return update(s => { Object.assign(s.settings, obj); addLog(s, 'Market settings saved'); });
    },
    openMarket(q, price) { // q = { question, qType: 'mcq' | 'blank' | 'statement', options: [4 strings], answer }
      return update(s => {
        const m = s.market;
        if (m.phase !== 'idle' && m.phase !== 'result') return { error: 'Finish the current question first' };
        price = Math.round(Number(price));
        if (!(price > 0)) return { error: 'Enter an opening price above 0' };
        const c = cleanQuestion(q);
        if (c.error) return c;
        m.qType = c.qType; m.options = c.options; m.answer = c.answer;
        m.qNo += 1; m.phase = 'open'; m.question = c.question; m.price = price;
        m.ownerId = null; m.history = [price]; m.result = null; m.submitted = null; m.timeUp = false; m.rev += 1;
        addLog(s, `Question ${m.qNo}: market opened at ${price}`);
      });
    },
    // ----- question bank: save now, release whenever you want -----
    saveQuestion(q, price) {
      return bankUpdate(b => {
        const c = cleanQuestion(q); if (c.error) return c;
        if (!c.question) return { error: 'Type the question before saving it' };
        const p = askPrice(price); if (!p) return { error: 'Enter an opening price above 0' };
        b.items.push(Object.assign({ id: uid(), price: p, savedAt: Date.now(), used: false }, c));
        return { ok: true };
      });
    },
    updateQuestion(id, q, price) {
      return bankUpdate(b => {
        const it = b.items.find(x => x.id === id); if (!it) return { error: 'Saved question not found' };
        const c = cleanQuestion(q); if (c.error) return c;
        if (!c.question) return { error: 'Type the question before saving it' };
        const p = askPrice(price); if (!p) return { error: 'Enter an opening price above 0' };
        Object.assign(it, c, { price: p });
        return { ok: true };
      });
    },
    deleteQuestion(id) {
      return bankUpdate(b => { b.items = b.items.filter(x => x.id !== id); });
    },
    async releaseQuestion(id) { // opens the market with a saved question
      initBank();
      const item = bankState && bankState.items.find(x => x.id === id);
      if (!item) return { error: 'Saved question not found' };
      const r = await actions.openMarket(item, item.price);
      if (r && r.ok) await bankUpdate(b => { const it = b.items.find(x => x.id === id); if (it) { it.used = true; it.usedAt = Date.now(); } });
      return r;
    },
    placeBid(teamId, amount) {
      return update(s => {
        const m = s.market, t = s.teams.find(x => x.id === teamId);
        if (!t) return { error: 'Team not found' };
        if (m.phase !== 'open' && m.phase !== 'bidding') return { error: 'The market is closed' };
        if (m.ownerId === teamId) return { error: 'You already hold the highest bid' };
        let price;
        if (m.phase === 'open') price = m.price; // first buyer pays the price on the board
        else {
          price = Math.round(Number(amount));
          if (!(price >= m.price + s.settings.step)) return { error: 'Bid at least ' + (m.price + s.settings.step) };
        }
        if (price > t.points) return { error: 'Not enough trading capital (you have ' + t.points + ')' };
        const first = m.phase === 'open';
        m.price = price; m.ownerId = teamId; m.phase = 'bidding'; m.history.push(price); m.rev += 1;
        addLog(s, `${t.name} ${first ? 'bought at' : 'bid'} ${price}`);
        return { ok: true, price };
      });
    },
    decay(expectedRev) { // bear market: no buyer, price drops
      return update(s => {
        const m = s.market;
        if (m.phase !== 'open' || m.rev !== expectedRev) return { error: 'stale' };
        const next = Math.max(s.settings.floor, m.price - s.settings.decayAmt);
        if (next >= m.price) return { error: 'floor' };
        m.price = next; m.history.push(next); m.rev += 1;
      });
    },
    closeBidding(expectedRev) { // market closure: buyer must now answer
      return update(s => {
        const m = s.market;
        if (m.phase !== 'bidding' || (expectedRev != null && m.rev !== expectedRev)) return { error: 'stale' };
        const t = s.teams.find(x => x.id === m.ownerId);
        m.phase = 'answering'; m.rev += 1;
        addLog(s, `Market closed: ${t ? t.name : 'team'} owns the question at ${m.price}`);
      });
    },
    markResult(correct) { // admin judges the answer (needed for typed answers or when time ran out)
      return update(s => {
        if (s.market.phase !== 'answering') return { error: 'No team is answering right now' };
        return finish(s, correct);
      });
    },
    submitAnswer(teamId, text) { // the owner team locks in its answer from its own screen
      return update(s => {
        const m = s.market;
        if (m.phase !== 'answering') return { error: 'No answer is being taken right now' };
        if (m.ownerId !== teamId) return { error: 'Only the team that bought the question can answer' };
        if (m.submitted) return { error: 'Your answer is already locked in' };
        if (m.timeUp) return { error: "Time's up" };
        let a = String(text || '').trim().slice(0, 200);
        if (!a) return { error: 'Choose or type an answer first' };
        if (m.qType === 'mcq') {
          a = a.toUpperCase();
          if (!/^[A-D]$/.test(a) || !m.options['ABCD'.indexOf(a)]) return { error: 'Pick one of the options' };
          m.submitted = { teamId, answer: a, at: Date.now() };
          return finish(s, a === m.answer); // multiple choice is marked automatically
        }
        m.submitted = { teamId, answer: a, at: Date.now() }; // typed answers wait for the quiz master
        const t = s.teams.find(x => x.id === teamId);
        addLog(s, (t ? t.name : 'Team') + ' locked in an answer');
        return { ok: true, pending: true };
      });
    },
    timeUp(expectedRev) { // admin page calls this when the answer timer ends; late answers are refused
      return update(s => {
        const m = s.market;
        if (m.phase !== 'answering' || m.rev !== expectedRev || m.timeUp) return { error: 'stale' };
        m.timeUp = true; // no rev bump, so countdowns are not restarted
      });
    },
    skip() {
      return update(s => {
        const m = s.market;
        if (m.phase === 'idle' || m.phase === 'result') return { error: 'Nothing to skip' };
        m.result = { skipped: true, answer: answerText(m) }; m.phase = 'result'; m.rev += 1;
        addLog(s, `Question ${m.qNo} skipped, no points changed`);
      });
    },
    resetGame(points) {
      return update(s => {
        const fresh = initialState();
        s.teams.forEach(t => { t.points = points; });
        s.market = fresh.market; s.log = []; addLog(s, 'Game reset, all teams back to ' + points);
      });
    }
  };

  // ---------- helpers ----------
  function secondsLeft() {
    if (!state) return null;
    const m = state.market, st = state.settings;
    const total = m.phase === 'open' ? st.decayEvery : m.phase === 'bidding' ? st.closeIn : m.phase === 'answering' ? st.answerTime : null;
    if (total == null) return null;
    return { total, left: Math.max(0, total - (Date.now() - revAt) / 1000) };
  }

  function phaseInfo(s) {
    const m = s.market;
    switch (m.phase) {
      case 'open': return { label: 'Bear market: price falling', cls: 'bear' };
      case 'bidding': return { label: 'Bull market: bidding live', cls: 'bull' };
      case 'answering': return { label: 'Sold: owner is answering', cls: 'sold' };
      case 'result': return { label: 'Market closed', cls: '' };
      default: return { label: 'Waiting for next question', cls: '' };
    }
  }

  const typeLabel = t => ({ mcq: 'Multiple choice', blank: 'Fill in the blank', statement: 'Statement guess' }[t] || '');
  function answerText(m) {
    if (!m.answer) return '';
    if (m.qType === 'mcq') return m.answer + ': ' + (m.options['ABCD'.indexOf(m.answer)] || '');
    return m.answer;
  }
  // lettered option cards for MCQ; the right one lights up once the question is finished
  function optionsHTML(m, pick) { // pick = { enabled, selected } makes the cards tappable
    if (m.qType !== 'mcq' || m.phase === 'idle') return '';
    const done = m.phase === 'result', given = m.submitted && m.submitted.answer;
    return m.options.map((o, i) => {
      if (!o) return '';
      const L = 'ABCD'[i], cls = [];
      if (done && L === m.answer) cls.push('right');
      if (done && given === L && L !== m.answer) cls.push('wrong');
      if (pick && pick.enabled) { cls.push('pick'); if (pick.selected === L) cls.push('selected'); }
      const attrs = pick && pick.enabled ? ` data-letter="${L}" tabindex="0" role="radio" aria-checked="${pick.selected === L}"` : '';
      return `<li class="${cls.join(' ')}"${attrs}><b>${L}</b><span>${esc(o)}</span></li>`;
    }).join('');
  }

  const rank = s => s.teams.slice().sort((a, b) => b.points - a.points);

  // Price chart: grey steps over time, green risers for bids, red risers for drops.
  function chartSVG(h) {
    const W = 640, H = 240, P = 22;
    if (!h || !h.length) return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price chart"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#a99ad6" font-size="16">The price chart starts when the market opens</text></svg>`;
    const lo = Math.min(...h), hi = Math.max(...h), span = Math.max(hi - lo, 20), mid = (hi + lo) / 2;
    const min = mid - span * 0.65, max = mid + span * 0.65;
    const n = Math.max(h.length - 1, 6);
    const x = i => P + i * (W - 2 * P - 40) / n, y = v => H - P - (v - min) / (max - min) * (H - 2 * P);
    let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price chart, now ${h[h.length - 1]} points">`;
    out += `<line x1="${P}" x2="${W - P}" y1="${y(h[0])}" y2="${y(h[0])}" stroke="#f7b924" stroke-opacity=".45" stroke-dasharray="4 6"/>`;
    out += `<text x="${P}" y="${y(h[0]) - 6}" fill="#f7b924" fill-opacity=".8" font-size="13">Opening price ${h[0]}</text>`;
    for (let i = 1; i < h.length; i++) {
      out += `<line x1="${x(i - 1)}" y1="${y(h[i - 1])}" x2="${x(i)}" y2="${y(h[i - 1])}" stroke="#a99ad6" stroke-width="3" stroke-linecap="round"/>`;
      if (h[i] !== h[i - 1]) out += `<line x1="${x(i)}" y1="${y(h[i - 1])}" x2="${x(i)}" y2="${y(h[i])}" stroke="${h[i] > h[i - 1] ? '#34d399' : '#fb5a73'}" stroke-width="5" stroke-linecap="round"/>`;
    }
    const last = h.length - 1;
    const col = last === 0 || h[last] === h[last - 1] ? '#f7b924' : h[last] > h[last - 1] ? '#34d399' : '#fb5a73';
    out += `<circle cx="${x(last)}" cy="${y(h[last])}" r="8" fill="${col}"/>`;
    out += `<text x="${x(last) + 14}" y="${y(h[last]) + 5}" fill="#efe9ff" font-size="17" font-weight="700">${h[last]}</text>`;
    return out + '</svg>';
  }

  window.Store = {
    mode,
    state: () => state,
    subscribe(fn) { listeners.push(fn); if (state) fn(state); },
    onStatus(fn) { statusFns.push(fn); if (lastStatus) fn(lastStatus.kind, lastStatus.msg); },
    update, actions, secondsLeft,
    subscribeBank(fn) { bankListeners.push(fn); initBank(); if (bankState) fn(bankState); }
  };
  window.UI = { esc, fmt, phaseInfo, rank, chartSVG, typeLabel, answerText, optionsHTML };
})();