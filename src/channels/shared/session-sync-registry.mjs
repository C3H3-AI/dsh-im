/**
 * Session-sync ownership registry: one bit per session, "this turn is being
 * mirrored as a process card by the owning bridge".
 *
 * The session-sync coordinator (plain-text fallback delivery) and the
 * process-card mirror (bridge #stepCards ladder) both observe the same
 * global session events. When the mirror owns a turn, the coordinator must
 * suppress its plain-text delivery for that turn, or the user receives the
 * same content twice (card + text). Both live in the same Host process, so a
 * module-level registry is the whole contract: the mirror claims a session
 * when it opens the mirror card and releases it when the turn ends.
 */
const claimed = new Map();

export function claimSessionSyncMirror(sessionId, turn = null) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  claimed.set(sessionId, { turn, claimedAt: Date.now() });
}

export function releaseSessionSyncMirror(sessionId) {
  claimed.delete(sessionId);
}

/** True when a live mirror claim covers this session (and turn, if given). */
export function isSessionSyncMirrored(sessionId, turn = null) {
  const claim = claimed.get(sessionId);
  if (!claim) return false;
  if (turn !== null && claim.turn !== null && claim.turn !== turn) return false;
  return true;
}
