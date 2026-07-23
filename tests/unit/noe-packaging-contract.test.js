// @ts-check
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolvePackagingContract,
  listPrepackagedCandidates,
  evaluateUpdateDrain,
  evaluateUpdateIntegrity,
  evaluateIdentityBinding,
  evaluateS8StageStatus,
  evaluateGFirstGate,
  sha256DirectoryTree,
  CANONICAL_OUTPUT_DIR,
  DIRECTORY_TREE_HASH_KIND,
  MAX_HEALTH_WINDOW_SEC,
} from '../../src/runtime/NoePackagingContract.js';

describe('NoePackagingContract', () => {
  it('reads package.json and requires out-noe + hardenedRuntime + entitlements', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const c = resolvePackagingContract(pkg);
    expect(c.canonicalOutputDir).toBe('out-noe');
    expect(c.configuredOutputDir).toBe(CANONICAL_OUTPUT_DIR);
    expect(c.outputAligned).toBe(true);
    expect(c.hardenedRuntime).toBe(true);
    expect(c.entitlements).toBe('build/entitlements.mac.plist');
    expect(c.entitlementsInherit).toBe('build/entitlements.mac.inherit.plist');
    expect(existsSync(join(process.cwd(), 'build/entitlements.mac.plist'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'build/entitlements.mac.inherit.plist'))).toBe(true);
    expect(c.platforms.win).toBeTruthy();
    expect(c.platforms.linux).toBeTruthy();
    expect(c.winNsisConfigured).toBe(true);
    expect(c.linuxAppImageConfigured).toBe(true);
    expect(c.linuxDebConfigured).toBe(true);
    expect(pkg.build?.linux?.artifactName).toBe('${productName}-${version}-${arch}.${ext}');
    expect(c.writeUpdateInfo).toBe(true);
    expect(pkg.build?.mac?.identity).toBeNull();
    expect(pkg.homepage).toBe('https://github.com/BB20260410/neo-jarvis');
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'https://github.com/BB20260410/neo-jarvis.git',
    });
    expect(pkg.license).toBe('AGPL-3.0-only');
  });

  it('lists prepackaged candidates with out-noe first and external brand Neo 贾维斯', () => {
    const list = listPrepackagedCandidates('/tmp/root', 'arm64');
    expect(list[0]).toContain('out-noe');
    expect(list[0]).toContain('Neo 贾维斯.app');
    expect(list.some((p) => p.includes('Noe.app'))).toBe(true);
    expect(list.some((p) => p.includes('/out/'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.productName).toBe('Neo 贾维斯');
    expect(pkg.build?.appId).toBe('com.hxx.noe');
    expect(pkg.build?.productName).toBe('Neo 贾维斯');
  });

  it('keeps ordinary builds ad-hoc only and makes the formal path explicitly opt in to identity', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const signedScript = readFileSync(join(process.cwd(), 'scripts', 'dist-signed.mjs'), 'utf8');
    const localRcScript = readFileSync(join(process.cwd(), 'scripts', 'release-build.mjs'), 'utf8');
    const sbomScript = readFileSync(join(process.cwd(), 'scripts', 'noe-sbom.mjs'), 'utf8');
    const stampScript = readFileSync(
      join(process.cwd(), 'scripts', 'noe-stamp-rc-manifest.mjs'),
      'utf8',
    );
    const statusScript = readFileSync(
      join(process.cwd(), 'scripts', 'noe-packaging-status.mjs'),
      'utf8',
    );
    expect(pkg.build?.mac?.identity).toBeNull();
    expect(pkg.scripts?.['dist:signed']).toContain('ensure-node22.mjs');
    expect(pkg.scripts?.['build:app']).toContain('ensure-node22.mjs');
    expect(pkg.scripts?.package).toContain('ensure-node22.mjs');
    expect(signedScript).toContain('--config.mac.identity=${cfg.identity}');
    expect(signedScript).toContain('--config.mac.notarize=true');
    expect(signedScript).toContain('--config.extraMetadata.noeSourceDigest=${buildSourceDigest}');
    expect(signedScript).toContain("cmd: '/usr/bin/codesign'");
    expect(signedScript).toContain('Authority=Developer ID Application:');
    expect(signedScript).not.toContain("'--prepackaged'");
    expect(signedScript).toContain("[productName, 'Neo 贾维斯', 'Noe']");
    expect(localRcScript).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
    expect(localRcScript).toContain("const LOCAL_ADHOC_IDENTITY = '-'");
    expect(localRcScript).toContain('packaged Electron ABI probe');
    expect(localRcScript).toContain('--config.extraMetadata.noeSourceDigest=${BUILD_SOURCE_DIGEST}');
    expect(localRcScript).toContain('source changed during build');
    expect(pkg.scripts?.sbom).toContain('ensure-node22.mjs');
    expect(sbomScript).toContain("sbom.bomFormat !== 'CycloneDX'");
    expect(sbomScript).toContain("{ name: 'noe:sourceDigest', value: sourceIdentity.sourceDigest }");
    expect(sbomScript).toContain('packagedNodeModulesManifestSha256');
    expect(stampScript).toContain('sourceDigest changed before RC stamp');
    expect(stampScript).toContain('RC app version mismatch');
    expect(statusScript).toContain('const artifactPrefix = `${contract.productName}-${pkg.version}-`');
    expect(statusScript).toContain("Number(right?.mtimeMs || 0) - Number(left?.mtimeMs || 0)");
    expect(statusScript).toContain("linuxHostReceipt?.runner !== 'codex_linux_arm64_rc_v1'");
    expect(statusScript).toContain('linuxHostReceipt?.sourceDigestAfter !== sourceDigest');
    expect(statusScript).toContain("linuxVerificationBlockers.push(`linux_smoke_invalid:${key}`)");
    expect(statusScript).toContain('linuxAppImageRunVerified: linuxVerificationVerified');
    expect(statusScript).toContain('linuxDebInstallVerified: linuxVerificationVerified');
    expect(statusScript).toContain('const winArtifactPrefix = `${contract.productName}-Setup-${pkg.version}`');
    expect(statusScript).toContain("buildReceiptBlockers.push('embedded_build_id_mismatch')");
    expect(statusScript).toContain("sbomBindingBlockers.push('sbom_source_digest_mismatch')");
    expect(statusScript).toContain('updateVerification.nMinus1ToNVerified === true');
    expect(statusScript).toContain("caseReceipt?.runner !== 'noe_real_update_case_v1'");
    expect(statusScript).toContain("updateVerificationBlockers.push('update_case_receipts_not_unique')");
  });

  it('update drain requires checkpoint and blocks undrained running tasks', () => {
    const bad = evaluateUpdateDrain({ runningTaskCount: 2, drainComplete: false, checkpointWritten: false });
    expect(bad.allowed).toBe(false);
    expect(bad.blockers).toContain('running_tasks_not_drained');
    expect(bad.blockers).toContain('checkpoint_missing');
    expect(bad.blockers).toContain('health_window_missing');
    const good = evaluateUpdateDrain({
      runningTaskCount: 0,
      drainComplete: true,
      checkpointWritten: true,
      healthOkWithinSec: 30,
    });
    expect(good.allowed).toBe(true);
    expect(good.maxHealthWindowSec).toBe(120);
    const unconfirmed = evaluateUpdateDrain({
      runningTaskCount: 0,
      drainComplete: false,
      checkpointWritten: true,
      healthOkWithinSec: 30,
    });
    expect(unconfirmed.allowed).toBe(false);
    expect(unconfirmed.blockers).toContain('drain_not_confirmed');
    const unknown = evaluateUpdateDrain({
      drainComplete: true,
      checkpointWritten: true,
      healthOkWithinSec: 30,
    });
    expect(unknown.allowed).toBe(false);
    expect(unknown.blockers).toContain('running_task_count_missing');
    const healthFail = evaluateUpdateDrain({
      runningTaskCount: 0,
      drainComplete: true,
      checkpointWritten: true,
      healthOkWithinSec: 200,
    });
    expect(healthFail.allowed).toBe(false);
    expect(healthFail.blockers).toContain('health_window_exceeded_120s');
  });

  it('keeps Electron update installation fail-closed when task state is unavailable', () => {
    const electronMain = readFileSync(join(process.cwd(), 'electron-main.js'), 'utf8');
    expect(electronMain).toContain("blockers.push('running_task_state_unavailable')");
    expect(electronMain).toContain('autoUpdater.autoInstallOnAppQuit = false');
    expect(electronMain).not.toContain("buttons: ['退出时安装', '取消']");
    expect(electronMain).toContain("buttons: ['立即重启', '稍后']");
  });

  it('update integrity fails closed on bad hash / signature / interrupt / health', () => {
    const good = evaluateUpdateIntegrity({
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'a'.repeat(64),
      signatureValid: true,
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      interrupted: false,
      healthOkWithinSec: 40,
    });
    expect(good.accept).toBe(true);

    const badHash = evaluateUpdateIntegrity({
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'b'.repeat(64),
      signatureValid: true,
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      interrupted: false,
      healthOkWithinSec: 10,
      rollbackTriggered: true,
    });
    expect(badHash.accept).toBe(false);
    expect(badHash.blockers).toContain('bad_hash');
    expect(badHash.needsRollback).toBe(true);

    const badSigNoRollback = evaluateUpdateIntegrity({
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'a'.repeat(64),
      signatureValid: false,
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      interrupted: false,
      healthOkWithinSec: 10,
      rollbackTriggered: false,
    });
    expect(badSigNoRollback.accept).toBe(false);
    expect(badSigNoRollback.blockers).toContain('bad_signature');
    expect(badSigNoRollback.blockers).toContain('rollback_not_triggered');

    const overHealth = evaluateUpdateIntegrity({
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'a'.repeat(64),
      signatureValid: true,
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      interrupted: false,
      healthOkWithinSec: MAX_HEALTH_WINDOW_SEC + 1,
      rollbackTriggered: true,
    });
    expect(overHealth.accept).toBe(false);
    expect(overHealth.blockers).toContain('health_window_exceeded_120s');

    const missing = evaluateUpdateIntegrity({});
    expect(missing.accept).toBe(false);
    expect(missing.blockers).toContain('hash_missing');
    expect(missing.blockers).toContain('interrupted_state_missing');
  });

  it('identity binding requires matching version/commit/digest/hashes', () => {
    const ok = evaluateIdentityBinding({
      packageVersion: '2.1.0',
      appVersion: '2.1.0',
      commit: 'abc',
      expectedCommit: 'abc',
      sourceDigest: 'sha256:ff',
      expectedSourceDigest: 'sha256:ff',
      packageSha256: 'a'.repeat(64),
      manifestSha256: 'a'.repeat(64),
    });
    expect(ok.ok).toBe(true);

    const bad = evaluateIdentityBinding({
      packageVersion: '2.1.0',
      appVersion: '2.0.0',
      commit: 'a',
      expectedCommit: 'b',
      sourceDigest: 'x',
      expectedSourceDigest: 'y',
      packageSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
    });
    expect(bad.ok).toBe(false);
    expect(bad.blockers).toContain('version_mismatch');
    expect(bad.blockers).toContain('commit_mismatch');
    expect(bad.blockers).toContain('source_digest_mismatch');
    expect(bad.blockers).toContain('package_manifest_hash_mismatch');
  });

  it('S8 stage stays in_progress while internal open; external-only when internal done', () => {
    const c = resolvePackagingContract(
      JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')),
    );
    const mid = evaluateS8StageStatus(c, {
      sbomExists: false,
      rcMacAppExists: false,
      updateIntegritySuitePass: true,
      drainSuitePass: true,
      identityBindingOk: false,
      notarizationVerified: false,
      formalSignatureVerified: false,
    });
    expect(mid.status).toBe('in_progress');
    expect(mid.canContinueInternal).toBe(true);
    expect(mid.wholeStageBlockedExternal).toBe(false);
    expect(mid.internalOpen.length).toBeGreaterThan(0);
    expect(mid.externalOnly).toContain('formal_signing_identity_owner');
    expect(mid.externalOnly).toContain('apple_notarization_owner');

    const onlyExt = evaluateS8StageStatus(c, {
      sbomExists: true,
      rcMacAppExists: true,
      updateIntegritySuitePass: true,
      drainSuitePass: true,
      identityBindingOk: true,
      macDmgArtifactExists: true,
      macDmgArtifactSha256: '4'.repeat(64),
      macZipArtifactExists: true,
      macZipArtifactSha256: '5'.repeat(64),
      winNsisArtifactExists: true,
      winNsisArtifactSha256: '1'.repeat(64),
      linuxAppImageArtifactExists: true,
      linuxAppImageArtifactSha256: '2'.repeat(64),
      linuxDebArtifactExists: true,
      linuxDebArtifactSha256: '3'.repeat(64),
      winInstallVerified: true,
      linuxAppImageRunVerified: true,
      linuxDebInstallVerified: true,
      notarizationVerified: false,
      formalSignatureVerified: false,
    });
    expect(onlyExt.status).toBe('blocked_external');
    expect(onlyExt.internalOpen).toEqual([]);
    expect(onlyExt.wholeStageBlockedExternal).toBe(true);
  });

  it('does not treat configured Windows/Linux targets as built artifacts', () => {
    const c = resolvePackagingContract(
      JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')),
    );
    const configOnly = evaluateS8StageStatus(c, {
      sbomExists: true,
      rcMacAppExists: true,
      updateIntegritySuitePass: true,
      drainSuitePass: true,
      identityBindingOk: true,
      macDmgArtifactExists: true,
      macDmgArtifactSha256: '4'.repeat(64),
      macZipArtifactExists: true,
      macZipArtifactSha256: '5'.repeat(64),
      notarizationVerified: true,
      formalSignatureVerified: true,
    });
    expect(configOnly.status).toBe('in_progress');
    expect(configOnly.internalDone).toContain('win_nsis_target_configured');
    expect(configOnly.internalDone).toContain('linux_appimage_target_configured');
    expect(configOnly.internalOpen).toContain('win_nsis_binary_missing');
    expect(configOnly.internalOpen).toContain('linux_appimage_binary_missing');
    expect(configOnly.internalOpen).toContain('linux_deb_binary_missing');

    const crossHostBlocked = evaluateS8StageStatus(c, {
      sbomExists: true,
      rcMacAppExists: true,
      updateIntegritySuitePass: true,
      drainSuitePass: true,
      identityBindingOk: true,
      notarizationVerified: true,
      formalSignatureVerified: true,
      crossPlatformArtifactsExternal: true,
      crossPlatformRuntimeExternal: true,
      macDmgArtifactExists: true,
      macDmgArtifactSha256: '4'.repeat(64),
      macZipArtifactExists: true,
      macZipArtifactSha256: '5'.repeat(64),
    });
    expect(crossHostBlocked.status).toBe('blocked_external');
    expect(crossHostBlocked.externalOnly).toContain('win_nsis_binary_cross_host');
    expect(crossHostBlocked.externalOnly).toContain('linux_appimage_binary_cross_host');
    expect(crossHostBlocked.externalOnly).toContain('linux_deb_binary_cross_host');
    expect(crossHostBlocked.externalOnly).toContain('win_nsis_install_cross_host');
    expect(crossHostBlocked.externalOnly).toContain('linux_appimage_run_cross_host');
    expect(crossHostBlocked.externalOnly).toContain('linux_deb_install_cross_host');
  });

  it('G-FIRST fails closed for isolated technical personas without five real humans', () => {
    const isolatedOnly = evaluateGFirstGate({
      technicalPass: true,
      fiveRealHumans: false,
      humanUserCount: 0,
      humanPassedUserCount: 0,
      requiredPassUsers: 4,
    });
    expect(isolatedOnly.ok).toBe(false);
    expect(isolatedOnly.status).toBe('blocked_external');
    expect(isolatedOnly.blockers).toContain('five_real_humans_missing');
    expect(isolatedOnly.blockers).toContain('human_pass_threshold_not_met');

    const technicalFailure = evaluateGFirstGate({
      technicalPass: false,
      fiveRealHumans: false,
      humanUserCount: 0,
      humanPassedUserCount: 0,
    });
    expect(technicalFailure.ok).toBe(false);
    expect(technicalFailure.status).toBe('fail');
    expect(technicalFailure.blockers).toContain('technical_first_run_failed');

    const humanLab = evaluateGFirstGate({
      technicalPass: true,
      fiveRealHumans: true,
      humanUserCount: 5,
      humanPassedUserCount: 4,
      requiredPassUsers: 4,
    });
    expect(humanLab.ok).toBe(true);
    expect(humanLab.status).toBe('pass');
  });

  it('wires the isolated G-FIRST runner to tree hashing and the human gate', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'noe-g-first-clean-install.mjs'),
      'utf8',
    );
    expect(source).toContain('sha256DirectoryTree(appPath)');
    expect(source).toContain('cleanMachineInstall: false');
    expect(source).toContain('ok: humanGate.ok');
    expect(source).not.toContain('packageSha256: packageSha');
  });

  it('hashes the complete app directory tree deterministically', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-app-tree-'));
    try {
      mkdirSync(join(root, 'Contents', 'Resources'), { recursive: true });
      writeFileSync(join(root, 'Contents', 'Info.plist'), 'plist-v1');
      writeFileSync(join(root, 'Contents', 'Resources', 'payload.txt'), 'payload-v1');
      const first = sha256DirectoryTree(root);
      const second = sha256DirectoryTree(root);
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(DIRECTORY_TREE_HASH_KIND).toBe('directory_tree_v1');

      writeFileSync(join(root, 'Contents', 'Resources', 'payload.txt'), 'payload-v2');
      expect(sha256DirectoryTree(root)).not.toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
