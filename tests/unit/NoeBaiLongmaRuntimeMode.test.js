import { describe, it, expect } from 'vitest';
import {
  BAILONGMA_STYLE_MODE_ID,
  NEO_DEFAULT_MODE_ID,
  RUNTIME_MODE_SCHEMA,
  BAILONGMA_TOPOLOGY_BASELINE,
  buildBaiLongmaGapMatrix,
  validateGapMatrix,
} from '../../src/runtime/NoeBaiLongmaRuntimeMode.js';

describe('NoeBaiLongmaRuntimeMode', () => {
  it('exports correct mode IDs and schema', () => {
    expect(BAILONGMA_STYLE_MODE_ID).toBe('bailongma_style');
    expect(NEO_DEFAULT_MODE_ID).toBe('neo_default');
    expect(RUNTIME_MODE_SCHEMA).toBe('neo.runtime-mode.v1');
  });

  it('exports frozen topology baseline with expected properties', () => {
    expect(BAILONGMA_TOPOLOGY_BASELINE.release).toBe('v2.1.549');
    expect(BAILONGMA_TOPOLOGY_BASELINE.topologyClass).toBe('hybrid_local_desktop_plus_cloud_llm');
    expect(BAILONGMA_TOPOLOGY_BASELINE.isFullyCloud).toBe(false);
    expect(() => {
      BAILONGMA_TOPOLOGY_BASELINE.release = 'v3.0.0';
    }).toThrow();
  });

  it('buildBaiLongmaGapMatrix returns array with 8 rows', () => {
    const matrix = buildBaiLongmaGapMatrix();
    expect(Array.isArray(matrix)).toBe(true);
    expect(matrix.length).toBe(8);
  });

  it('buildBaiLongmaGapMatrix rows have required fields', () => {
    const matrix = buildBaiLongmaGapMatrix();
    for (const row of matrix) {
      expect(row).toHaveProperty('dimension');
      expect(row).toHaveProperty('bailongma');
      expect(row).toHaveProperty('neo');
      expect(row).toHaveProperty('status');
      expect(row).toHaveProperty('decision');
      expect(row).toHaveProperty('rationale');
      expect(['neo_has', 'neo_weaker', 'neo_missing']).toContain(row.status);
      expect(['replicate', 'borrow', 'invent', 'refuse']).toContain(row.decision);
    }
  });

  it('validateGapMatrix rejects empty array', () => {
    const result = validateGapMatrix([]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('matrix_empty');
  });

  it('validateGapMatrix rejects non-array input', () => {
    const result = validateGapMatrix(null);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('matrix_empty');
  });

  it('validateGapMatrix accepts canonical matrix', () => {
    const matrix = buildBaiLongmaGapMatrix();
    const result = validateGapMatrix(matrix);
    expect(result.ok).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('validateGapMatrix detects missing dimension', () => {
    const matrix = buildBaiLongmaGapMatrix().filter(r => r.dimension !== 'voice');
    const result = validateGapMatrix(matrix);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing_dimension:voice');
  });

  it('validateGapMatrix detects bad status', () => {
    const matrix = buildBaiLongmaGapMatrix();
    matrix[0].status = 'invalid_status';
    const result = validateGapMatrix(matrix);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('bad_status:main_loop_heartbeat');
  });

  it('validateGapMatrix detects bad decision', () => {
    const matrix = buildBaiLongmaGapMatrix();
    matrix[0].decision = 'invalid_decision';
    const result = validateGapMatrix(matrix);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('bad_decision:main_loop_heartbeat');
  });

  it('validateGapMatrix detects missing rationale', () => {
    const matrix = buildBaiLongmaGapMatrix();
    matrix[0].rationale = '';
    const result = validateGapMatrix(matrix);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('rationale_missing:main_loop_heartbeat');
  });

  it('validateGapMatrix detects no replicate or borrow rows', () => {
    const matrix = buildBaiLongmaGapMatrix().map(r => ({ ...r, decision: 'refuse' }));
    const result = validateGapMatrix(matrix);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('no_replicate_or_borrow_row');
  });

  it('validateGapMatrix detects non-object row', () => {
    const matrix = [...buildBaiLongmaGapMatrix(), 'not_an_object'];
    const result = validateGapMatrix(matrix);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('row_not_object');
  });
});
