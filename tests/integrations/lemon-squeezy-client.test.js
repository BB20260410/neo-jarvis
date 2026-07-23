// Unit tests for src/integrations/LemonSqueezyClient.js
// Strategy: mock node:fs (token file) and node:os (homedir) so the module's
// TOKEN_PATH resolves to a predictable fake location; stub global fetch so
// every request is asserted without hitting the network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';

// Hoisted by Vitest — runs before the SUT is imported.
vi.mock('node:os', () => ({
  default: { homedir: () => '/fake/home' },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

import fs from 'node:fs';
import * as LS from '../../../src/integrations/LemonSqueezyClient.js';

const TOKEN_PATH = path.join('/fake/home', '.noe-panel', 'lemonsqueezy-key.txt');
const API_BASE = 'https://api.lemonsqueezy.com/v1';

function okJson(body = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function failResponse(status = 500, text = 'server error') {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  };
}

let mockFetch;

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset().mockImplementation((p) => p === TOKEN_PATH);
  vi.mocked(fs.readFileSync).mockReset().mockReturnValue('secret-token\n');
  mockFetch = vi.fn().mockResolvedValue(okJson({ data: [] }));
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LemonSqueezyClient — token loading', () => {
  it('throws a clear error when the token file is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await expect(LS.getMe()).rejects.toThrow(/token 不存在/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('strips the trailing newline from the token and sends Bearer', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('mytoken\n');
    await LS.getMe();
    const init = mockFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer mytoken');
    expect(init.headers.Accept).toBe('application/vnd.api+json');
  });
});

describe('LemonSqueezyClient — GET endpoints', () => {
  it('getMe → /users/me', async () => {
    await LS.getMe();
    expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/users/me`);
  });

  it('listStores → /stores', async () => {
    await LS.listStores();
    expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/stores`);
  });

  it('getStore(id) → /stores/:id', async () => {
    await LS.getStore(42);
    expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/stores/42`);
  });

  it('listProducts() → /products', async () => {
    await LS.listProducts();
    expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/products`);
  });

  it('listProducts({storeId}) → /stores/:id/products', async () => {
    await LS.listProducts({ storeId: 7 });
    expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/stores/7/products`);
  });

  it('listVariants() → /variants', async () => {
    await LS.listVariants();
    expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/variants`);
  });

  it('listVariants({productId}) → /products/:id/variants', async () => {
    await LS.listVariants({ productId: 9 });
    expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/products/9/variants`);
  });

  it('listOrders builds filter[store_id] and page[size]=50 by default', async () => {
    await LS.listOrders({ storeId: 3 });
    const sp = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(sp.get('filter[store_id]')).toBe('3');
    expect(sp.get('page[size]')).toBe('50');
  });

  it('listOrders honors custom limit and omits storeId when not provided', async () => {
    await LS.listOrders({ limit: 25 });
    const sp = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(sp.get('filter[store_id]')).toBeNull();
    expect(sp.get('page[size]')).toBe('25');
  });

  it('getOrder(id) → /orders/:id', async () => {
    await LS.getOrder('ord_abc');
    expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/orders/ord_abc`);
  });

  it('listWebhooks({storeId}) includes filter[store_id]', async () => {
    await LS.listWebhooks({ storeId: 11 });
    const sp = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(sp.get('filter[store_id]')).toBe('11');
  });

  it('listWebhooks() omits filter when no storeId', async () => {
    await LS.listWebhooks();
    const sp = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(sp.get('filter[store_id]')).toBeNull();
  });

  it('listLicenseKeys builds store filter and default page[size]=50', async () => {
    await LS.listLicenseKeys({ storeId: 5 });
    const sp = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(sp.get('filter[store_id]')).toBe('5');
    expect(sp.get('page[size]')).toBe('50');
  });

  it('listLicenseKeys honors custom limit', async () => {
    await LS.listLicenseKeys({ storeId: 5, limit: 10 });
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get('page[size]')).toBe('10');
  });
});

