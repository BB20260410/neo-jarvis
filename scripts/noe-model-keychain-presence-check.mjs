#!/usr/bin/env node

import {
  NOE_MODEL_KEYCHAIN_SERVICE,
  NOE_PROVIDER_SECRET_PROFILES,
  checkMacosKeychainSecretPresence,
} from '../src/secrets/NoeProviderSecrets.js';

function valueAfter(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function parseList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

const allProviders = Object.keys(NOE_PROVIDER_SECRET_PROFILES);
const required = parseList(valueAfter('--required', 'minimax'));
const optional = parseList(valueAfter('--optional', allProviders.filter((provider) => !required.includes(provider)).join(',')));
const selected = [...new Set([...required, ...optional])].filter((provider) => NOE_PROVIDER_SECRET_PROFILES[provider]);
const requiredSet = new Set(required);

function checkProvider(provider) {
  const profile = NOE_PROVIDER_SECRET_PROFILES[provider];
  const attempts = [];
  for (const account of profile.keychainAccounts || []) {
    const result = checkMacosKeychainSecretPresence({
      account,
      service: NOE_MODEL_KEYCHAIN_SERVICE,
    });
    attempts.push({
      account,
      ok: result.ok === true,
      error: result.ok ? '' : String(result.error || 'not_found').slice(0, 200),
    });
    if (result.ok) {
      return {
        provider,
        required: requiredSet.has(provider),
        configured: true,
        source: 'keychain',
        sourceRef: account,
        attempts,
        valueReturned: false,
        rawValueRead: false,
      };
    }
  }
  return {
    provider,
    required: requiredSet.has(provider),
    configured: false,
    source: 'unconfigured',
    sourceRef: null,
    attempts,
    valueReturned: false,
    rawValueRead: false,
  };
}

const providers = selected.map(checkProvider);
const missingRequired = providers.filter((item) => item.required && !item.configured).map((item) => item.provider);
console.log(JSON.stringify({
  ok: missingRequired.length === 0,
  mode: 'keychain-presence-only',
  service: NOE_MODEL_KEYCHAIN_SERVICE,
  requiredProviders: required,
  missingRequired,
  providers,
  valueReturned: false,
  rawValueRead: false,
  roomAdaptersRead: false,
  note: 'Presence check uses security find-generic-password without -w and does not print secret values.',
}, null, 2));
