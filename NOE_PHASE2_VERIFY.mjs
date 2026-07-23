import fs from 'node:fs';

const files = [
  'NOE_BAILONGMA_ARCH_AUDIT.md',
  'NOE_PHASE2_REQUIREMENTS.md',
  'NOE_PHASE2_REQUIREMENTS_拆解_Claude.md',
  'NOE_PHASE2_REQUIREMENTS_CANONICAL.md',
];

const knownToken = /(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const assignment = /(?:api[_-]?key|access[_-]?token|secret|private[_-]?key|doubaoKey|token)\s*["'` ]*[:=]\s*["'`]([^"'`\n]{6,})["'`]/i;
const allowedValue = /^(<REDACTED>|REDACTED|\*+|x+|your[_-]|example|placeholder|dummy|test|false|true|null|undefined)$/i;

const findings = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\n/).forEach((line, index) => {
    if (knownToken.test(line)) {
      findings.push({ file, line: index + 1, type: 'known-token' });
    }
    const match = line.match(assignment);
    if (match && !allowedValue.test(match[1].trim())) {
      findings.push({ file, line: index + 1, type: 'credential-assignment' });
    }
  });
}

const canonical = fs.readFileSync('NOE_PHASE2_REQUIREMENTS_CANONICAL.md', 'utf8');
const rows = [...canonical.matchAll(/^\| (UR-\d+|FR-\d{2}|NFR-[A-Z]+-\d) \|([^\n]+)$/gm)]
  .map((match) => ({ id: match[1], row: match[0] }));

function cells(row) {
  return row.split('|').slice(1, -1).map((cell) => cell.trim());
}

const missingAcceptance = rows.filter((requirement) => {
  const rowCells = cells(requirement.row);
  if (requirement.id.startsWith('UR-')) return rowCells.length < 3 || !rowCells[2];
  if (requirement.id.startsWith('FR-')) return rowCells.length < 5 || !rowCells[3];
  if (requirement.id.startsWith('NFR-')) return rowCells.length < 4 || !rowCells[3];
  return true;
}).map((requirement) => requirement.id);

const result = {
  secretScan: {
    files: files.length,
    findings,
  },
  requirements: {
    ur: rows.filter((requirement) => requirement.id.startsWith('UR-')).length,
    fr: rows.filter((requirement) => requirement.id.startsWith('FR-')).length,
    nfr: rows.filter((requirement) => requirement.id.startsWith('NFR-')).length,
    missingAcceptance,
    hasDependencySection: /## 5\. 依赖关系与优先级/.test(canonical),
    hasGapSection: /## 6\. 缺口问题/.test(canonical),
    hasEngineeringLoop: /## 7\. 工程闭环 11 阶段落地/.test(canonical),
  },
};

console.log(JSON.stringify(result, null, 2));

if (
  findings.length ||
  result.requirements.ur !== 6 ||
  result.requirements.fr !== 12 ||
  result.requirements.nfr !== 9 ||
  missingAcceptance.length ||
  !result.requirements.hasDependencySection ||
  !result.requirements.hasGapSection ||
  !result.requirements.hasEngineeringLoop
) {
  process.exit(1);
}
