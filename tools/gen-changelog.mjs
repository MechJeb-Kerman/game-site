// 从 git 提交历史生成 src/changelog-data.js（更新说明页读它；发版前重跑并提交）
// 用法：node tools/gen-changelog.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'changelog-data.js');
const LIMIT = Math.max(1, Number(process.env.LIMIT) || 300);

const KINDS = { feat: '新功能', fix: '修复', test: '测试', docs: '文档', chore: '杂项', refactor: '重构', perf: '优化', style: '样式' };

// git 自己把 %x09 展开成制表符，省得在脚本里写转义
const raw = execFileSync('git',
  ['log', '--no-merges', '--date=format:%Y-%m-%d %H:%M', '--pretty=format:%h%x09%ad%x09%s', '-n', String(LIMIT)],
  { cwd: ROOT, encoding: 'utf8' });

const entries = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (line) {
  const parts = line.split('\t');
  const hash = parts[0] || '';
  const date = parts[1] || '';
  const subject = parts.slice(2).join(' ').trim();
  const m = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject);
  const kind = m && KINDS[m[1]] ? m[1] : '';
  return {
    hash: hash,
    date: date,
    day: date.slice(0, 10),
    kind: kind,
    kindLabel: kind ? KINDS[kind] : '其它',
    subject: m ? m[2].trim() : subject
  };
});

const code = '// 这个文件由 tools/gen-changelog.mjs 从 git 提交历史生成，不要手改；发版前重跑一次并一起提交。\n' +
  'export const CHANGELOG_GENERATED = ' + JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) + ';\n' +
  'export const CHANGELOG_TOTAL = ' + entries.length + ';\n' +
  'export const CHANGELOG = ' + JSON.stringify(entries, null, 2) + ';\n';

fs.writeFileSync(OUT, code, 'utf8');
console.log('已写入 ' + path.relative(ROOT, OUT) + '：' + entries.length + ' 条提交');
