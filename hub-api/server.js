const express = require("express");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://proto_user:proto_hub_pass@127.0.0.1/proto_hub"
});

// ─── DB INIT ──────────────────────────────────────────────────────────────────

async function initTables() {
  // Legacy table — keep
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proto_runs (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      command TEXT NOT NULL,
      page_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add PAGE_MAP columns to existing pages table if missing
  const pageCols = ['roles TEXT[]', 'states_list TEXT[]', 'elements TEXT[]', 'actions TEXT[]'];
  for (const col of pageCols) {
    const colName = col.split(' ')[0];
    await pool.query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }

  // stories — uses composite FK matching pages PK (id, project_id)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stories (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      title TEXT NOT NULL,
      role TEXT,
      precondition TEXT,
      steps TEXT[],
      expected TEXT,
      status TEXT DEFAULT 'pending',
      tested_by TEXT,
      tested_at TIMESTAMPTZ,
      failure_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (page_id, project_id) REFERENCES pages(id, project_id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id SERIAL PRIMARY KEY,
      story_id INT REFERENCES stories(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      agent_id TEXT,
      status TEXT NOT NULL,
      output TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("All tables ready");
}

initTables().catch(e => console.error("Init error:", e.message));

// ─── PAGEREGISTRY PARSER ──────────────────────────────────────────────────────

function extractStringField(obj, field) {
  const m = obj.match(new RegExp(`\\b${field}\\s*:\\s*['"]([^'"]*)['"']`));
  return m ? m[1] : null;
}

function extractNumberField(obj, field) {
  const m = obj.match(new RegExp(`\\b${field}\\s*:\\s*(\\d+)`));
  return m ? parseInt(m[1]) : 0;
}

function extractArrayField(obj, field) {
  const m = obj.match(new RegExp(`\\b${field}\\s*:\\s*\\[([^\\]]*?)\\]`, 's'));
  if (!m) return [];
  const items = m[1].match(/['"]([^'"]*)['"]/g);
  return items ? items.map(s => s.replace(/['"]/g, '')) : [];
}

function parsePageObject(obj) {
  return {
    id: extractStringField(obj, 'id'),
    title: extractStringField(obj, 'title'),
    group: extractStringField(obj, 'group'),
    route: extractStringField(obj, 'route'),
    nav: extractStringField(obj, 'nav') || 'none',
    stateCount: extractNumberField(obj, 'stateCount'),
    status: extractStringField(obj, 'status') || 'none',
    roles: extractArrayField(obj, 'roles'),
    description: extractStringField(obj, 'description'),
    states_list: extractArrayField(obj, 'states_list'),
    elements: extractArrayField(obj, 'elements'),
    actions: extractArrayField(obj, 'actions'),
    activeTab: extractStringField(obj, 'activeTab'),
  };
}

function parsePageRegistry(content) {
  const pages = [];
  const registryMatch = content.match(/export\s+const\s+(?:pageRegistry|pages)[^=]*=\s*\[([\s\S]*?)\];/);
  if (!registryMatch) return pages;
  const body = registryMatch[1];

  let depth = 0, start = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (body[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const page = parsePageObject(body.slice(start, i + 1));
        if (page && page.id) pages.push(page);
        start = -1;
      }
    }
  }
  return pages;
}

// ─── STORY GENERATION ─────────────────────────────────────────────────────────

function generateStories(projectId, page) {
  const stories = [];
  const roles = page.roles && page.roles.length ? page.roles : ['USER'];
  const states = page.states_list && page.states_list.length ? page.states_list : ['DEFAULT'];

  for (const role of roles) {
    for (const state of states) {
      const stateLower = state.toLowerCase().replace(/_/g, ' ');
      const title = `[${role}] ${page.title} — ${state}`;
      let precondition = `User is logged in as ${role}`;
      if (role === 'PUBLIC' || role === 'GUEST') precondition = 'User is not logged in';

      const steps = [`Navigate to ${page.route || page.title}`];
      if (state !== 'DEFAULT') steps.push(`Trigger ${stateLower} state`);
      if (page.elements && page.elements.length)
        steps.push(`Verify visible: ${page.elements.slice(0, 3).join(', ')}`);

      stories.push({
        project_id: projectId,
        page_id: page.id,
        title, role, precondition, steps,
        expected: `Page shows ${stateLower} correctly. All spec elements present.`,
      });
    }
  }
  return stories;
}

// ─── LEGACY ENDPOINTS ─────────────────────────────────────────────────────────

app.post("/api/runs", async (req, res) => {
  const { projectId, command, pageId } = req.body;
  if (!projectId || !command) return res.status(400).json({ error: "projectId and command required" });
  const { rows } = await pool.query(
    "INSERT INTO proto_runs (project_id, command, page_id) VALUES ($1, $2, $3) RETURNING *",
    [projectId, command, pageId || null]
  );
  res.json(rows[0]);
});

app.get("/api/runs", async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: "project required" });
  const { rows } = await pool.query(
    "SELECT * FROM proto_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100",
    [project]
  );
  res.json(rows);
});

app.get("/api/runs/counts", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT project_id, command, COUNT(*) as count FROM proto_runs GROUP BY project_id, command"
  );
  const result = {};
  for (const row of rows) {
    if (!result[row.project_id]) result[row.project_id] = {};
    result[row.project_id][row.command] = parseInt(row.count);
  }
  res.json(result);
});

