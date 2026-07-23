import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (req, res, next) => next(),
}));

vi.mock('../../src/server/services/rooms-core.js', () => ({
  buildClusterDeliveryArchive: vi.fn(),
  buildClusterEvidenceLink: vi.fn(),
  buildClusterPreflight: vi.fn(),
  clusterDeliveryArtifact: vi.fn(),
  downloadFilename: vi.fn((name) => name),
  readClusterDeliveryArchiveArtifact: vi.fn(),
  rebuildClusterDeliveryAfterEvidenceLink: vi.fn(),
  runClusterAdapterLiveChecks: vi.fn(),
}));

import { registerRoomsClusterDeliveryRoutes } from '../../src/server/routes/roomsClusterDeliveryRoutes.js';
import * as services from '../../src/server/services/rooms-core.js';

function createApp() {
  const routes = {};
  const app = {
    get: (path, ...handlers) => { routes[`GET ${path}`] = handlers; },
    post: (path, ...handlers) => { routes[`POST ${path}`] = handlers; },
  };
  return { app, routes };
}

function createReqRes({ params = {}, query = {}, body = {} } = {}) {
  const req = { params, query, body };
  const headers = {};
  const res = {
    statusCode: 200,
    headers,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    send(data) { this.body = data; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
  };
  return { req, res };
}

describe('registerRoomsClusterDeliveryRoutes', () => {
  let roomStore, roomAdapterPool, agentRunStore, activityLog, emitRoomEvent;
  let routes;

  beforeEach(() => {
    vi.clearAllMocks();
    roomStore = { get: vi.fn(), update: vi.fn() };
    roomAdapterPool = {};
    agentRunStore = {};
    activityLog = { recordSafe: vi.fn() };
    emitRoomEvent = vi.fn();
    const created = createApp();
    routes = created.routes;
    registerRoomsClusterDeliveryRoutes(created.app, {
      roomStore,
      roomAdapterPool,
      agentRunStore,
      activityLog,
      emitRoomEvent,
    });
  });

  it('registers all expected routes', () => {
    expect(routes['GET /api/rooms/:id/cluster-delivery-package']).toBeDefined();
    expect(routes['GET /api/rooms/:id/cluster-delivery-package/:artifactKind/download']).toBeDefined();
    expect(routes['GET /api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download']).toBeDefined();
    expect(routes['GET /api/rooms/:id/cluster-preflight']).toBeDefined();
    expect(routes['POST /api/rooms/:id/cluster-evidence-links']).toBeDefined();
  });

  describe('GET /api/rooms/:id/cluster-delivery-package', () => {
    it('returns 404 when room is not found', () => {
      roomStore.get.mockReturnValue(null);
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' } });
      handler(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('not found');
    });

    it('returns 404 when clusterDeliveryPackage is missing', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' } });
      handler(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('cluster delivery package not found');
    });

    it('returns package with manifest fingerprint from manifest', () => {
      roomStore.get.mockReturnValue({
        id: 'r1',
        clusterDeliveryPackage: { foo: 'bar', manifestFingerprint: 'from-pkg' },
        clusterDeliveryManifest: { fingerprint: 'from-manifest' },
      });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' } });
      handler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.package).toEqual({ foo: 'bar', manifestFingerprint: 'from-pkg' });
      expect(res.body.manifestFingerprint).toBe('from-manifest');
    });

    it('falls back to package.manifestFingerprint when manifest missing', () => {
      roomStore.get.mockReturnValue({
        id: 'r1',
        clusterDeliveryPackage: { foo: 'bar', manifestFingerprint: 'from-pkg' },
      });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' } });
      handler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.manifestFingerprint).toBe('from-pkg');
    });
  });

  describe('GET /api/rooms/:id/cluster-delivery-package/:artifactKind/download', () => {
    it('returns 404 when room not found', () => {
      roomStore.get.mockReturnValue(null);
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', artifactKind: 'manifest' } });
      handler(req, res);
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when artifact missing', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.clusterDeliveryArtifact.mockReturnValue(null);
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', artifactKind: 'manifest' } });
      handler(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('cluster delivery artifact not found');
    });

    it('sets headers and returns body on success', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.clusterDeliveryArtifact.mockReturnValue({
        contentType: 'application/json',
        body: '{"a":1}',
        artifact: { kind: 'manifest', filename: 'manifest.json' },
      });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', artifactKind: 'manifest' } });
      handler(req, res);
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.headers['Content-Disposition']).toContain('manifest.json');
      expect(res.headers['X-Xike-Cluster-Delivery-Artifact']).toBe('manifest');
      expect(res.body).toBe('{"a":1}');
    });

    it('returns json when res.send is not available', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.clusterDeliveryArtifact.mockReturnValue({
        contentType: 'application/json',
        body: '{"a":1}',
        artifact: { kind: 'manifest', filename: 'manifest.json' },
      });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', artifactKind: 'manifest' } });
      delete res.send;
      handler(req, res);
      expect(res.body.ok).toBe(true);
      expect(res.body.content).toBe('{"a":1}');
    });
  });

  describe('GET /api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download', () => {
    it('returns 404 when room not found', () => {
      roomStore.get.mockReturnValue(null);
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', archiveId: 'a1', artifactKind: 'k1' } });
      handler(req, res);
      expect(res.statusCode).toBe(404);
    });

    it('maps "not found" error to 404', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.readClusterDeliveryArchiveArtifact.mockImplementation(() => {
        throw new Error('archive not found');
      });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', archiveId: 'a1', artifactKind: 'k1' } });
      handler(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toMatch(/not found/);
    });

    it('maps "digest mismatch" to 422', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.readClusterDeliveryArchiveArtifact.mockImplementation(() => {
        throw new Error('digest mismatch detected');
      });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', archiveId: 'a1', artifactKind: 'k1' } });
      handler(req, res);
      expect(res.statusCode).toBe(422);
    });

    it('maps "invalid" to 422', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.readClusterDeliveryArchiveArtifact.mockImplementation(() => {
        throw new Error('invalid entry path');
      });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', archiveId: 'a1', artifactKind: 'k1' } });
      handler(req, res);
      expect(res.statusCode).toBe(422);
    });

    it('maps other errors to 400', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.readClusterDeliveryArchiveArtifact.mockImplementation(() => {
        throw new Error('something else went wrong');
      });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', archiveId: 'a1', artifactKind: 'k1' } });
      handler(req, res);
      expect(res.statusCode).toBe(400);
    });

    it('sets all headers and returns content on success', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.readClusterDeliveryArchiveArtifact.mockReturnValue({
        contentType: 'text/plain',
        content: 'hello',
        artifact: { kind: 'k1', filename: 'file.txt', sha256: 'deadbeef' },
        archive: { id: 'a1' },
      });
      const handler = routes['GET /api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download'][1];
      const { req, res } = createReqRes({ params: { id: 'r1', archiveId: 'a1', artifactKind: 'k1' } });
      handler(req, res);
      expect(res.headers['Content-Type']).toBe('text/plain');
      expect(res.headers['Content-Disposition']).toContain('file.txt');
      expect(res.headers['X-Xike-Cluster-Delivery-Archive']).toBe('a1');
      expect(res.headers['X-Xike-Cluster-Delivery-Artifact']).toBe('k1');
      expect(res.headers['X-Xike-Artifact-SHA256']).toBe('deadbeef');
      expect(res.body).toBe('hello');
    });
  });

  describe('GET /api/rooms/:id/cluster-preflight', () => {
    it('returns 404 when room not found', () => {
      roomStore.get.mockReturnValue(null);
      const handler = routes['GET /api/rooms/:id/cluster-preflight'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' } });
      handler(req, res);
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when preflight blocked', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.buildClusterPreflight.mockReturnValue({ status: 'blocked', reason: 'no adapter' });
      const handler = routes['GET /api/rooms/:id/cluster-preflight'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' } });
      handler(req, res);
      expect(res.statusCode).toBe(409);
      expect(res.body.ok).toBe(false);
    });

    it('returns 200 with preflight when no live query', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.buildClusterPreflight.mockReturnValue({ status: 'ok', details: 'x' });
      const handler = routes['GET /api/rooms/:id/cluster-preflight'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' } });
      handler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.preflight.status).toBe('ok');
    });

    it('runs live checks when live query is true', async () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.buildClusterPreflight.mockReturnValue({ status: 'ok' });
      services.runClusterAdapterLiveChecks.mockResolvedValue({ status: 'ok' });
      const handler = routes['GET /api/rooms/:id/cluster-preflight'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' }, query: { live: 'true' } });
      await handler(req, res);
      expect(services.runClusterAdapterLiveChecks).toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.liveCheck.status).toBe('ok');
    });

    it('returns 409 when live check blocked', async () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.buildClusterPreflight.mockReturnValue({ status: 'ok' });
      services.runClusterAdapterLiveChecks.mockResolvedValue({ status: 'blocked' });
      const handler = routes['GET /api/rooms/:id/cluster-preflight'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' }, query: { live: 'yes' } });
      await handler(req, res);
      expect(res.statusCode).toBe(409);
      expect(res.body.ok).toBe(false);
    });

    it('does not run live checks when live query missing', () => {
      roomStore.get.mockReturnValue({ id: 'r1' });
      services.buildClusterPreflight.mockReturnValue({ status: 'ok' });
      const handler = routes['GET /api/rooms/:id/cluster-preflight'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' }, query: {} });
      handler(req, res);
      expect(services.runClusterAdapterLiveChecks).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/rooms/:id/cluster-evidence-links', () => {
    it('returns 404 when room not found', () => {
      roomStore.get.mockReturnValue(null);
      const handler = routes['POST /api/rooms/:id/cluster-evidence-links'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' }, body: {} });
      handler(req, res);
      expect(res.statusCode).toBe(404);
    });

    it('appends new link and rebuilds delivery when deliveryPatch is non-empty', () => {
      const room = {
        id: 'r1',
        clusterEvidenceLinks: [],
        clusterDeliveryManifest: { deliveryGate: { status: 'pending' }, readyForDelivery: false },
      };
      const newLink = {
        id: 'l1',
        verified: true,
        stageId: 's1',
        agentRunId: 'a1',
        stageLabel: 'stage',
        toolResultCount: 2,
        archiveCount: 1,
        artifactCount: 3,
        evidenceCount: 4,
      };
      roomStore.get.mockReturnValue(room);
      services.buildClusterEvidenceLink.mockReturnValue(newLink);
      services.rebuildClusterDeliveryAfterEvidenceLink.mockReturnValue({ clusterDeliveryPackage: { status: 'ready' } });
      roomStore.update.mockReturnValue({ ...room, clusterDeliveryPackage: { status: 'ready' } });

      const handler = routes['POST /api/rooms/:id/cluster-evidence-links'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' }, body: { stageId: 's1' } });
      handler(req, res);

      expect(services.buildClusterEvidenceLink).toHaveBeenCalledWith(room, { stageId: 's1' }, { agentRunStore });
      expect(roomStore.update).toHaveBeenCalledTimes(2);
      expect(activityLog.recordSafe).toHaveBeenCalledWith(expect.objectContaining({ action: 'cluster.evidence.linked' }));
    });

    it('returns duplicate path when existing verified link matches', () => {
      const existingLink = { id: 'l1', verified: true, stageId: 's1', agentRunId: 'a1' };
      const room = {
        id: 'r1',
        clusterEvidenceLinks: [existingLink],
        clusterDeliveryManifest: { deliveryGate: { status: 'pending' }, readyForDelivery: false },
      };
      roomStore.get.mockReturnValue(room);
      services.buildClusterEvidenceLink.mockReturnValue({ id: 'l1', verified: true, stageId: 's1', agentRunId: 'a1' });
      services.rebuildClusterDeliveryAfterEvidenceLink.mockReturnValue({});

      const handler = routes['POST /api/rooms/:id/cluster-evidence-links'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' }, body: { stageId: 's1' } });
      handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.duplicate).toBe(true);
      expect(res.body.link).toEqual(existingLink);
    });

    it('logs cluster.delivery.ready when delivery gate transitions to passed', () => {
      const room = {
        id: 'r1',
        clusterEvidenceLinks: [],
        clusterDeliveryManifest: { deliveryGate: { status: 'pending' }, readyForDelivery: false, fingerprint: 'fp1' },
        clusterDeliveryPackage: { status: 'building' },
      };
      const updatedRoom = {
        ...room,
        clusterEvidenceLinks: [{ id: 'l1', verified: true, stageId: 's1', agentRunId: 'a1' }],
        clusterDeliveryManifest: { deliveryGate: { status: 'passed' }, readyForDelivery: true, fingerprint: 'fp1' },
        clusterDeliveryPackage: { status: 'ready' },
      };
      const newLink = {
        id: 'l1',
        verified: true,
        stageId: 's1',
        agentRunId: 'a1',
        stageLabel: 'stage',
        toolResultCount: 0,
        archiveCount: 0,
        artifactCount: 0,
        evidenceCount: 0,
      };
      roomStore.get.mockReturnValue(room);
      services.buildClusterEvidenceLink.mockReturnValue(newLink);
      services.rebuildClusterDeliveryAfterEvidenceLink.mockReturnValue({ clusterDeliveryPackage: { status: 'ready' } });
      roomStore.update
        .mockReturnValueOnce(updatedRoom)
        .mockReturnValueOnce(updatedRoom);

      const handler = routes['POST /api/rooms/:id/cluster-evidence-links'][1];
      const { req, res } = createReqRes({ params: { id: 'r1' }, body: { stageId: 's1' } });
      handler(req, res);

      expect(activityLog.recordSafe).toHaveBeenCalledWith(expect.objectContaining({ action: 'cluster.delivery.ready' }));
      expect(emitRoomEvent).toHaveBeenCalledWith('r1', expect.objectContaining({ type: 'cluster_delivery_ready' }));
    });
  });
});
