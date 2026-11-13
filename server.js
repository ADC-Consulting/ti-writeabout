const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CONFIG: sent to clients as part of the state, so the HTML holds no copy.
// ---------------------------------------------------------------------------
const CONFIG = {
  topN: 6,
  // Phase durations in minutes (visual cue only; the facilitator presses Next)
  durations: { topics: 3, who: 4, what: 3 },
  prompts: {
    topics: 'What should T&I write about?',
    who: 'What would you love to read from {name}?',
    what: 'What would you write about?',
  },
  maxLen: { name: 40, topic: 120, nomination: 160, because: 200, idea: 160 },
};

const PHASES = ['join', 'topics', 'who', 'what', 'reveal'];

const db = new Database(process.env.DB_PATH || './writeathon.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS session (
    id      INTEGER PRIMARY KEY DEFAULT 1,
    phase   TEXT    NOT NULL DEFAULT 'join',
    ends_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS players (
    id         TEXT    PRIMARY KEY,
    key        TEXT    NOT NULL UNIQUE,
    name       TEXT    NOT NULL,
    in_cycle   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS topics (
    id         TEXT    PRIMARY KEY,
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stars (
    topic_id  TEXT NOT NULL,
    player_id TEXT NOT NULL,
    PRIMARY KEY (topic_id, player_id)
  );
  CREATE TABLE IF NOT EXISTS deals (
    giver_id    TEXT PRIMARY KEY,
    receiver_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nominations (
    id          TEXT    PRIMARY KEY,
    giver_id    TEXT    NOT NULL,
    receiver_id TEXT    NOT NULL,
    topic_id    TEXT,
    text        TEXT    NOT NULL,
    because     TEXT    NOT NULL DEFAULT '',
    dealt       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    UNIQUE (giver_id, receiver_id)
  );
  CREATE TABLE IF NOT EXISTS ideas (
    player_id   TEXT    PRIMARY KEY,
    text        TEXT    NOT NULL,
    source_type TEXT    NOT NULL,
    source_id   TEXT,
    created_at  INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO session (id, phase) VALUES (1, 'join');
`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uid() {
  return crypto.randomBytes(4).toString('hex');
}

function clean(s, max) {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getSession() {
  return db.prepare('SELECT phase, ends_at FROM session WHERE id = 1').get();
}

function playerFromReq(req) {
  const key = req.get('x-player-key');
  if (!key) return null;
  return db.prepare('SELECT * FROM players WHERE key = ?').get(key) || null;
}

function requirePlayer(req) {
  const p = playerFromReq(req);
  if (!p) throw new HttpError(401, 'unknown player');
  return p;
}

function requirePhase(...allowed) {
  const { phase } = getSession();
  if (!allowed.includes(phase)) throw new HttpError(400, 'not allowed in this phase');
  return phase;
}

function topTopics() {
  return db
    .prepare(
      `SELECT t.id, t.text, COUNT(s.player_id) AS stars
       FROM topics t LEFT JOIN stars s ON s.topic_id = t.id
       GROUP BY t.id
       ORDER BY stars DESC, t.created_at ASC, t.rowid ASC
       LIMIT ?`
    )
    .all(CONFIG.topN);
}

// ---------------------------------------------------------------------------
// State: the privacy boundary
// ---------------------------------------------------------------------------
function getState(me) {
  const { phase, ends_at } = getSession();

  const players = db
    .prepare('SELECT id, name, in_cycle FROM players ORDER BY created_at ASC, rowid ASC')
    .all()
    .map(p => ({ id: p.id, name: p.name, inCycle: !!p.in_cycle }));

  const topics = db
    .prepare(
      `SELECT t.id, t.text, COUNT(s.player_id) AS stars
       FROM topics t LEFT JOIN stars s ON s.topic_id = t.id
       GROUP BY t.id
       ORDER BY t.created_at ASC, t.rowid ASC`
    )
    .all();

  const topTopicIds = topTopics().map(t => t.id);

  const state = {
    phase,
    endsAt: ends_at || null,
    config: CONFIG,
    players,
    topics,
    topTopicIds,
    nominatedCount: db.prepare('SELECT COUNT(*) AS n FROM nominations WHERE dealt = 1').get().n,
    ideaCount: db.prepare('SELECT COUNT(*) AS n FROM ideas').get().n,
  };

  if (me) {
    state.me = { id: me.id, name: me.name };
    state.myStars = db
      .prepare('SELECT topic_id FROM stars WHERE player_id = ?')
      .all(me.id)
      .map(r => r.topic_id);

    const deal = db.prepare('SELECT receiver_id FROM deals WHERE giver_id = ?').get(me.id);
    if (deal) {
      const r = db.prepare('SELECT id, name FROM players WHERE id = ?').get(deal.receiver_id);
      state.dealtTo = r ? { id: r.id, name: r.name } : null;
    } else {
      state.dealtTo = null;
    }

    state.myNominations = db
      .prepare(
        `SELECT receiver_id, topic_id, text, because FROM nominations
         WHERE giver_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(me.id)
      .map(n => ({ receiverId: n.receiver_id, topicId: n.topic_id, text: n.text, because: n.because }));

    // No giver id anywhere. Only from "what" onward.
    state.received =
      phase === 'what' || phase === 'reveal'
        ? db
            .prepare(
              `SELECT id, text, topic_id, because FROM nominations
               WHERE receiver_id = ? ORDER BY text ASC, id ASC`
            )
            .all(me.id)
            .map(n => ({ id: n.id, text: n.text, topicId: n.topic_id, because: n.because }))
        : [];

    const idea = db.prepare('SELECT text, source_type, source_id FROM ideas WHERE player_id = ?').get(me.id);
    state.myIdea = idea ? { text: idea.text, sourceType: idea.source_type, sourceId: idea.source_id } : null;
  }

  // Per top-topic demand (aggregate counts only, no names). Lets the UI show how
  // the round-1 stars connect to what people ask for and what gets picked up.
  if (phase === 'who' || phase === 'what' || phase === 'reveal') {
    const requestedStmt = db.prepare('SELECT COUNT(*) AS n FROM nominations WHERE topic_id = ?');
    const writersStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM ideas i
       LEFT JOIN nominations n ON i.source_type = 'nomination' AND n.id = i.source_id
       WHERE (i.source_type = 'topic' AND i.source_id = ?)
          OR (i.source_type = 'nomination' AND n.topic_id = ?)`
    );
    state.coverage = topTopics().map(t => ({
      topicId: t.id,
      text: t.text,
      stars: t.stars,
      requested: requestedStmt.get(t.id).n,
      writers: writersStmt.get(t.id, t.id).n,
    }));
  }

  if (phase === 'reveal') {
    const receivedStmt = db.prepare('SELECT text, because FROM nominations WHERE receiver_id = ? ORDER BY text ASC, id ASC');
    const ideaStmt = db.prepare('SELECT text, source_type FROM ideas WHERE player_id = ?');
    state.cards = db
      .prepare('SELECT id, name FROM players WHERE in_cycle = 1 ORDER BY created_at ASC, rowid ASC')
      .all()
      .map(p => {
        const idea = ideaStmt.get(p.id);
        return {
          id: p.id,
          name: p.name,
          // Topic + reason only; never who nominated
          received: receivedStmt.all(p.id).map(r => ({ text: r.text, because: r.because })),
          idea: idea ? idea.text : null,
          pickedUpNomination: !!idea && idea.source_type === 'nomination',
        };
      });
  }

  return state;
}

// Wrap a route: converts HttpError to JSON responses, never logs content.
function route(fn) {
  return (req, res) => {
    try {
      res.json(fn(req));
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      console.error('Unexpected error:', e.message);
      res.status(500).json({ error: 'server error' });
    }
  };
}

// ---------------------------------------------------------------------------
// Player routes
// ---------------------------------------------------------------------------
app.get('/api/state', route(req => getState(playerFromReq(req))));

app.post('/api/join', route(req => {
  requirePhase('join', 'topics');
  const name = clean(req.body.name, CONFIG.maxLen.name);
  if (!name) throw new HttpError(400, 'name required');
  const id = uid();
  const key = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO players (id, key, name, in_cycle, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(id, key, name, Date.now());
  const me = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  return { id, key, state: getState(me) };
}));

app.post('/api/topics', route(req => {
  const me = requirePlayer(req);
  requirePhase('topics');
  const text = clean(req.body.text, CONFIG.maxLen.topic);
  if (!text) throw new HttpError(400, 'text required');
  db.prepare('INSERT INTO topics (id, text, created_at) VALUES (?, ?, ?)').run(uid(), text, Date.now());
  return getState(me);
}));

app.post('/api/stars', route(req => {
  const me = requirePlayer(req);
  requirePhase('topics');
  const topicId = req.body.topicId;
  const topic = typeof topicId === 'string' && db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId);
  if (!topic) throw new HttpError(400, 'topic not found');
  const existing = db.prepare('SELECT 1 FROM stars WHERE topic_id = ? AND player_id = ?').get(topicId, me.id);
  if (existing) db.prepare('DELETE FROM stars WHERE topic_id = ? AND player_id = ?').run(topicId, me.id);
  else db.prepare('INSERT INTO stars (topic_id, player_id) VALUES (?, ?)').run(topicId, me.id);
  return getState(me);
}));

app.post('/api/nominations', route(req => {
  const me = requirePlayer(req);
  requirePhase('who');
  const { receiverId, topicId } = req.body;
  if (!me.in_cycle) throw new HttpError(400, 'you are not part of this round');
  if (typeof receiverId !== 'string' || receiverId === me.id) throw new HttpError(400, 'invalid receiver');
  const receiver = db.prepare('SELECT id, in_cycle FROM players WHERE id = ?').get(receiverId);
  if (!receiver || !receiver.in_cycle) throw new HttpError(400, 'invalid receiver');

  let text = clean(req.body.text, CONFIG.maxLen.nomination);
  let tId = null;
  if (typeof topicId === 'string' && topicId) {
    const topic = db.prepare('SELECT id, text FROM topics WHERE id = ?').get(topicId);
    if (!topic) throw new HttpError(400, 'topic not found');
    tId = topic.id;
    text = topic.text.slice(0, CONFIG.maxLen.nomination);
  }
  if (!text) throw new HttpError(400, 'topic or text required');
  const because = clean(req.body.because, CONFIG.maxLen.because);
  if (!because) throw new HttpError(400, 'please say why they would be great at this');

  const deal = db.prepare('SELECT receiver_id FROM deals WHERE giver_id = ?').get(me.id);
  const dealt = deal && deal.receiver_id === receiverId ? 1 : 0;

  db.prepare(
    `INSERT INTO nominations (id, giver_id, receiver_id, topic_id, text, because, dealt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(giver_id, receiver_id) DO UPDATE SET
       topic_id = excluded.topic_id, text = excluded.text, because = excluded.because,
       dealt = excluded.dealt`
  ).run(uid(), me.id, receiverId, tId, text, because, dealt, Date.now());
  return getState(me);
}));

app.post('/api/ideas', route(req => {
  const me = requirePlayer(req);
  requirePhase('what');
  if (!me.in_cycle) throw new HttpError(400, 'you are not part of this round');
  const { sourceType, sourceId } = req.body;
  let text = clean(req.body.text, CONFIG.maxLen.idea);
  let srcId = null;

  if (sourceType === 'nomination') {
    const n = typeof sourceId === 'string' && db.prepare('SELECT id, text FROM nominations WHERE id = ? AND receiver_id = ?').get(sourceId, me.id);
    if (!n) throw new HttpError(400, 'nomination not found');
    srcId = n.id;
    if (!text) text = n.text.slice(0, CONFIG.maxLen.idea);
  } else if (sourceType === 'topic') {
    const t = typeof sourceId === 'string' && db.prepare('SELECT id, text FROM topics WHERE id = ?').get(sourceId);
    if (!t) throw new HttpError(400, 'topic not found');
    srcId = t.id;
    if (!text) text = t.text.slice(0, CONFIG.maxLen.idea);
  } else if (sourceType !== 'own') {
    throw new HttpError(400, 'invalid source');
  }
  if (!text) throw new HttpError(400, 'text required');

  db.prepare(
    `INSERT INTO ideas (player_id, text, source_type, source_id, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET
       text = excluded.text, source_type = excluded.source_type, source_id = excluded.source_id`
  ).run(me.id, text, sourceType, srcId, Date.now());
  return getState(me);
}));

// ---------------------------------------------------------------------------
// Admin routes (open: anyone who knows /admin can use them; accepted risk)
// ---------------------------------------------------------------------------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

app.post('/api/next', route(() => {
  const { phase } = getSession();
  const idx = PHASES.indexOf(phase);
  if (idx === PHASES.length - 1) throw new HttpError(400, 'already at the reveal');
  const next = PHASES[idx + 1];

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM players').get();
  if (phase === 'join' && n < 1) throw new HttpError(400, 'need at least 1 player');
  if (phase === 'topics' && n < 2) throw new HttpError(400, 'need at least 2 players');

  db.transaction(() => {
    if (phase === 'topics') {
      db.prepare('UPDATE players SET in_cycle = 1').run();
      const ids = shuffle(db.prepare('SELECT id FROM players').all().map(p => p.id));
      db.prepare('DELETE FROM deals').run();
      const ins = db.prepare('INSERT INTO deals (giver_id, receiver_id) VALUES (?, ?)');
      ids.forEach((id, i) => ins.run(id, ids[(i + 1) % ids.length]));
    }
    const minutes = CONFIG.durations[next];
    const endsAt = minutes ? Date.now() + minutes * 60 * 1000 : null;
    db.prepare('UPDATE session SET phase = ?, ends_at = ? WHERE id = 1').run(next, endsAt);
  })();
  return getState(null);
}));

app.post('/api/reset', route(() => {
  db.transaction(() => {
    for (const t of ['players', 'topics', 'stars', 'deals', 'nominations', 'ideas']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
    db.prepare("UPDATE session SET phase = 'join', ends_at = NULL WHERE id = 1").run();
  })();
  return getState(null);
}));

app.get('/api/export', (req, res) => {
  const lines = ['# Write-a-thon export', ''];

  lines.push('## Topics', '');
  const topics = db
    .prepare(
      `SELECT t.id, t.text, COUNT(s.player_id) AS stars
       FROM topics t LEFT JOIN stars s ON s.topic_id = t.id
       GROUP BY t.id ORDER BY stars DESC, t.created_at ASC, t.rowid ASC`
    )
    .all();
  if (!topics.length) lines.push('_No topics._');
  topics.forEach(t => lines.push(`- ${t.text} (★ ${t.stars})`));

  lines.push('', '## Nominations (anonymous, per receiver)', '');
  const noms = db
    .prepare(
      `SELECT p.name AS receiver, n.text, n.because
       FROM nominations n JOIN players p ON p.id = n.receiver_id
       ORDER BY p.name ASC, n.text ASC`
    )
    .all();
  if (!noms.length) lines.push('_No nominations._');
  let current = null;
  noms.forEach(n => {
    if (n.receiver !== current) {
      if (current !== null) lines.push('');
      current = n.receiver;
      lines.push(`### ${n.receiver}`, '');
    }
    lines.push(`- ${n.text}${n.because ? ` — because: ${n.because}` : ''}`);
  });

  lines.push('', '## Topic coverage (top topics: stars vs. demand vs. writers)', '');
  const coverageRequested = db.prepare('SELECT COUNT(*) AS n FROM nominations WHERE topic_id = ?');
  const coverageWriters = db.prepare(
    `SELECT p.name FROM ideas i
     JOIN players p ON p.id = i.player_id
     LEFT JOIN nominations n ON i.source_type = 'nomination' AND n.id = i.source_id
     WHERE (i.source_type = 'topic' AND i.source_id = ?)
        OR (i.source_type = 'nomination' AND n.topic_id = ?)
     ORDER BY p.name ASC`
  );
  const coverage = topTopics();
  if (!coverage.length) lines.push('_No topics._');
  coverage.forEach(t => {
    const writers = coverageWriters.all(t.id, t.id).map(r => r.name);
    lines.push(
      `- ${t.text} (★ ${t.stars}) — requested ${coverageRequested.get(t.id).n}×, ` +
      `writers: ${writers.length ? writers.join(', ') : 'none yet (open)'}`
    );
  });

  lines.push('', '## Ideas', '');
  const ideas = db
    .prepare(
      `SELECT p.name, i.text, i.source_type FROM ideas i
       JOIN players p ON p.id = i.player_id ORDER BY p.name ASC`
    )
    .all();
  if (!ideas.length) lines.push('_No ideas._');
  const sourceLabel = { nomination: 'picked up a nomination', topic: 'from the topic list', own: 'own idea' };
  ideas.forEach(i => lines.push(`- **${i.name}**: ${i.text} _(${sourceLabel[i.source_type] || i.source_type})_`));

  res.set('Content-Type', 'text/markdown; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="write-a-thon.md"');
  res.send(lines.join('\n') + '\n');
});

// ---------------------------------------------------------------------------
// Serve the app
// ---------------------------------------------------------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'writeathon.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'writeathon.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Write-a-thon running on http://localhost:${PORT}`);
});