app.get("/api/runs/needs-work", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT project_id, command, COUNT(*) as count FROM proto_runs GROUP BY project_id, command"
  );
  const counts = {};
  for (const row of rows) {
    if (!counts[row.project_id]) counts[row.project_id] = {};
    counts[row.project_id][row.command] = parseInt(row.count);
  }

  const projects = [...new Set([
    "p2ptax", "avito-georgia", "chesstourism", "daterabbit", "dressit", "gun",
    ...Object.keys(counts)
  ])];

  const needsWork = [];
  for (const project of projects) {
    const protoCount = (counts[project] && counts[project]["proto"]) || 0;
    const checkCount = (counts[project] && counts[project]["proto-check"]) || 0;
    if (protoCount < 10) needsWork.push({ project, command: "proto", count: protoCount });
    else if (checkCount < 10) needsWork.push({ project, command: "proto-check", count: checkCount });
  }

  needsWork.sort((a, b) => {
    if (a.command !== b.command) return a.command === "proto" ? -1 : 1;
    return a.count - b.count;
  });

  res.json(needsWork);
});

// ─── SYNC ─────────────────────────────────────────────────────────────────────

// POST /api/sync/:project — read pageRegistry.ts from disk, upsert pages
app.post("/api/sync/:project", async (req, res) => {
  const { project } = req.params;

  // Ensure project exists
  await pool.query(
    `INSERT INTO projects (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
    [project]
  );

  const registryPath = path.join("/var/www/proto-stubs", project, "constants", "pageRegistry.ts");
  if (!fs.existsSync(registryPath)) {
    return res.status(404).json({ error: `pageRegistry.ts not found at ${registryPath}` });
  }

  const content = fs.readFileSync(registryPath, "utf8");
  const pages = parsePageRegistry(content);

  if (pages.length === 0) {
    return res.status(422).json({ error: "No pages parsed", path: registryPath });
  }

  let upserted = 0;
  for (const page of pages) {
    await pool.query(`
      INSERT INTO pages (id, project_id, title, group_name, route, nav, state_count, status, active_tab, description, roles, states_list, elements, actions, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (id, project_id) DO UPDATE SET
        title=EXCLUDED.title, group_name=EXCLUDED.group_name, route=EXCLUDED.route,
        nav=EXCLUDED.nav, state_count=EXCLUDED.state_count, status=EXCLUDED.status,
        active_tab=EXCLUDED.active_tab, description=EXCLUDED.description,
        roles=EXCLUDED.roles, states_list=EXCLUDED.states_list,
        elements=EXCLUDED.elements, actions=EXCLUDED.actions, updated_at=NOW()
    `, [
      page.id, project, page.title, page.group, page.route,
      page.nav, page.stateCount, page.status,
      page.activeTab || null, page.description,
      page.roles, page.states_list, page.elements, page.actions
    ]);
    upserted++;
  }

  res.json({ project, upserted, total: pages.length });
});

// ─── PAGES ────────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/pages", async (req, res) => {
  const { rows: pages } = await pool.query(
    "SELECT * FROM pages WHERE project_id=$1 ORDER BY group_name, id",
    [req.params.id]
  );

  const { rows: counts } = await pool.query(`
    SELECT page_id, COUNT(*) total, COUNT(*) FILTER (WHERE status='passed') passed
    FROM stories WHERE project_id=$1 GROUP BY page_id
  `, [req.params.id]);

  const coverageMap = {};
  for (const c of counts) coverageMap[c.page_id] = c;

  res.json(pages.map(p => ({
    ...p,
    stories_total: parseInt((coverageMap[p.id] || {}).total || 0),
    stories_passed: parseInt((coverageMap[p.id] || {}).passed || 0),
  })));
});

// ─── STORIES ─────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/stories", async (req, res) => {
  const { status, page_id } = req.query;
  let query = "SELECT * FROM stories WHERE project_id=$1";
  const params = [req.params.id];
  if (status) { params.push(status); query += ` AND status=$${params.length}`; }
  if (page_id) { params.push(page_id); query += ` AND page_id=$${params.length}`; }
  query += " ORDER BY page_id, id";
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// POST /api/projects/:id/stories/generate
app.post("/api/projects/:id/stories/generate", async (req, res) => {
  const projectId = req.params.id;
  const { force } = req.body;

  const { rows: pages } = await pool.query(
    "SELECT * FROM pages WHERE project_id=$1", [projectId]
  );

  if (pages.length === 0) {
    return res.status(404).json({ error: "No pages found. Run POST /api/sync/:project first." });
  }

  let created = 0, skipped = 0;

  for (const page of pages) {
    if (!page.states_list || page.states_list.length === 0) { skipped++; continue; }

    const { rows: existing } = await pool.query(
      "SELECT id FROM stories WHERE page_id=$1 AND project_id=$2 LIMIT 1", [page.id, projectId]
    );

    if (existing.length > 0 && !force) { skipped++; continue; }

    if (force) {
      await pool.query("DELETE FROM stories WHERE page_id=$1 AND project_id=$2 AND status='pending'",
        [page.id, projectId]);
    }

    const stories = generateStories(projectId, page);
    for (const s of stories) {
      await pool.query(`
        INSERT INTO stories (project_id, page_id, title, role, precondition, steps, expected)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [s.project_id, s.page_id, s.title, s.role, s.precondition, s.steps, s.expected]);
      created++;
    }
  }

  res.json({ project: projectId, created, skipped });
});

