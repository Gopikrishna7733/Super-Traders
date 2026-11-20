'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { defineString } = require('firebase-functions/params');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const { randomUUID } = require('node:crypto');

initializeApp();

const db = getFirestore();
const adminEmail = defineString('ADMIN_EMAIL');
const gameRef = db.collection('superTraders').doc('game');
const privateRef = db.collection('superTraders').doc('admin');

function initialState() {
  return {
    teams: [],
    settings: { initialPrice: 100, step: 10, floor: 10, decayAmt: 10, decayEvery: 4, closeIn: 8, answerTime: 30 },
    market: { phase: 'idle', qNo: 0, qType: 'mcq', question: '', options: [], answer: '', price: 0, ownerId: null, history: [], rev: 0, result: null },
    log: []
  };
}

function addLog(state, message) {
  state.log.unshift({ t: Date.now(), m: message });
  if (state.log.length > 80) state.log.length = 80;
}

function publicState(state) {
  const result = JSON.parse(JSON.stringify(state));
  result.market.answer = '';
  return result;
}

function requireAdmin(request) {
  if (!request.auth || request.auth.token.admin !== true || request.auth.token.email_verified !== true) {
    throw new HttpsError('permission-denied', 'Admin authorization is required.');
  }
}

function requireFinite(value, label, min) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) throw new HttpsError('invalid-argument', `Invalid ${label}.`);
  return number;
}

exports.claimAdmin = onCall(async request => {
  const user = request.auth;
  const email = String(user && user.token.email || '').trim().toLowerCase();
  if (!user || user.token.email_verified !== true || email !== adminEmail.value().trim().toLowerCase()) {
    throw new HttpsError('permission-denied', 'This verified account is not authorized as an admin.');
  }

  const authUser = await getAuth().getUser(user.uid);
  await getAuth().setCustomUserClaims(user.uid, Object.assign({}, authUser.customClaims, { admin: true }));
  return { ok: true };
});

