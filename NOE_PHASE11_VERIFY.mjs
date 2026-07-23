// NOE_PHASE11_VERIFY.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOC_PATH = path.join(__dirname, 'NOE_STAGE11_RETROSPECTIVE_OPTIMIZATION.md');

const checks = [];
let passCount = 0;

function addCheck(description, condition) {
    const result = condition();
    checks.push({ description, passed: result });
    if (result) {
        passCount++;
    }
}

console.log(`--- Running NOE Phase 11 Verification ---`);

try {
    const docContent = fs.readFileSync(DOC_PATH, 'utf8');

    addCheck('Retrospective document exists', () => fs.existsSync(DOC_PATH));
    addCheck('Document is not empty', () => docContent.length > 0);
    addCheck('Contains "总体复盘结论" section', () => docContent.includes('## 1. 总体复盘结论'));
    addCheck('Contains "详细问题复盘与改进措施" section', () => docContent.includes('## 2. 详细问题复盘与改进措施'));
    addCheck('Contains "可复用经验与最佳实践" section', () => docContent.includes('### 2.3 可复用经验与最佳实践'));
    addCheck('Contains "下一轮优化方向与优先级" section', () => docContent.includes('## 3. 下一轮优化方向与优先级'));
    addCheck('Contains "工程闭环衔接" section', () => docContent.includes('## 4. 工程闭环衔接'));
    addCheck('Mentions "Node.js 版本预检" as a P1 improvement', () => docContent.includes('Node.js 版本预检 (P1)'));
    addCheck('Mentions "文档清理与规范化" as a P1 improvement', () => docContent.includes('文档清理与规范化 (P1)'));
    addCheck('Mentions "强化 Canonical 文档管理" as a P1 improvement', () => docContent.includes('强化 Canonical 文档管理 (P1)'));
    addCheck('Mentions "自动化测试脚本优化" as a P1 improvement', () => docContent.includes('自动化测试脚本优化 (P1)'));


} catch (error) {
    console.error(`Error reading document: ${error.message}`);
    addCheck('Failed to read document due to error', () => false);
}

console.log(`
--- Verification Results ---`);
checks.forEach(check => {
    console.log(`[${check.passed ? 'PASS' : 'FAIL'}] ${check.description}`);
});

if (passCount === checks.length) {
    console.log(`
Result: ${passCount}/${checks.length} checks passed. EXIT=0`);
    process.exit(0);
} else {
    console.log(`
Result: ${passCount}/${checks.length} checks passed. EXIT=1`);
    process.exit(1);
}