// GET /api/stories/pending
app.get("/api/stories/pending", async (req, res) => {
  const { project, limit = 10 } = req.query;
  const params = [];
  let query = `SELECT s.*, p.title as page_title, p.route
    FROM stories s JOIN pages p ON p.id=s.page_id AND p.project_id=s.project_id
    WHERE s.status='pending'`;
  if (project) { params.push(project); query += ` AND s.project_id=$${params.length}`; }
  params.push(parseInt(limit));
  query += ` ORDER BY s.project_id, s.page_id, s.id LIMIT $${params.length}`;
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// PATCH /api/stories/:id
app.patch("/api/stories/:id", async (req, res) => {
  const { status, tested_by, failure_reason, output } = req.body;
  const valid = ['pending', 'passed', 'failed', 'skipped'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  }

  const { rows } = await pool.query(`
    UPDATE stories SET status=$1, tested_by=$2, failure_reason=$3, tested_at=NOW()
    WHERE id=$4 RETURNING *
  `, [status, tested_by || null, failure_reason || null, req.params.id]);

  if (rows.length === 0) return res.status(404).json({ error: "Story not found" });

  if (tested_by || output) {
    await pool.query(`
      INSERT INTO test_runs (story_id, project_id, agent_id, status, output)
      SELECT $1, project_id, $2, $3, $4 FROM stories WHERE id=$1
    `, [req.params.id, tested_by || null, status, output || null]);
  }

  res.json(rows[0]);
});

// GET /api/projects/:id/coverage
app.get("/api/projects/:id/coverage", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      p.id as page_id, p.title, p.group_name, p.status as proto_status,
      COUNT(s.id) as total,
      COUNT(s.id) FILTER (WHERE s.status='passed') as passed,
      COUNT(s.id) FILTER (WHERE s.status='failed') as failed,
      COUNT(s.id) FILTER (WHERE s.status='pending') as pending
    FROM pages p
    LEFT JOIN stories s ON s.page_id=p.id AND s.project_id=p.project_id
    WHERE p.project_id=$1
    GROUP BY p.id, p.title, p.group_name, p.status
    ORDER BY p.group_name, p.id
  `, [req.params.id]);

  const summary = {
    total_pages: rows.length,
    covered: rows.filter(r => parseInt(r.total) > 0).length,
    all_passed: rows.filter(r => parseInt(r.total) > 0 && r.total === r.passed).length,
  };

  res.json({ project: req.params.id, summary, pages: rows });
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3901;
app.listen(PORT, () => console.log("proto-hub-api listening on port " + PORT));