exports.gameAction = onCall(async request => {
  const data = request.data || {};
  const action = data.action;
  if (action === 'ensureGame') {
    await db.runTransaction(async tx => {
      const [gameSnap, privateSnap] = await Promise.all([tx.get(gameRef), tx.get(privateRef)]);
      const state = gameSnap.exists ? gameSnap.data() : initialState();
      const currentPrivate = privateSnap.exists ? privateSnap.data() : {};
      const qNo = state.market.qNo || 0;
      const publicAnswer = state.market.answer || '';
      const answer = currentPrivate.qNo === qNo && currentPrivate.answer
        ? currentPrivate.answer
        : publicAnswer;
      state.market.answer = answer;
      if (!gameSnap.exists || publicAnswer !== '' || !Object.prototype.hasOwnProperty.call(gameSnap.data().market, 'answer')) {
        tx.set(gameRef, publicState(state));
      }
      if (!privateSnap.exists || currentPrivate.qNo !== qNo || currentPrivate.answer !== answer) {
        tx.set(privateRef, { answer, qNo });
      }
    });
    return { ok: true };
  }

  if (action !== 'placeBid') requireAdmin(request);
  if (!['addTeams', 'removeTeam', 'setPoints', 'saveSettings', 'openMarket', 'placeBid', 'decay', 'closeBidding', 'markResult', 'skip', 'resetGame'].includes(action)) {
    throw new HttpsError('invalid-argument', 'Unknown game action.');
  }

  return db.runTransaction(async tx => {
    const [gameSnap, privateSnap] = await Promise.all([tx.get(gameRef), tx.get(privateRef)]);
    const state = gameSnap.exists ? gameSnap.data() : initialState();
    const privateState = privateSnap.exists ? privateSnap.data() : { answer: '', qNo: 0 };
    state.market.answer = privateState.qNo === state.market.qNo ? privateState.answer || '' : '';
    const market = state.market;
    let response = { ok: true };
    let nextPrivate = privateState;

    switch (action) {
      case 'addTeams': {
        const names = data.names;
        if (!Array.isArray(names) || !names.length || names.length > 50 || names.some(name => typeof name !== 'string' || !name.trim() || name.length > 100)) {
          throw new HttpsError('invalid-argument', 'Provide between 1 and 50 valid team names.');
        }
        const points = Math.round(requireFinite(data.points, 'starting points', 0));
        names.forEach(name => state.teams.push({ id: randomUUID(), name: name.trim(), points }));
        addLog(state, `Added ${names.length} team(s) with ${points} points`);
        break;
      }
      case 'removeTeam':
        state.teams = state.teams.filter(team => team.id !== data.id);
        break;
      case 'setPoints': {
        const team = state.teams.find(item => item.id === data.id);
        if (!team) throw new HttpsError('failed-precondition', 'Team not found.');
        team.points = Math.round(requireFinite(data.pts, 'points', 0));
        addLog(state, `${team.name}: points set to ${team.points}`);
        break;
      }
      case 'saveSettings': {
        const settings = data.settings;
        const settingNames = ['initialPrice', 'step', 'floor', 'decayAmt', 'decayEvery', 'closeIn', 'answerTime'];
        if (!settings || typeof settings !== 'object' || settingNames.some(name => !Number.isFinite(Number(settings[name])) || Number(settings[name]) < (name === 'answerTime' ? 5 : 1))) {
          throw new HttpsError('invalid-argument', 'Market settings must be valid positive numbers.');
        }
        Object.assign(state.settings, Object.fromEntries(settingNames.map(name => [name, Math.round(Number(settings[name]))])));
        addLog(state, 'Market settings saved');
        break;
      }
      case 'openMarket': {
        if (market.phase !== 'idle' && market.phase !== 'result') throw new HttpsError('failed-precondition', 'Finish the current question first.');
        const question = data.question || {};
        const price = Math.round(requireFinite(data.price, 'opening price', 1));
        const type = ['mcq', 'blank', 'statement'].includes(question.qType) ? question.qType : 'mcq';
        const options = type === 'mcq' ? [0, 1, 2, 3].map(index => String((question.options || [])[index] || '').trim()) : [];
        const answer = String(question.answer || '').trim();
        if (typeof question.question !== 'string' || question.question.length > 2000 || answer.length > 500) {
          throw new HttpsError('invalid-argument', 'Question or answer is too long.');
        }
        if (type === 'mcq' && (options.filter(Boolean).length < 2 || !/^[A-D]$/.test(answer) || !options['ABCD'.indexOf(answer)])) {
          throw new HttpsError('invalid-argument', 'Add two options and choose a correct option.');
        }
        if (type !== 'mcq' && !answer) throw new HttpsError('invalid-argument', 'Enter a correct answer.');
        market.qType = type;
        market.options = options;
        market.answer = answer;
        market.qNo += 1;
        market.phase = 'open';
        market.question = question.question.trim();
        market.price = price;
        market.ownerId = null;
        market.history = [price];
        market.result = null;
        market.rev += 1;
        nextPrivate = { answer, qNo: market.qNo };
        addLog(state, `Question ${market.qNo}: market opened at ${price}`);
        break;
      }
      case 'placeBid': {
        const team = state.teams.find(item => item.id === data.teamId);
        if (!team) throw new HttpsError('failed-precondition', 'Team not found.');
        if (market.phase !== 'open' && market.phase !== 'bidding') throw new HttpsError('failed-precondition', 'The market is closed.');
        if (market.ownerId === data.teamId) throw new HttpsError('failed-precondition', 'You already hold the highest bid.');
        const price = market.phase === 'open' ? market.price : Math.round(requireFinite(data.amount, 'bid', 1));
        if (market.phase === 'bidding' && price < market.price + state.settings.step) throw new HttpsError('failed-precondition', `Bid at least ${market.price + state.settings.step}.`);
        if (price > team.points) throw new HttpsError('failed-precondition', `Not enough trading capital (you have ${team.points}).`);
        const first = market.phase === 'open';
        market.price = price;
        market.ownerId = data.teamId;
        market.phase = 'bidding';
        market.history.push(price);
        market.rev += 1;
        addLog(state, `${team.name} ${first ? 'bought at' : 'bid'} ${price}`);
        response = { ok: true, price };
        break;
      }
      case 'decay': {
        if (market.phase !== 'open' || market.rev !== data.expectedRev) throw new HttpsError('failed-precondition', 'stale');
        const next = Math.max(state.settings.floor, market.price - state.settings.decayAmt);
        if (next >= market.price) throw new HttpsError('failed-precondition', 'floor');
        market.price = next;
        market.history.push(next);
        market.rev += 1;
        break;
      }
      case 'closeBidding': {
        if (market.phase !== 'bidding' || (data.expectedRev != null && market.rev !== data.expectedRev)) throw new HttpsError('failed-precondition', 'stale');
        const team = state.teams.find(item => item.id === market.ownerId);
        market.phase = 'answering';
        market.rev += 1;
        addLog(state, `Market closed: ${team ? team.name : 'team'} owns the question at ${market.price}`);
        break;
      }
      case 'markResult': {
        if (market.phase !== 'answering') throw new HttpsError('failed-precondition', 'No team is answering right now.');
        if (typeof data.correct !== 'boolean') throw new HttpsError('invalid-argument', 'The result must be correct or incorrect.');
        const team = state.teams.find(item => item.id === market.ownerId);
        if (!team) throw new HttpsError('failed-precondition', 'Owner not found.');
        const delta = data.correct ? 2 * market.price : -market.price;
        team.points += delta;
        const answerText = market.qType === 'mcq' ? `${market.answer}: ${market.options['ABCD'.indexOf(market.answer)] || ''}` : market.answer;
        market.result = { correct: data.correct, delta, teamId: team.id, teamName: team.name, price: market.price, answer: answerText };
        market.phase = 'result';
        market.rev += 1;
        addLog(state, `${team.name} answered ${data.correct ? 'correctly' : 'incorrectly'}: ${delta > 0 ? '+' : ''}${delta}`);
        break;
      }
      case 'skip': {
        if (market.phase === 'idle' || market.phase === 'result') throw new HttpsError('failed-precondition', 'Nothing to skip.');
        const answerText = market.qType === 'mcq' ? `${market.answer}: ${market.options['ABCD'.indexOf(market.answer)] || ''}` : market.answer;
        market.result = { skipped: true, answer: answerText };
        market.phase = 'result';
        market.rev += 1;
        addLog(state, `Question ${market.qNo} skipped, no points changed`);
        break;
      }
      case 'resetGame': {
        const points = Math.round(requireFinite(data.points, 'starting points', 0));
        state.teams.forEach(team => { team.points = points; });
        state.market = initialState().market;
        state.log = [];
        nextPrivate = { answer: '', qNo: 0 };
        addLog(state, 'Game reset, all teams back to ' + points);
        break;
      }
    }

    tx.set(gameRef, publicState(state));
    tx.set(privateRef, nextPrivate);
    return response;
  });
});
