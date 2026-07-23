#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { isCodePath, isCriticalPath, isNodeSyntaxPath, isSafeNonCodePath, isTestPath } from './lib/gate.mjs';

assert.equal(isNodeSyntaxPath('src/value.js'), true);
assert.equal(isNodeSyntaxPath('scripts/tool.py'), false);
assert.equal(isCodePath('public/app.html'), true);
assert.equal(isCodePath('scripts/tool.sh'), true);
assert.equal(isSafeNonCodePath('docs/decision.md'), true);
assert.equal(isSafeNonCodePath('public/active-content.svg'), false);
assert.equal(isSafeNonCodePath('config.yaml'), false);
assert.equal(isTestPath('tests/unit/value.test.js'), true);
assert.equal(isTestPath('test/value.spec.mjs'), true);
assert.equal(isTestPath('scripts/not-a-test.mjs'), false);
assert.equal(isCriticalPath('AGENTS.md'), true);
assert.equal(isCriticalPath('.github/workflows/ci.yml'), true);
assert.equal(isCriticalPath('config/runtime.json'), true);

process.stdout.write('gate unit tests: PASS (path risk and test classification)\n');
