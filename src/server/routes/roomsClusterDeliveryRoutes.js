import { requireOwnerToken } from '../auth/owner-token.js';
import {
  buildClusterDeliveryArchive,
  buildClusterEvidenceLink,
  buildClusterPreflight,
  clusterDeliveryArtifact,
  downloadFilename,
  readClusterDeliveryArchiveArtifact,
  rebuildClusterDeliveryAfterEvidenceLink,
  runClusterAdapterLiveChecks,
} from '../services/rooms-core.js';

export function registerRoomsClusterDeliveryRoutes(app, {
  roomStore,
  roomAdapterPool,
  agentRunStore,
  activityLog,
  emitRoomEvent,
} = {}) {
  app.get('/api/rooms/:id/cluster-delivery-package', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    if (!r.clusterDeliveryPackage) return res.status(404).json({ error: 'cluster delivery package not found' });
    res.json({
      ok: true,
      package: r.clusterDeliveryPackage,
      manifestFingerprint: r.clusterDeliveryManifest?.fingerprint || r.clusterDeliveryPackage.manifestFingerprint || '',
    });
  });

  app.get('/api/rooms/:id/cluster-delivery-package/:artifactKind/download', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const result = clusterDeliveryArtifact(r, req.params.artifactKind);
    if (!result) return res.status(404).json({ error: 'cluster delivery artifact not found' });
    res.setHeader?.('Content-Type', result.contentType);
    res.setHeader?.('Content-Disposition', `attachment; filename="${downloadFilename(result.artifact.filename)}"`);
    res.setHeader?.('X-Xike-Cluster-Delivery-Artifact', result.artifact.kind || '');
    return res.send ? res.send(result.body) : res.json({ ok: true, content: result.body });
  });

  app.get('/api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    try {
      const result = readClusterDeliveryArchiveArtifact(r, {
        archiveId: req.params.archiveId,
        artifactKind: req.params.artifactKind,
      });
      res.setHeader?.('Content-Type', result.contentType);
      res.setHeader?.('Content-Disposition', `attachment; filename="${downloadFilename(result.artifact.filename || result.artifact.kind)}"`);
      res.setHeader?.('X-Xike-Cluster-Delivery-Archive', result.archive.id || '');
      res.setHeader?.('X-Xike-Cluster-Delivery-Artifact', result.artifact.kind || '');
      res.setHeader?.('X-Xike-Artifact-SHA256', result.artifact.sha256 || '');
      return res.send ? res.send(result.content) : res.json({ ok: true, artifact: result.artifact, content: result.content });
    } catch (e) {
      const message = e.message || String(e);
      const status = /not found/.test(message) ? 404
        : /digest mismatch|escapes|not allowed|invalid|not a file/.test(message) ? 422
          : 400;
      return res.status(status).json({ ok: false, error: message });
    }
  });

  app.get('/api/rooms/:id/cluster-preflight', requireOwnerToken, async (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const preflight = buildClusterPreflight(r, {
      topic: req.query?.topic || '',
      roomAdapterPool,
    });
    if (preflight.status === 'blocked') {
      return res.status(409).json({ ok: false, preflight });
    }
    const wantsLiveCheck = ['1', 'true', 'yes', 'on'].includes(String(req.query?.live || '').toLowerCase());
    if (wantsLiveCheck) {
      const liveCheck = await runClusterAdapterLiveChecks(r, {
        topic: req.query?.topic || '',
        roomAdapterPool,
        timeoutMs: req.query?.timeoutMs,
      });
      return res.status(liveCheck.status === 'blocked' ? 409 : 200).json({
        ok: liveCheck.status !== 'blocked',
        preflight,
        liveCheck,
      });
    }
    return res.status(200).json({ ok: true, preflight });
  });

  app.post('/api/rooms/:id/cluster-evidence-links', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    try {
      const link = buildClusterEvidenceLink(r, req.body || {}, { agentRunStore });
      const existingLinks = Array.isArray(r.clusterEvidenceLinks) ? r.clusterEvidenceLinks : [];
      const existingLink = existingLinks.find((item) => item?.verified === true && item?.stageId === link.stageId && item?.agentRunId === link.agentRunId);
      if (existingLink) {
        const deliveryPatch = rebuildClusterDeliveryAfterEvidenceLink(r);
        const updated = Object.keys(deliveryPatch).length
          ? roomStore.update(req.params.id, { clusterEvidenceLinks: existingLinks, ...deliveryPatch })
          : r;
        return res.status(200).json({ ok: true, duplicate: true, link: existingLink, room: updated });
      }
      const links = [
        ...existingLinks,
        link,
      ].slice(-100);
      const linkedRoom = roomStore.update(req.params.id, { clusterEvidenceLinks: links });
      const deliveryPatch = rebuildClusterDeliveryAfterEvidenceLink(linkedRoom || { ...r, clusterEvidenceLinks: links });
      const updated = Object.keys(deliveryPatch).length
        ? roomStore.update(req.params.id, { clusterEvidenceLinks: links, ...deliveryPatch })
        : linkedRoom;
      const previousDeliveryPassed = r.clusterDeliveryManifest?.deliveryGate?.status === 'passed' && r.clusterDeliveryManifest?.readyForDelivery === true;
      const currentDeliveryPassed = updated?.clusterDeliveryManifest?.deliveryGate?.status === 'passed' && updated?.clusterDeliveryManifest?.readyForDelivery === true;
      activityLog?.recordSafe?.({
        action: 'cluster.evidence.linked',
        actorType: 'user',
        actorId: req.body?.requestedBy || 'owner',
        roomId: r.id || req.params.id,
        taskId: link.stageId,
        entityType: 'cluster_evidence_link',
        entityId: link.id,
        status: 'verified',
        details: {
          stageId: link.stageId,
          stageLabel: link.stageLabel,
          agentRunId: link.agentRunId,
          toolResultCount: link.toolResultCount,
          archiveCount: link.archiveCount,
          artifactCount: link.artifactCount,
          evidenceCount: link.evidenceCount,
        },
      });
      if (!previousDeliveryPassed && currentDeliveryPassed) {
        activityLog?.recordSafe?.({
          action: 'cluster.delivery.ready',
          actorType: 'system',
          actorId: 'cluster-delivery-gate',
          roomId: r.id || req.params.id,
          taskId: link.stageId,
          entityType: 'cluster_delivery_manifest',
          entityId: updated.clusterDeliveryManifest?.fingerprint || r.id || req.params.id,
          status: 'ready',
          details: {
            trigger: 'cluster_evidence_linked',
            stageId: link.stageId,
            stageLabel: link.stageLabel,
            agentRunId: link.agentRunId,
            deliveryGateStatus: updated.clusterDeliveryManifest?.deliveryGate?.status || '',
            readyForDelivery: updated.clusterDeliveryManifest?.readyForDelivery === true,
            manifestFingerprint: updated.clusterDeliveryManifest?.fingerprint || '',
            packageStatus: updated.clusterDeliveryPackage?.status || '',
            evidenceIntegrity: updated.clusterDeliveryManifest?.evidenceIntegrity || null,
          },
        });
        emitRoomEvent(r.id || req.params.id, {
          type: 'cluster_delivery_ready',
          roomId: r.id || req.params.id,
          stageId: link.stageId,
          stageLabel: link.stageLabel,
          agentRunId: link.agentRunId,
          deliveryGateStatus: updated.clusterDeliveryManifest?.deliveryGate?.status || '',
          readyForDelivery: updated.clusterDeliveryManifest?.readyForDelivery === true,
          manifestFingerprint: updated.clusterDeliveryManifest?.fingerprint || '',
          packageStatus: updated.clusterDeliveryPackage?.status || '',
        });
      }
      res.status(201).json({ ok: true, link, room: updated });
    } catch (e) {
      const msg = e.message || String(e);
      res.status(/not found/.test(msg) ? 404 : 422).json({ ok: false, error: msg });
    }
  });

  app.post('/api/rooms/:id/cluster-delivery-package/archive', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    try {
      const archive = buildClusterDeliveryArchive(r, { requestedBy: req.body?.requestedBy || 'owner' });
      const archives = [
        ...(Array.isArray(r.clusterDeliveryArchives) ? r.clusterDeliveryArchives : []),
        archive,
      ].slice(-20);
      const updated = roomStore.update(req.params.id, {
        clusterDeliveryArchive: archive,
        clusterDeliveryArchives: archives,
      });
      activityLog?.recordSafe?.({
        action: 'cluster.delivery.archived',
        actorType: 'user',
        actorId: req.body?.requestedBy || 'owner',
        roomId: r.id || req.params.id,
        entityType: 'cluster_delivery_archive',
        entityId: archive.id,
        status: archive.readyForArchive ? 'ready' : 'blocked',
        details: {
          archiveId: archive.id,
          archiveDir: archive.archiveDir,
          artifactCount: archive.artifacts.length,
          artifacts: archive.artifacts.map((artifact) => ({
            kind: artifact.kind,
            path: artifact.path,
            sha256: artifact.sha256,
            size: artifact.size,
          })),
          manifestFingerprint: archive.manifestFingerprint,
          readyForArchive: archive.readyForArchive,
          deliveryStatus: archive.status,
        },
      });
      res.status(201).json({ ok: true, archive, room: updated });
    } catch (e) {
      res.status(/not found/.test(e.message || '') ? 404 : 400).json({ error: e.message || String(e) });
    }
  });
}
