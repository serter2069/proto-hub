const fs = require('fs');
const path = require('path');
const os = require('os');

const COMMANDS_FILE = process.env.PROTO_COMMANDS_FILE || path.join(os.homedir(), '.proto-commands.json');

function load() {
  if (!fs.existsSync(COMMANDS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(COMMANDS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function list() {
  const data = load();
  return Object.entries(data).map(([name, doc]) => ({
    name,
    description: doc.description || '',
    updated_at: doc.updated_at || null,
  }));
}

function get(name) {
  const data = load();
  return data[name] || null;
}

function upsert(name, { content, description }) {
  const data = load();
  data[name] = {
    content: content !== undefined ? content : (data[name]?.content || ''),
    description: description !== undefined ? description : (data[name]?.description || ''),
    updated_at: new Date().toISOString(),
  };
  save(data);
  return data[name];
}

function remove(name) {
  const data = load();
  if (!data[name]) return false;
  delete data[name];
  save(data);
  return true;
}

module.exports = { list, get, upsert, remove, COMMANDS_FILE };
