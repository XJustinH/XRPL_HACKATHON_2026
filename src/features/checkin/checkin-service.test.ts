// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { CheckInService, parseQr } from './checkin-service';
import { FakeClock, FakeLedger, FakeOrganisers, FakeProofs, FakeTickets, InMemoryCheckInStore } from './testing/fakes';
import type { CheckInChallengeIssued } from '@/contracts/checkin';

const EVENT = '11111111-1111-4111-8111-111111111111';
const OTHER_EVENT = '22222222-2222-4222-8222-222222222222';
const TICKET = '33333333-3333-4333-8333-333333333333';
const NFT = '000800006B1E7A3F0000000000000000000000000000000000000001';
const ALICE = 'rAlice1111111111111111111111111111';
const BOB = 'rBob22222222222222222222222222222';
const ORGANISER = 'organiser-1';
const SECRET = 'test-secret-that-is-at-least-32-bytes-long';

function setup() {
  const clock = new FakeClock();
  const tickets = new FakeTickets();
  const organisers = new FakeOrganisers();
  const ledger = new FakeLedger();
  const store = new InMemoryCheckInStore();
  tickets.add({ ticketId: TICKET, eventId: EVENT, nftokenId: NFT });
  organisers.grant(ORGANISER, EVENT);
  ledger.owners.set(NFT, ALICE);
  const svc = new CheckInService(
    { tickets, organisers, ledger, proofs: new FakeProofs(), store, clock },
    { qrSecret: SECRET, challengeTtlMs: 60_000 },
  );
  return { svc, clock, tickets, organisers, ledger, store };
}

type Env = ReturnType<typeof setup>;

async function issue(env: Env, wallet = ALICE): Promise<CheckInChallengeIssued> {
  const res = await env.svc.issueChallenge({ ticketId: TICKET, walletAddress: wallet });
  if (!('challengeId' in res)) throw new Error(`issue failed: ${res.status}`);
  return res;
}

async function issueAndProve(env: Env) {
  const c = await issue(env);
  const proved = await env.svc.proveControl({ challengeId: c.challengeId, proof: FakeProofs.sign(ALICE, c.messageToSign) });
  expect(proved.status).toBe('PROVEN');
  return c;
}

const scan = (env: Env, qrPayload: string, gateEventId = EVENT, organiserId = ORGANISER) => ({
  qrPayload,
  gateEventId,
  organiserId,
});

describe('XRPL-044 challenge / QR', () => {
  let env: Env;
  beforeEach(() => (env = setup()));

  it('issues a short-lived, event-bound challenge whose QR holds no address or personal data', async () => {
    const c = await issue(env);
    expect(c.eventId).toBe(EVENT);
    expect(new Date(c.expiresAt).getTime() - env.clock.now().getTime()).toBe(60_000);
    expect(c.qrPayload).not.toContain(ALICE);
    expect(c.qrPayload).not.toContain(NFT);
    expect(parseQr(c.qrPayload)?.challengeId).toBe(c.challengeId);
    expect(c.messageToSign).toContain(c.challengeId);
    expect(c.messageToSign).toContain(EVENT);
  });

  it('refuses to issue for a wallet that does not hold the ticket', async () => {
    const res = await env.svc.issueChallenge({ ticketId: TICKET, walletAddress: BOB });
    expect(res).toMatchObject({ status: 'WRONG_OWNER' });
  });

  it('refuses a ticket that has not been minted yet', async () => {
    env.tickets.add({ ticketId: 'unminted', eventId: EVENT, nftokenId: null });
    const res = await env.svc.issueChallenge({ ticketId: 'unminted', walletAddress: ALICE });
    expect(res).toMatchObject({ status: 'UNKNOWN_TICKET' });
  });

  it('refuses unknown tickets', async () => {
    const res = await env.svc.issueChallenge({ ticketId: 'nope', walletAddress: ALICE });
    expect(res).toMatchObject({ status: 'UNKNOWN_TICKET' });
  });

  it('rejects an expired challenge at the gate', async () => {
    const c = await issueAndProve(env);
    env.clock.advance(60_000);
    expect(await env.svc.verifyScan(scan(env, c.qrPayload))).toMatchObject({ status: 'EXPIRED' });
  });

  it('rejects tampered and malformed QR payloads', async () => {
    const c = await issueAndProve(env);
    const [p, id, tag] = c.qrPayload.split('.') as [string, string, string];
    const flipped = tag[0] === 'A' ? 'B' + tag.slice(1) : 'A' + tag.slice(1);
    for (const bad of [`${p}.${id}.${flipped}`, 'garbage', `${p}.${id}`, `${p}.not-a-uuid.${tag}`, '']) {
      expect(await env.svc.verifyScan(scan(env, bad))).toMatchObject({ status: 'INVALID_QR' });
    }
  });

  it('a QR from another deployment secret is rejected', async () => {
    const c = await issueAndProve(env);
    const other = new CheckInService(
      { tickets: env.tickets, organisers: env.organisers, ledger: env.ledger, proofs: new FakeProofs(), store: env.store, clock: env.clock },
      { qrSecret: 'a-completely-different-secret-of-32+bytes' },
    );
    expect(await other.verifyScan(scan(env, c.qrPayload))).toMatchObject({ status: 'INVALID_QR' });
  });

  it('rejects a reused QR after admission', async () => {
    const c = await issueAndProve(env);
    expect(await env.svc.admit(scan(env, c.qrPayload))).toMatchObject({ status: 'ADMITTED' });
    expect(await env.svc.verifyScan(scan(env, c.qrPayload))).toMatchObject({ status: 'ALREADY_USED' });
    expect(await env.svc.admit(scan(env, c.qrPayload))).toMatchObject({ status: 'ALREADY_USED' });
  });
});

