import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const DEFAULT_NOE_SSH_CONFIG_PATH = `${homedir()}/.ssh/config`;

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function resolveHomePath(value = '') {
  const text = String(value || '').trim();
  if (!text) return DEFAULT_NOE_SSH_CONFIG_PATH;
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return resolve(homedir(), text.slice(2));
  return resolve(text);
}

function splitWords(value = '') {
  return String(value || '').trim().split(/\s+/).map((item) => clean(item, 240)).filter(Boolean);
}

function safeAlias(pattern = '') {
  const text = clean(pattern, 240);
  if (!text || text === '*') return '';
  return text;
}

function redactPathMetadata(value = '') {
  const text = clean(value, 1000);
  if (!text) return { configured: false };
  const name = text.split('/').filter(Boolean).pop() || text;
  return { configured: true, basename: clean(name, 160) };
}

export function parseNoeSshConfig(content = '') {
  const hosts = [];
  let current = null;
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'host') {
      const aliases = splitWords(value).map(safeAlias).filter(Boolean);
      current = aliases.length ? { aliases, options: {} } : null;
      if (current) hosts.push(current);
      continue;
    }
    if (!current) continue;
    if (!current.options[key]) current.options[key] = value;
  }

  return hosts.map((host) => ({
    aliases: host.aliases,
    hostName: clean(host.options.hostname || '', 300),
    user: clean(host.options.user || '', 200),
    port: clean(host.options.port || '', 20),
    identityFile: redactPathMetadata(host.options.identityfile || ''),
    proxyJumpConfigured: Boolean(host.options.proxyjump),
    localForwardConfigured: Boolean(host.options.localforward),
    remoteForwardConfigured: Boolean(host.options.remoteforward),
  }));
}

export function inspectNoeSshInventory({
  path = DEFAULT_NOE_SSH_CONFIG_PATH,
  maxHosts = 200,
  allowSymlink = false,
} = {}) {
  const configPath = resolveHomePath(path);
  if (!existsSync(configPath)) {
    return {
      ok: true,
      path: configPath,
      hosts: [],
      count: 0,
      configExists: false,
      privateKeyRead: false,
      networkConnectionAttempted: false,
      passwordPromptAllowed: false,
    };
  }
  const stat = lstatSync(configPath);
  if (stat.isSymbolicLink() && allowSymlink !== true) {
    return {
      ok: false,
      path: configPath,
      error: 'ssh_config_symlink_not_allowed',
      privateKeyRead: false,
      networkConnectionAttempted: false,
      passwordPromptAllowed: false,
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      path: configPath,
      error: 'ssh_config_not_a_file',
      privateKeyRead: false,
      networkConnectionAttempted: false,
      passwordPromptAllowed: false,
    };
  }

  const content = readFileSync(configPath, 'utf8');
  const limit = Math.max(1, Math.min(500, Number(maxHosts) || 200));
  const hosts = parseNoeSshConfig(content).slice(0, limit);
  return {
    ok: true,
    path: configPath,
    configExists: true,
    count: hosts.length,
    hosts,
    contentRead: true,
    privateKeyRead: false,
    networkConnectionAttempted: false,
    passwordPromptAllowed: false,
  };
}
