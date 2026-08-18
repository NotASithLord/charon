export function authorityIsPresent(selfDid, roster, authorityDid) {
  return authorityDid === selfDid
    || Array.from(roster ?? []).some((peer) => peer?.did === authorityDid);
}

export const AUTHORITY_ARRIVAL_GRACE_MS = 3_000;

// Pure authority transition. Once a replacement wins, a late original host
// cannot take authority back: subsequent transitions begin at the promoted
// DID. Before an authority has ever appeared, peers wait a bounded grace so a
// slower room join does not cause an eager split.
export function advanceAuthority({
  selfDid, authorityDid, authoritySeen, candidates, connected, now, graceUntil,
}) {
  const live = new Set(Array.from(connected ?? [], String));
  live.add(String(selfDid));
  if (live.has(authorityDid)) {
    return { authorityDid, authoritySeen: true, graceUntil, promoted: false };
  }
  if (!authoritySeen && now < graceUntil) {
    return { authorityDid, authoritySeen: false, graceUntil, promoted: false };
  }
  const ordered = Array.from(candidates ?? [], String);
  const currentIndex = ordered.indexOf(authorityDid);
  const replacement = ordered[currentIndex + 1];
  if (!replacement) {
    return { authorityDid, authoritySeen, graceUntil, promoted: false };
  }
  const replacementSeen = live.has(replacement);
  return {
    authorityDid: replacement,
    authoritySeen: replacementSeen,
    graceUntil: replacementSeen ? graceUntil : now + AUTHORITY_ARRIVAL_GRACE_MS,
    promoted: true,
  };
}

// Merge an authenticated authority announcement after a partition. Terms
// advance exactly one frozen candidate rank at a time, so a higher term can be
// checked without trusting the sender's liveness claims. Only the announced
// authority may author the election packet.
export function mergeAuthorityElection({ authorityDid, authorityTerm, candidates, packet }) {
  const ordered = Array.from(candidates ?? [], String);
  if (!packet || packet.from !== packet.authority
    || !Number.isSafeInteger(packet.authorityTerm) || packet.authorityTerm < 1
    || !Number.isSafeInteger(authorityTerm) || authorityTerm < 1) {
    return { authorityDid, authorityTerm, accepted: false };
  }
  if (packet.authorityTerm === authorityTerm && packet.authority === authorityDid) {
    return { authorityDid, authorityTerm, accepted: true };
  }
  if (packet.authorityTerm <= authorityTerm) {
    return { authorityDid, authorityTerm, accepted: false };
  }
  const currentIndex = ordered.indexOf(authorityDid);
  const incomingIndex = ordered.indexOf(packet.authority);
  if (currentIndex < 0 || incomingIndex < 0
    || incomingIndex - currentIndex !== packet.authorityTerm - authorityTerm) {
    return { authorityDid, authorityTerm, accepted: false };
  }
  return { authorityDid: packet.authority, authorityTerm: packet.authorityTerm, accepted: true };
}

export function packetMatchesAuthority({ authorityDid, authorityTerm }, packet) {
  return packet?.authority === authorityDid && packet?.authorityTerm === authorityTerm;
}
