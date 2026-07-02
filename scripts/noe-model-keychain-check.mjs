#!/usr/bin/env node

import {
  NOE_PROVIDER_SECRET_PROFILES,
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../src/secrets/NoeProviderSecrets.js';

const providers = {};
for (const provider of Object.keys(NOE_PROVIDER_SECRET_PROFILES)) {
  const result = resolveNoeProviderSecret(provider);
  providers[provider] = {
    ok: result.ok,
    source: result.source,
    sourceRef: result.ok ? result.sourceRef : null,
    message: result.ok ? `${provider} key resolved from ${result.source}` : describeNoeProviderSecretFailure(provider, result),
  };
}

console.log(JSON.stringify({
  ok: Object.values(providers).every((item) => item.ok),
  providers,
  note: 'No secret values are printed.',
}, null, 2));

