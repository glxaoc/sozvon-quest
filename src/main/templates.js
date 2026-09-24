'use strict';
// Сохранённые списки пользователя: <userData>/templates.json
// [{ id, type, name, text, updatedAt }]; text — список тезисов как в поле ввода (одна строка — один тезис).
const fs = require('fs');
const path = require('path');

function file(dir) { return path.join(dir, 'templates.json'); }

function read(dir) {
  try { const a = JSON.parse(fs.readFileSync(file(dir), 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

function write(dir, arr) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(dir), JSON.stringify(arr, null, 2), 'utf8');
}

function save(dir, { type, name, text }) {
  const arr = read(dir);
  const clean = String(name || '').trim().slice(0, 60) || 'Мой список';
  const existing = arr.find((t) => t.type === type && t.name.toLowerCase() === clean.toLowerCase());
  if (existing) { existing.text = text; existing.updatedAt = Date.now(); }
  else arr.push({ id: `u${Date.now().toString(36)}`, type, name: clean, text, updatedAt: Date.now() });
  write(dir, arr);
  return arr;
}

function remove(dir, id) {
  const arr = read(dir).filter((t) => t.id !== id);
  write(dir, arr);
  return arr;
}

module.exports = { read, save, remove };
