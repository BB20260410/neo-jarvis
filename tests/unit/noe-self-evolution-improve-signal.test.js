import { describe, expect, it } from 'vitest';
import {
  IMPROVE_SIGNAL_SCHEMA,
  buildImproveSignal,
} from '../../src/room/NoeSelfEvolutionImproveSignal.js';

describe('buildImproveSignal', () => {
  it('normalizes a type-error target into an anchored improve signal', () => {
    const signal = buildImproveSignal({
      signal: 'type_error',
      file: 'src/example.js',
      errorCount: 2,
      errors: [
        { line: 12, code: 'TS2322', message: 'Type mismatch' },
        { line: 24, code: 'TS7006', message: 'Implicit any' },
      ],
    });

    expect(signal).toMatchObject({
      schemaVersion: 1,
      kind: IMPROVE_SIGNAL_SCHEMA,
      signal: 'type_error',
      targetFile: 'src/example.js',
      errorCount: 2,
      errorClass: 'TS2322',
      hasTechnicalAnchor: true,
    });
    expect(signal.errors).toEqual([
      { line: 12, code: 'TS2322', message: 'Type mismatch' },
      { line: 24, code: 'TS7006', message: 'Implicit any' },
    ]);
    expect(signal.objective).toContain('修 src/example.js 的 2 个结构性类型 error');
  });
});
