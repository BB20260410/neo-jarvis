// @ts-check
import { expect, it } from 'vitest';
import { createDriveSystem } from '../../src/loop/NoeDriveSystem.js';
import { createCuriosityDecompose } from '../../src/cognition/NoeCuriosityDecompose.js';
const cv = (en, p) => createDriveSystem({ observationCount: () => 8, curiosity: createCuriosityDecompose({ enabled: en }), curiosityPragmatic: p }).snapshot().drives.find((d) => d.id === 'curiosity').value;
it('OFF=1 ON=0.25 pragmatic-raises', () => {
  expect(cv(false)).toBe(1);
  expect(cv(true)).toBeCloseTo(0.25, 9);
  expect(cv(true, () => 0.95)).toBeGreaterThan(cv(true, () => 0));
});
