// @ts-check
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NoeSelfModel } from '../../src/context/NoeSelfModel.js';
import {
  NoeSelfModelVersionStore,
  normalizeSelfModelIdentity,
  validateSelfModelVersionPayload,
} from '../../src/context/NoeSelfModelVersionStore.js';

const tempRoots = [];
const T0 = 1_780_000_000_000;
const fakeTimeline = { recent: () => [] };

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'noe-self-model-version-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('NoeSelfModelVersionStore', () => {
  it('normalizes and validates version payloads', () => {
    expect(normalizeSelfModelIdentity({
      name: '  Noe  ',
      relationship: ' owner   partner ',
      disposition: ' honest ',
      values: [' truth ', '', ' evidence '],
      ignored: 'x',
    })).toEqual({
      name: 'Noe',
      relationship: 'owner partner',
      disposition: 'honest',
      values: ['truth', 'evidence'],
    });
    expect(validateSelfModelVersionPayload({ schemaVersion: 1, versionId: 'v001', identity: { name: 'Noe' } }).ok).toBe(true);
    expect(validateSelfModelVersionPayload({ schemaVersion: 2, versionId: 'bad', identity: {} }).blockers).toEqual([
      'unsupported_schema_version',
      'invalid_version_id',
      'identity_empty',
    ]);
  });

  it('writes vNNN files and moves current to the latest version', () => {
    const store = new NoeSelfModelVersionStore({ rootDir: tempDir(), now: () => T0 });
    const first = store.writeNextVersion({
      identity: { name: 'Noe', relationship: 'owner 是我的主人' },
      reason: 'bootstrap',
      ownerConfirmed: true,
      proposalId: 'p1',
    });
    expect(first.ok).toBe(true);
    expect(first.version.versionId).toBe('v001');
    expect(store.current().identity.name).toBe('Noe');

    const blocked = store.writeNextVersion({ identity: { name: '伴影' }, reason: 'rename without owner' });
    expect(blocked).toMatchObject({ ok: false, reason: 'owner_confirmation_required_for_identity_core', previousVersionId: 'v001' });

    const second = store.writeNextVersion({
      identity: { name: '伴影', values: ['诚实', '证据优先'] },
      reason: 'owner approved rename',
      ownerConfirmed: true,
      evidenceRefs: ['docs/DESIGN_2026-06-11_AI自我意识实现方案.md#7.6'],
      proposalId: 'p2',
    });
    expect(second.ok).toBe(true);
    expect(second.version.versionId).toBe('v002');
    expect(second.version.previousVersionId).toBe('v001');
    expect(store.current().identity).toMatchObject({ name: '伴影', relationship: 'owner 是我的主人', values: ['诚实', '证据优先'] });
    expect(store.listVersions()).toEqual(['v001', 'v002']);
  });

  it('NoeSelfModel reads the versioned identity layer and lets explicit injection override it', () => {
    const store = new NoeSelfModelVersionStore({ rootDir: tempDir(), now: () => T0 });
    store.writeNextVersion({
      identity: { name: '伴影', relationship: '我和 owner 一起开发 Noe', disposition: '证据优先' },
      ownerConfirmed: true,
    });

    const model = new NoeSelfModel({ timeline: fakeTimeline, hostContextBlock: () => '', now: () => T0, selfModelVersionStore: store });
    expect(model.snapshot().identity).toMatchObject({
      name: '伴影',
      relationship: '我和 owner 一起开发 Noe',
      disposition: '证据优先',
      selfModelVersion: 'v001',
    });

    const overridden = new NoeSelfModel({
      timeline: fakeTimeline,
      hostContextBlock: () => '',
      now: () => T0,
      selfModelVersionStore: store,
      identity: { name: '测试覆盖名' },
    });
    expect(overridden.snapshot().identity).toMatchObject({ name: '测试覆盖名', selfModelVersion: 'v001' });
  });

  it('does not follow a current symlink outside the self-model directory', () => {
    const root = tempDir();
    const outside = join(tempDir(), 'outside.json');
    mkdirSync(root, { recursive: true });
    writeFileSync(outside, JSON.stringify({ schemaVersion: 1, versionId: 'v999', identity: { name: '外部文件' } }));
    symlinkSync(outside, join(root, 'current'));
    const store = new NoeSelfModelVersionStore({ rootDir: root, now: () => T0 });
    expect(store.current()).toBeNull();
  });
});
