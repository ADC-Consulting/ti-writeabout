const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const db = new Database(process.env.DB_PATH || './postathon.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS session (
    id   INTEGER PRIMARY KEY DEFAULT 1,
    phase    TEXT    NOT NULL DEFAULT 'setup',
    ends_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS participants (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id          TEXT    PRIMARY KEY,
    author_id   TEXT    NOT NULL,
    author_name TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS votes (
    post_id  TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    PRIMARY KEY (post_id, voter_id)
  );
  INSERT OR IGNORE INTO session (id, phase) VALUES (1, 'setup');
`);

function uid() {
  return crypto.randomBytes(4).toString('hex');
}

function getState() {
  const session = db.prepare('SELECT * FROM session WHERE id = 1').get();

  // Server-authoritative phase advance
  if (session.phase === 'writing' && session.ends_at && Date.now() > session.ends_at) {
    db.prepare("UPDATE session SET phase = 'voting' WHERE id = 1").run();
    session.phase = 'voting';
  }

  const participants = db.prepare('SELECT id, name FROM participants').all();
  const rows = db.prepare('SELECT * FROM posts ORDER BY created_at ASC').all();
  const voteRows = db.prepare('SELECT * FROM votes').all();

  const posts = rows.map(p => ({
    id: p.id,
    authorId: p.author_id,
    authorName: p.author_name,
    content: p.content,
    createdAt: p.created_at,
  }));

  const votes = {};
  for (const v of voteRows) {
    if (!votes[v.post_id]) votes[v.post_id] = [];
    votes[v.post_id].push(v.voter_id);
  }

  let awards = {};
  if (session.phase === 'results') {
    const ranking = posts
      .map(p => ({ post: p, votes: (votes[p.id] || []).length }))
      .sort((a, b) => b.votes - a.votes);
    awards = { best: ranking[0] || null, ranking };
  }

  return {
    phase: session.phase,
    endsAt: session.ends_at || null,
    participants,
    posts,
    votes,
    awards,
  };
}

// GET /api/state
app.get('/api/state', (req, res) => {
  res.json(getState());
});

// POST /api/participants — add a participant (setup phase only)
app.post('/api/participants', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  const { phase } = db.prepare('SELECT phase FROM session WHERE id = 1').get();
  if (phase !== 'setup') return res.status(400).json({ error: 'game already started' });

  db.prepare('INSERT INTO participants (id, name) VALUES (?, ?)').run(uid(), name);
  res.json(getState());
});

// DELETE /api/participants/:id
app.delete('/api/participants/:id', (req, res) => {
  const { phase } = db.prepare('SELECT phase FROM session WHERE id = 1').get();
  if (phase !== 'setup') return res.status(400).json({ error: 'game already started' });

  db.prepare('DELETE FROM participants WHERE id = ?').run(req.params.id);
  res.json(getState());
});

// POST /api/start — begin writing phase
app.post('/api/start', (req, res) => {
  const { phase } = db.prepare('SELECT phase FROM session WHERE id = 1').get();
  if (phase !== 'setup') return res.status(400).json({ error: 'game already started' });

  const { n } = db.prepare('SELECT COUNT(*) as n FROM participants').get();
  if (n < 2) return res.status(400).json({ error: 'need at least 2 participants' });

  const endsAt = Date.now() + 20 * 60 * 1000;
  db.prepare('DELETE FROM posts').run();
  db.prepare('DELETE FROM votes').run();
  db.prepare("UPDATE session SET phase = 'writing', ends_at = ? WHERE id = 1").run(endsAt);
  res.json(getState());
});

// POST /api/end-writing — skip to voting early
app.post('/api/end-writing', (req, res) => {
  const { phase } = db.prepare('SELECT phase FROM session WHERE id = 1').get();
  if (phase !== 'writing') return res.status(400).json({ error: 'not in writing phase' });

  db.prepare("UPDATE session SET phase = 'voting' WHERE id = 1").run();
  res.json(getState());
});

// POST /api/posts — submit a post
app.post('/api/posts', (req, res) => {
  const { authorId, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });

  const { phase } = db.prepare('SELECT phase FROM session WHERE id = 1').get();
  if (phase !== 'writing') return res.status(400).json({ error: 'not in writing phase' });

  const author = db.prepare('SELECT * FROM participants WHERE id = ?').get(authorId);
  if (!author) return res.status(400).json({ error: 'author not found' });

  db.prepare(
    'INSERT INTO posts (id, author_id, author_name, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(uid(), authorId, author.name, content.trim(), Date.now());
  res.json(getState());
});

// POST /api/votes — toggle a vote
app.post('/api/votes', (req, res) => {
  const { postId, voterId } = req.body;
  if (!postId || !voterId) return res.status(400).json({ error: 'postId and voterId required' });

  const { phase } = db.prepare('SELECT phase FROM session WHERE id = 1').get();
  if (phase !== 'voting') return res.status(400).json({ error: 'not in voting phase' });

  const existing = db.prepare('SELECT 1 FROM votes WHERE post_id = ? AND voter_id = ?').get(postId, voterId);
  if (existing) {
    db.prepare('DELETE FROM votes WHERE post_id = ? AND voter_id = ?').run(postId, voterId);
  } else {
    db.prepare('INSERT INTO votes (post_id, voter_id) VALUES (?, ?)').run(postId, voterId);
  }
  res.json(getState());
});

// POST /api/reveal — end voting, compute results
app.post('/api/reveal', (req, res) => {
  const { phase } = db.prepare('SELECT phase FROM session WHERE id = 1').get();
  if (phase !== 'voting') return res.status(400).json({ error: 'not in voting phase' });

  db.prepare("UPDATE session SET phase = 'results' WHERE id = 1").run();
  res.json(getState());
});

// POST /api/reset — start over
app.post('/api/reset', (req, res) => {
  db.prepare('DELETE FROM participants').run();
  db.prepare('DELETE FROM posts').run();
  db.prepare('DELETE FROM votes').run();
  db.prepare("UPDATE session SET phase = 'setup', ends_at = NULL WHERE id = 1").run();
  res.json(getState());
});

// Serve the app
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'postathon.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'postathon.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Postathon running on http://localhost:${PORT}`);
});
