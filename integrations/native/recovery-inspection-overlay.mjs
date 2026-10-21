function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error('RECOVERY_INSPECTION_ANCHOR_CHANGED:' + label);
  return source.replace(before, after);
}

/** Transform only the already composed original host. No source file is evaluated here. */
export function applyRecoveryInspectionOverlay(files) {
  const http = files.get('appointment-boot-http.ts');
  const index = files.get('index.ts');
  if (typeof http !== 'string' || typeof index !== 'string')
    throw new Error('RECOVERY_INSPECTION_HOST_MISSING');
  let route = http.replaceAll('\r\n', '\n');
  route = replaceOnce(route,
    "import type { TrustedRequestIdentity } from './appointment-current-identity.js';",
    "import type { TrustedRequestIdentity } from './appointment-current-identity.js';\nimport { buildRecoveryInspection, type RecoveryObservation } from './recovery-inspection.js';",
    'http-import');
  route = replaceOnce(route,
    '  readonly readInventory: () => BootReviewSnapshot;',
    '  readonly readInventory: () => BootReviewSnapshot;\n  /** Optional current-process numeric projection; absent or invalid means inspect 503. */\n  readonly readRecoveryObservation?: () => RecoveryObservation;',
    'http-options');
  route = replaceOnce(route,
    "    if (operation !== 'review' && operation !== 'restore')",
    "    if (operation !== 'review' && operation !== 'restore' && operation !== 'inspect')",
    'http-operation');
  route = replaceOnce(route,
    "      (operation === 'review' && Object.keys(parsed).length)",
    "      ((operation === 'review' || operation === 'inspect') && Object.keys(parsed).length)",
    'http-empty-body');
  route = replaceOnce(route,
    "      if (operation === 'review') {\n        const stamp = deps.gate.beginReview();",
    "      if (operation === 'inspect') {\n        // Reuse the current-admin and all-resource ACL snapshot without claiming a review.\n        const current = snapshot(who);\n        if (typeof deps.readRecoveryObservation !== 'function' ||\n            Object.prototype.toString.call(deps.readRecoveryObservation) === '[object AsyncFunction]')\n          return c.json({ error: 'inspection_unavailable' }, 503);\n        return c.json(buildRecoveryInspection(current, deps.readRecoveryObservation(), deps.gate.phase()));\n      }\n      if (operation === 'review') {\n        const stamp = deps.gate.beginReview();",
    'http-inspect');
  let main = index.replaceAll('\r\n', '\n');
  main = replaceOnce(main,
    '      readInventory: () => ({ inventory: scanAppointmentBootInventory(), resourceJids: Object.keys(getAllRegisteredGroups()).sort() }),',
    `      readInventory: () => ({ inventory: scanAppointmentBootInventory(), resourceJids: Object.keys(getAllRegisteredGroups()).sort() }),
      readRecoveryObservation: () => {
        // GroupQueue waitingCount counts waiting groups. No group or account identity leaves this closure.
        const status = queue.getStatus();
        const accounts = listEnabledChannelAccounts();
        let connectedAccounts = 0;
        for (const account of accounts) {
          if (imManager.isChannelAccountConnected(account.owner_user_id, account.provider, account.id))
            connectedAccounts++;
        }
        return {
          activeCount: status.activeCount,
          activeContainerCount: status.activeContainerCount,
          activeHostProcessCount: status.activeHostProcessCount,
          waitingCount: status.waitingCount,
          enabledAccounts: accounts.length,
          connectedAccounts,
        };
      },`,
    'index-observation');
  const result = new Map(files);
  result.set('appointment-boot-http.ts', route);
  result.set('index.ts', main);
  return result;
}