describe('XRPL-045 wallet-control proof', () => {
  let env: Env;
  beforeEach(() => (env = setup()));

  it('a screenshot of the QR alone cannot be verified (no proof yet)', async () => {
    const c = await issue(env);
    expect(await env.svc.verifyScan(scan(env, c.qrPayload))).toMatchObject({ status: 'PROOF_REQUIRED' });
    expect(await env.svc.admit(scan(env, c.qrPayload))).toMatchObject({ status: 'PROOF_REQUIRED' });
  });

  it('rejects proof signed by a different wallet', async () => {
    const c = await issue(env);
    const res = await env.svc.proveControl({ challengeId: c.challengeId, proof: FakeProofs.sign(BOB, c.messageToSign) });
    expect(res).toMatchObject({ status: 'INVALID_PROOF' });
  });

  it('rejects proof over a different message (not bound to this challenge)', async () => {
    const c1 = await issue(env);
    const c2 = await issue(env);
    const proofForC1 = FakeProofs.sign(ALICE, c1.messageToSign);
    expect(await env.svc.proveControl({ challengeId: c2.challengeId, proof: proofForC1 })).toMatchObject({
      status: 'INVALID_PROOF',
    });
  });

  it('rejects a replayed proof', async () => {
    const c = await issue(env);
    const proof = FakeProofs.sign(ALICE, c.messageToSign);
    expect(await env.svc.proveControl({ challengeId: c.challengeId, proof })).toMatchObject({ status: 'PROVEN' });
    expect(await env.svc.proveControl({ challengeId: c.challengeId, proof })).toMatchObject({ status: 'INVALID_PROOF' });
  });

  it('rejects proof after expiry', async () => {
    const c = await issue(env);
    env.clock.advance(61_000);
    const res = await env.svc.proveControl({ challengeId: c.challengeId, proof: FakeProofs.sign(ALICE, c.messageToSign) });
    expect(res).toMatchObject({ status: 'EXPIRED' });
  });

  it('rejects garbage proof', async () => {
    const c = await issue(env);
    expect(await env.svc.proveControl({ challengeId: c.challengeId, proof: 'x' })).toMatchObject({ status: 'INVALID_PROOF' });
  });
});

