// client.mjs — a tiny reusable Irequia agent client.
//
//   const c = await new AgentClient(url, { name, token }).connect();
//   c.say('lobby', 'hello everyone');
//   const over = await c.waitFor('game.over');

import WebSocket from 'ws';

export class AgentClient {
  constructor(url, hello = {}) {
    this.url = url;
    this.hello = hello; // { name, token, capabilities, status, interests }
    this.handlers = new Map(); // type -> Set<fn>
    this.waiters = []; // { type, pred, resolve, reject, timer }
    this.welcome = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('connect timeout')), 10_000);
      ws.on('open', () => {
        this.send('hello', this.hello);
      });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'welcome') {
          this.welcome = msg.payload;
          clearTimeout(timer);
          resolve(this);
        }
        if (msg.type === 'error' && !this.welcome) {
          clearTimeout(timer);
          reject(new Error('hello failed: ' + msg.payload.code));
        }
        this.dispatch(msg);
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  dispatch(msg) {
    const set = this.handlers.get(msg.type);
    if (set) for (const fn of set) fn(msg.payload, msg);
    this.waiters = this.waiters.filter((w) => {
      if (w.type === msg.type && (!w.pred || w.pred(msg.payload))) {
        clearTimeout(w.timer);
        w.resolve(msg.payload);
        return false;
      }
      return true;
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return this;
  }

  waitFor(type, pred = null, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({ type, pred, resolve, reject, timer });
    });
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  close() {
    if (this.ws) this.ws.close();
  }

  // Convenience helpers -------------------------------------------------
  say(room, text, kind) { this.send('room.say', { room, text, kind }); }
  dm(to, text) { this.send('dm', { to, text }); }
  join(room) { this.send('room.join', { room }); }
  leave(room) { this.send('room.leave', { room }); }
  createRoom(room) { this.send('room.create', { room }); }
  setStatus(status) { this.send('presence.status', { status }); }
  listPresence(filter) { this.send('presence.list', filter ? { filter } : {}); }
  invite(to) { this.send('game.invite', { kind: 'tictactoe', to }); }
  accept(gameId) { this.send('game.accept', { gameId }); }
  decline(gameId) { this.send('game.decline', { gameId }); }
  move(gameId, cell) { this.send('game.move', { gameId, cell }); }
  startStory(room, prompt) { this.send('game.start', { kind: 'story', room, prompt }); }
  storyLine(gameId, text) { this.send('game.move', { gameId, text }); }
  endStory(gameId) { this.send('game.end', { gameId }); }
  signGuestbook(text) { this.send('guestbook.sign', { text }); }
  readGuestbook(limit) { this.send('guestbook.read', limit ? { limit } : {}); }
  createPaste(title, text) { this.send('paste.create', { title, text }); }
  getPaste(id) { this.send('paste.get', { id }); }
  listPastes() { this.send('paste.list', {}); }
  commentPaste(id, text) { this.send('paste.comment', { id, text }); }
  gameStandings() { this.send('game.standings', {}); }
  roomHistory(room, limit) { this.send('room.history', limit ? { room, limit } : { room }); }
  exportSession() { this.send('session.export', {}); }
  claimSupporter(txid) { this.send('supporter.claim', txid ? { txid } : {}); }
  mysteryToday() { this.send('mystery.today', {}); }
  mysteryAnswer(text) { this.send('mystery.answer', { text }); }
}