describe('LemonSqueezyClient — POST endpoints', () => {
  it('createWebhook sends JSON:API body with Content-Type and store relationship', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ data: { id: 'wh_1' } }));
    await LS.createWebhook({
      storeId: 1,
      url: 'https://example.com/hook',
      secret: 's',
      events: ['order_created'],
      testMode: true,
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_BASE}/webhooks`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/vnd.api+json');
    const body = JSON.parse(init.body);
    expect(body.data.type).toBe('webhooks');
    expect(body.data.attributes).toEqual({
      url: 'https://example.com/hook',
      events: ['order_created'],
      secret: 's',
      test_mode: true,
    });
    expect(body.data.relationships.store.data).toEqual({ type: 'stores', id: '1' });
  });

  it('createWebhook defaults events and testMode', async () => {
    await LS.createWebhook({ storeId: 1, url: 'https://x', secret: 's' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.attributes.events).toEqual([
      'order_created',
      'subscription_created',
      'subscription_payment_success',
    ]);
    expect(body.data.attributes.test_mode).toBe(false);
  });

  it('createCheckout sends store + variant relationships and checkout_data.custom', async () => {
    await LS.createCheckout({
      storeId: 4,
      variantId: 99,
      customData: { userId: 'u1' },
      productOptions: { redirect_url: 'https://r' },
      checkoutOptions: { embed: true },
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_BASE}/checkouts`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.data.type).toBe('checkouts');
    expect(body.data.attributes.custom_price).toBeNull();
    expect(body.data.attributes.product_options).toEqual({ redirect_url: 'https://r' });
    expect(body.data.attributes.checkout_options).toEqual({ embed: true });
    expect(body.data.attributes.checkout_data.custom).toEqual({ userId: 'u1' });
    expect(body.data.relationships.store.data).toEqual({ type: 'stores', id: '4' });
    expect(body.data.relationships.variant.data).toEqual({ type: 'variants', id: '99' });
  });
});

describe('LemonSqueezyClient — error propagation', () => {
  it('throws with status code and body preview on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(failResponse(401, 'unauthorized token'));
    await expect(LS.getMe()).rejects.toThrow(/LS API 401: unauthorized token/);
  });
});

describe('LemonSqueezyClient — deleteWebhook (L7 regression)', () => {
  it('returns {ok:true, deleted:id} on 2xx and uses DELETE with Bearer', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });
    const res = await LS.deleteWebhook('wh_99');
    expect(res).toEqual({ ok: true, deleted: 'wh_99' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_BASE}/webhooks/wh_99`);
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
  });

  it('returns {ok:false, deleted:null, status, error} on 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const res = await LS.deleteWebhook('wh_missing');
    expect(res).toEqual({
      ok: false,
      deleted: null,
      status: 404,
      error: 'delete webhook failed: HTTP 404',
    });
  });

  it('returns {ok:false, status:401} on auth failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const res = await LS.deleteWebhook('wh_x');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error).toMatch(/HTTP 401/);
  });
});

describe('LemonSqueezyClient — healthCheck', () => {
  it('returns ok:true with email and stores count on success', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ data: { attributes: { email: 'a@b.c' } } }));
    mockFetch.mockResolvedValueOnce(okJson({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
    const res = await LS.healthCheck();
    expect(res).toEqual({
      ok: true,
      user: 'a@b.c',
      storesCount: 3,
      tokenStored: true,
    });
  });

  it('returns ok:true with null/0 when response shape is empty', async () => {
    mockFetch.mockResolvedValueOnce(okJson({}));
    mockFetch.mockResolvedValueOnce(okJson({}));
    const res = await LS.healthCheck();
    expect(res.ok).toBe(true);
    expect(res.user).toBeNull();
    expect(res.storesCount).toBe(0);
  });

  it('returns ok:false, tokenStored:false when token file is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await LS.healthCheck();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/token 不存在/);
    expect(res.tokenStored).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns ok:false, tokenStored:true when the API call fails', async () => {
    mockFetch.mockResolvedValueOnce(failResponse(500, 'boom'));
    const res = await LS.healthCheck();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/LS API 500/);
    expect(res.tokenStored).toBe(true);
  });
});
