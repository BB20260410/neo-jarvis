// tests/unit/workspace-manager.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Force node:os.homedir() to a temp dir BEFORE WorkspaceManager is evaluated.
// Vitest hoists vi.mock calls above all imports, so HOME/etc. in the SUT
// will resolve under TEST_HOME rather than the real ~/.noe-panel.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => '/tmp/noe-panel-test-home';
  return {
    ...actual,
    homedir,
    default: { ...actual, homedir },
  };
});

import {
  listWorkspaces,
  getActive,
  setActive,
  createWorkspace,
  deleteWorkspace,
  getWorkspaceDir,
  getDbPath,
  HOME,
  WORKSPACES_DIR,
  DEFAULT_NAME,
} from '../../src/workspace/WorkspaceManager.js';

const TEST_HOME = '/tmp/noe-panel-test-home';
const ACTIVE_FILE_PATH = path.join(TEST_HOME, '.noe-panel', 'active-workspace.txt');

function rmTestHome() {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
}

beforeEach(() => {
  rmTestHome();
});

afterEach(() => {
  rmTestHome();
});

describe('WorkspaceManager', () => {
  describe('listWorkspaces', () => {
    it('returns at least the builtin default workspace', () => {
      const list = listWorkspaces();
      const def = list.find((w) => w.name === 'default');
      expect(def).toBeDefined();
      expect(def.builtin).toBe(true);
      expect(def.createdAt).toBeNull();
    });

    it('includes created workspaces with metadata merged from workspace.json', () => {
      createWorkspace('alpha', { description: 'first' });
      const list = listWorkspaces();
      const alpha = list.find((w) => w.name === 'alpha');
      expect(alpha).toBeDefined();
      expect(alpha.builtin).toBe(false);
      expect(alpha.description).toBe('first');
      expect(typeof alpha.createdAt).toBe('string');
    });

    it('does not duplicate default even when a default dir exists under workspaces/', () => {
      fs.mkdirSync(path.join(WORKSPACES_DIR, 'default'), { recursive: true });
      const list = listWorkspaces();
      expect(list.filter((w) => w.name === 'default')).toHaveLength(1);
    });

    it('ignores non-directory entries under workspaces/', () => {
      fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
      fs.writeFileSync(path.join(WORKSPACES_DIR, 'stray.txt'), 'hi');
      const list = listWorkspaces();
      expect(list.find((w) => w.name === 'stray.txt')).toBeUndefined();
    });

    it('tolerates a corrupt workspace.json (falls back to empty meta)', () => {
      const dir = path.join(WORKSPACES_DIR, 'broken');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'workspace.json'), '{not valid json');
      const list = listWorkspaces();
      const broken = list.find((w) => w.name === 'broken');
      expect(broken).toBeDefined();
      expect(broken.builtin).toBe(false);
    });
  });

  describe('getActive', () => {
    it('returns "default" when no active file exists', () => {
      expect(getActive()).toBe('default');
    });

    it('returns the stored active name', () => {
      createWorkspace('beta');
      setActive('beta');
      expect(getActive()).toBe('beta');
    });

    it('falls back to "default" when active file content fails the name regex', () => {
      fs.mkdirSync(path.dirname(ACTIVE_FILE_PATH), { recursive: true });
      fs.writeFileSync(ACTIVE_FILE_PATH, '!!! not a valid name !!!');
      expect(getActive()).toBe('default');
    });

    it('falls back to "default" when active file is empty/whitespace', () => {
      fs.mkdirSync(path.dirname(ACTIVE_FILE_PATH), { recursive: true });
      fs.writeFileSync(ACTIVE_FILE_PATH, '   ');
      expect(getActive()).toBe('default');
    });
  });

  describe('setActive', () => {
    it('persists the active workspace name to disk', () => {
      createWorkspace('gamma');
      setActive('gamma');
      expect(fs.readFileSync(ACTIVE_FILE_PATH, 'utf8')).toBe('gamma');
    });

    it('returns the name on success', () => {
      createWorkspace('gamma2');
      expect(setActive('gamma2')).toBe('gamma2');
    });

    it('throws when the workspace does not exist', () => {
      expect(() => setActive('ghost')).toThrow(/不存在/);
    });

    it('throws on invalid name', () => {
      expect(() => setActive('has space')).toThrow();
      expect(() => setActive('')).toThrow();
      expect(() => setActive(null)).toThrow();
    });
  });

  describe('createWorkspace', () => {
    it('creates the directory and metadata file with provided description', () => {
      const meta = createWorkspace('delta', { description: 'd' });
      expect(meta.name).toBe('delta');
      expect(meta.description).toBe('d');
      expect(fs.existsSync(path.join(WORKSPACES_DIR, 'delta'))).toBe(true);
      const written = JSON.parse(
        fs.readFileSync(path.join(WORKSPACES_DIR, 'delta', 'workspace.json'), 'utf8')
      );
      expect(written.name).toBe('delta');
      expect(written.description).toBe('d');
      expect(written.createdAt).toBe(meta.createdAt);
    });

    it('defaults description to empty string', () => {
      const meta = createWorkspace('noDesc');
      expect(meta.description).toBe('');
    });

    it('throws on duplicate name', () => {
      createWorkspace('dup');
      expect(() => createWorkspace('dup')).toThrow(/已存在/);
    });

    it("throws on reserved name 'default'", () => {
      expect(() => createWorkspace('default')).toThrow(/保留/);
    });

    it('throws on invalid names', () => {
      expect(() => createWorkspace('')).toThrow();
      expect(() => createWorkspace(null)).toThrow();
      expect(() => createWorkspace(123)).toThrow();
      expect(() => createWorkspace('a'.repeat(33))).toThrow();
      expect(() => createWorkspace('bad space')).toThrow();
    });
  });

  describe('deleteWorkspace', () => {
    it('removes the workspace directory and returns the deleted name', () => {
      createWorkspace('epsilon');
      const res = deleteWorkspace('epsilon');
      expect(res.deleted).toBe('epsilon');
      expect(fs.existsSync(path.join(WORKSPACES_DIR, 'epsilon'))).toBe(false);
    });

    it("throws when deleting 'default'", () => {
      expect(() => deleteWorkspace('default')).toThrow(/不能删除/);
    });

    it('throws on non-existent workspace', () => {
      expect(() => deleteWorkspace('nope')).toThrow(/不存在/);
    });

    it('clears the active file when deleting the active workspace', () => {
      createWorkspace('zeta');
      setActive('zeta');
      deleteWorkspace('zeta');
      expect(fs.existsSync(ACTIVE_FILE_PATH)).toBe(false);
      expect(getActive()).toBe('default');
    });

    it('keeps active file untouched when deleting a non-active workspace', () => {
      createWorkspace('eta');
      createWorkspace('theta');
      setActive('theta');
      deleteWorkspace('eta');
      expect(getActive()).toBe('theta');
    });

    it('throws on invalid name', () => {
      expect(() => deleteWorkspace('bad name')).toThrow();
      expect(() => deleteWorkspace('')).toThrow();
    });
  });

  describe('getWorkspaceDir', () => {
    it('returns HOME for the default workspace (legacy layout)', () => {
      expect(getWorkspaceDir('default')).toBe(HOME);
    });

    it('returns HOME when called with no arg and active is default', () => {
      expect(getWorkspaceDir()).toBe(HOME);
    });

    it('returns the workspace dir for a non-default name', () => {
      createWorkspace('iota');
      expect(getWorkspaceDir('iota')).toBe(path.join(WORKSPACES_DIR, 'iota'));
    });

    it('uses the active workspace when no name is provided', () => {
      createWorkspace('lambda');
      setActive('lambda');
      expect(getWorkspaceDir()).toBe(path.join(WORKSPACES_DIR, 'lambda'));
    });
  });

  describe('getDbPath', () => {
    it('returns HOME/panel.db for the default workspace', () => {
      expect(getDbPath('default')).toBe(path.join(HOME, 'panel.db'));
    });

    it('returns {workspaceDir}/panel.db for a named workspace', () => {
      createWorkspace('kappa');
      expect(getDbPath('kappa')).toBe(
        path.join(WORKSPACES_DIR, 'kappa', 'panel.db')
      );
    });

    it('uses the active workspace when no name is provided', () => {
      createWorkspace('mu');
      setActive('mu');
      expect(getDbPath()).toBe(path.join(WORKSPACES_DIR, 'mu', 'panel.db'));
    });
  });

  describe('exported constants', () => {
    it('HOME is under the mocked test home', () => {
      expect(HOME).toBe(path.join(TEST_HOME, '.noe-panel'));
    });

    it('WORKSPACES_DIR is HOME/workspaces', () => {
      expect(WORKSPACES_DIR).toBe(path.join(HOME, 'workspaces'));
    });

    it('DEFAULT_NAME is "default"', () => {
      expect(DEFAULT_NAME).toBe('default');
    });
  });
});
