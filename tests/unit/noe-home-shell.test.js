import { describe, it, expect } from 'vitest';
import {
  buildHomeShellNavigation,
  validateHomeShellNavigation,
  buildHomeStatusChips,
  HOME_SHELL_SCHEMA,
} from '../../src/runtime/NoeHomeShell.js';

describe('NoeHomeShell', () => {
  describe('buildHomeShellNavigation', () => {
    it('returns main, settings, and expertReachable arrays', () => {
      const nav = buildHomeShellNavigation();
      expect(nav).toHaveProperty('main');
      expect(nav).toHaveProperty('settings');
      expect(nav).toHaveProperty('expertReachable');
      expect(Array.isArray(nav.main)).toBe(true);
      expect(Array.isArray(nav.settings)).toBe(true);
      expect(Array.isArray(nav.expertReachable)).toBe(true);
    });

    it('main contains chat, memory, and status', () => {
      const nav = buildHomeShellNavigation();
      const ids = nav.main.map((item) => item.id);
      expect(ids).toContain('chat');
      expect(ids).toContain('memory');
      expect(ids).toContain('status');
    });

    it('settings contains models, voice, runtime_mode, and permissions', () => {
      const nav = buildHomeShellNavigation();
      const ids = nav.settings.map((item) => item.id);
      expect(ids).toContain('models');
      expect(ids).toContain('voice');
      expect(ids).toContain('runtime_mode');
      expect(ids).toContain('permissions');
    });

    it('expertReachable contains cognitive, mind, governance, rooms, and terminal', () => {
      const nav = buildHomeShellNavigation();
      const ids = nav.expertReachable.map((item) => item.id);
      expect(ids).toContain('cognitive');
      expect(ids).toContain('mind');
      expect(ids).toContain('governance');
      expect(ids).toContain('rooms');
      expect(ids).toContain('terminal');
    });

    it('main items do not leak expert IDs', () => {
      const nav = buildHomeShellNavigation();
      const expertIds = new Set(nav.expertReachable.map((item) => item.id));
      for (const item of nav.main) {
        expect(expertIds.has(item.id)).toBe(false);
      }
    });
  });

  describe('validateHomeShellNavigation', () => {
    it('returns ok for valid navigation', () => {
      const nav = buildHomeShellNavigation();
      const result = validateHomeShellNavigation(nav);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('detects empty main', () => {
      const nav = { main: [], settings: buildHomeShellNavigation().settings, expertReachable: [] };
      const result = validateHomeShellNavigation(nav);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('main_empty');
    });

    it('detects empty settings', () => {
      const nav = { main: buildHomeShellNavigation().main, settings: [], expertReachable: [] };
      const result = validateHomeShellNavigation(nav);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('settings_empty');
    });

    it('detects missing chat in main', () => {
      const nav = {
        main: [{ id: 'memory', title: 'Memory' }],
        settings: buildHomeShellNavigation().settings,
        expertReachable: [],
      };
      const result = validateHomeShellNavigation(nav);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('main_missing_chat');
    });

    it('detects main leaking expert ID', () => {
      const nav = {
        main: [{ id: 'cognitive', title: 'Cognitive' }],
        settings: buildHomeShellNavigation().settings,
        expertReachable: [{ id: 'cognitive', title: 'Cognitive', expert: true }],
      };
      const result = validateHomeShellNavigation(nav);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('main_leaks_expert:cognitive');
    });
  });

  describe('buildHomeStatusChips', () => {
    it('returns default values when no opts provided', () => {
      const chips = buildHomeStatusChips();
      expect(chips.schemaVersion).toBe(1);
      expect(chips.kind).toBe(HOME_SHELL_SCHEMA);
      expect(chips.runtimeMode.modeId).toBe('neo_default');
      expect(chips.runtimeMode.label).toBe('Neo 默认');
      expect(chips.runtimeMode.bailongmaStyle).toBe(false);
      expect(chips.runtimeMode.proactiveTickMs).toBeNull();
      expect(chips.runtimeMode.isFullyCloud).toBe(false);
      expect(chips.voice.status).toBe('unknown');
      expect(chips.voice.ready).toBe(false);
      expect(chips.voice.uiHint).toBe('语音状态未知');
    });

    it('uses provided runtimeMode values', () => {
      const chips = buildHomeStatusChips({
        runtimeMode: {
          modeId: 'custom_mode',
          label: 'Custom Label',
          bailongmaStyle: true,
          isFullyCloud: true,
          effectiveEnv: { NOE_PROACTIVE_TICK_MS: 1000 },
        },
      });
      expect(chips.runtimeMode.modeId).toBe('custom_mode');
      expect(chips.runtimeMode.label).toBe('Custom Label');
      expect(chips.runtimeMode.bailongmaStyle).toBe(true);
      expect(chips.runtimeMode.proactiveTickMs).toBe(1000);
      expect(chips.runtimeMode.isFullyCloud).toBe(true);
    });

    it('uses provided voice values', () => {
      const chips = buildHomeStatusChips({
        voice: {
          status: 'ready',
          ready: true,
          uiHint: 'Voice Ready',
        },
      });
      expect(chips.voice.status).toBe('ready');
      expect(chips.voice.ready).toBe(true);
      expect(chips.voice.uiHint).toBe('Voice Ready');
    });

    it('surfaces self-evolution rings chip (perception/memory/falsify/boundary)', () => {
      const chips = buildHomeStatusChips({
        selfEvolution: {
          profile: 'safe',
          rings: {
            perception: true,
            memory: true,
            falsification: true,
            boundary: true,
          },
          armed: { rings: true, realApply: false, lessonFlywheel: true, heartbeat: true },
          honesty: { realApplyDefaultOff: true },
        },
      });
      expect(chips.selfEvolution.armed).toBe(true);
      expect(chips.selfEvolution.ringCount).toBe(4);
      expect(chips.selfEvolution.realApply).toBe(false);
      expect(chips.selfEvolution.label).toMatch(/dry-run/);
      expect(chips.selfEvolution.rings.perception).toBe(true);
      expect(chips.selfEvolution.rings.boundary).toBe(true);
    });

    it('does not claim boundary when realApply is on and rings.boundary omitted', () => {
      const chips = buildHomeStatusChips({
        selfEvolution: {
          profile: 'off',
          rings: {},
          armed: { realApply: true },
        },
      });
      expect(chips.selfEvolution.realApply).toBe(true);
      expect(chips.selfEvolution.rings.boundary).toBe(false);
      expect(chips.selfEvolution.label).toMatch(/真改/);
    });
  });
});