describe('XRPL-046 ledger validation at entry', () => {
  let env: Env;
  beforeEach(() => (env = setup()));

  it('verifies a proven, owned ticket for the right event', async () => {
    const c = await issueAndProve(env);
    expect(await env.svc.verifyScan(scan(env, c.qrPayload))).toMatchObject({
      status: 'VERIFIED',
      ticketId: TICKET,
      nftokenId: NFT,
      ownerAddress: ALICE,
    });
  });

  it('rejects at the wrong event gate', async () => {
    env.organisers.grant(ORGANISER, OTHER_EVENT);
    const c = await issueAndProve(env);
    expect(await env.svc.verifyScan(scan(env, c.qrPayload, OTHER_EVENT))).toMatchObject({ status: 'WRONG_EVENT' });
  });

  it('rejects a scanner who is not an organiser for the event', async () => {
    const c = await issueAndProve(env);
    expect(await env.svc.verifyScan(scan(env, c.qrPayload, EVENT, 'random-user'))).toMatchObject({ status: 'NOT_AUTHORISED' });
  });

  it('rejects a ticket transferred away after the proof', async () => {
    const c = await issueAndProve(env);
    env.ledger.owners.set(NFT, BOB);
    expect(await env.svc.verifyScan(scan(env, c.qrPayload))).toMatchObject({ status: 'WRONG_OWNER' });
    expect(await env.svc.admit(scan(env, c.qrPayload))).toMatchObject({ status: 'WRONG_OWNER' });
  });

  it('rejects an NFT no longer on the ledger (e.g. burned)', async () => {
    const c = await issueAndProve(env);
    env.ledger.owners.delete(NFT);
    expect(await env.svc.verifyScan(scan(env, c.qrPayload))).toMatchObject({ status: 'WRONG_OWNER' });
  });

  it('never admits when the ledger is unavailable', async () => {
    const c = await issueAndProve(env);
    env.ledger.down = true;
    expect(await env.svc.verifyScan(scan(env, c.qrPayload))).toMatchObject({ status: 'LEDGER_UNAVAILABLE' });
    expect(await env.svc.admit(scan(env, c.qrPayload))).toMatchObject({ status: 'LEDGER_UNAVAILABLE' });
    expect(env.store.records.size).toBe(0);
  });
});

describe('XRPL-047 atomic one-time check-in', () => {
  let env: Env;
  beforeEach(() => (env = setup()));

  it('admits once and records the check-in', async () => {
    const c = await issueAndProve(env);
    const res = await env.svc.admit(scan(env, c.qrPayload));
    expect(res).toMatchObject({ status: 'ADMITTED', ticketId: TICKET, eventId: EVENT });
    expect(env.store.records.size).toBe(1);
  });

  it('two simultaneous scans of the same QR admit exactly once', async () => {
    const c = await issueAndProve(env);
    const results = await Promise.all(Array.from({ length: 5 }, () => env.svc.admit(scan(env, c.qrPayload))));
    expect(results.filter((r) => r.status === 'ADMITTED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'ALREADY_USED')).toHaveLength(4);
  });

  it('two different challenges for the same ticket admit exactly once', async () => {
    const c1 = await issueAndProve(env);
    const c2 = await issueAndProve(env);
    const [r1, r2] = await Promise.all([env.svc.admit(scan(env, c1.qrPayload)), env.svc.admit(scan(env, c2.qrPayload))]);
    expect([r1.status, r2.status].sort()).toEqual(['ADMITTED', 'ALREADY_USED']);
  });

  it('cannot get a fresh challenge for an already-used ticket', async () => {
    const c = await issueAndProve(env);
    await env.svc.admit(scan(env, c.qrPayload));
    expect(await env.svc.issueChallenge({ ticketId: TICKET, walletAddress: ALICE })).toMatchObject({ status: 'ALREADY_USED' });
  });

  it('verifyScan is read-only', async () => {
    const c = await issueAndProve(env);
    await env.svc.verifyScan(scan(env, c.qrPayload));
    await env.svc.verifyScan(scan(env, c.qrPayload));
    expect(env.store.records.size).toBe(0);
    expect(await env.svc.admit(scan(env, c.qrPayload))).toMatchObject({ status: 'ADMITTED' });
  });
});

describe('configuration', () => {
  it('rejects a short QR secret', () => {
    const e = setup();
    expect(
      () =>
        new CheckInService(
          { tickets: e.tickets, organisers: e.organisers, ledger: e.ledger, proofs: new FakeProofs(), store: e.store },
          { qrSecret: 'short' },
        ),
    ).toThrow();
  });
});
