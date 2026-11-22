<?php

declare(strict_types=1);

use Firebase\JWT\JWT;
use Illuminate\Support\Carbon;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\AssertionFailedError;
use Vaulter\Collaboration\CollaborationCall;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\HocuspocusCollaborationDriver;
use Vaulter\Collaboration\RoomTokens;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Documents\Data\Collaboration\CollaborationGrant;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Data\Collaboration\CollaborationSession;
use Vaulter\ValueObjects\Access\ActorRef;

function verifyGrantCredential(CollaborationGrant $grant, CollaborationSession $session): void
{
    $call = app(CollaborationCallResolver::class)->verifyToken($session->token);
    Assert::assertInstanceOf(CollaborationCall::class, $call);
    Assert::assertSame($grant->principal->type, $call->principal->type);
    Assert::assertSame((string) $grant->principal->id, (string) $call->principal->id);
    Assert::assertSame($grant->nodeId, $call->ref->nodeId);
    Assert::assertSame($grant->driveId, $call->ref->driveId);
    Assert::assertSame($grant->tenant, $call->tenant);
    Assert::assertSame($grant->generation, $call->ref->epoch);
    Assert::assertSame($grant->schemaVersion, $call->schemaVersion);
    Assert::assertSame($grant->protocol, $call->protocol);
    Assert::assertSame($grant->stateFormat, $call->stateFormat);
    Assert::assertSame($session->options['room'], $call->room);
    Assert::assertSame($grant->mode === CollaborationMode::Write, $call->mayStore());
    Assert::assertSame($session->expiresAt, $call->expiresAt);
    Assert::assertGreaterThan(Carbon::now()->getTimestamp(), $call->expiresAt);
    Assert::assertLessThanOrEqual($grant->notAfter, $call->expiresAt);
}

beforeEach(function (): void {
    Hub::configure();
    Carbon::setTestNow(Carbon::createFromTimestamp(1000));
    $this->grant = new CollaborationGrant('42', '7', '0', new ActorRef('staff', 42), CollaborationMode::Read, 3, 1, 'vaulter/rich-text', 'yjs', 'yjs-update-v1', 1300);
});
afterEach(fn () => Carbon::setTestNow());

it('roundtrips the actual issuer and production verifier within both TTL ceilings', function (int $ttl, int $expected): void {
    config()->set('vaulter-collaboration.hub.token_ttl', $ttl);
    $session = app(HocuspocusCollaborationDriver::class)->issueSession($this->grant);
    verifyGrantCredential($this->grant, $session);
    expect($session->expiresAt)->toBe($expected);
})->with([[120, 1120], [300, 1300]]);

it('refuses to mint an expired grant', function (): void {
    $grant = new CollaborationGrant(...array_replace(get_object_vars($this->grant), ['notAfter' => 1000]));
    expect(fn () => app(HocuspocusCollaborationDriver::class)->issueSession($grant))->toThrow(InvalidArgumentException::class);
});

it('makes the adapter kit fail when the DTO hides a credential escape', function (string $field, mixed $value): void {
    $grant = $this->grant;
    $arguments = ['principal' => $grant->principal, 'documentId' => $grant->nodeId, 'driveId' => $grant->driveId,
        'tenant' => $grant->tenant, 'generation' => $grant->generation, 'schemaVersion' => $grant->schemaVersion,
        'writable' => false, 'protocol' => $grant->protocol, 'stateFormat' => $grant->stateFormat, 'notAfter' => $grant->notAfter];
    // A genuinely signed lying adapter token, not a separately decoded fake credential.
    if ($field === 'notAfter') {
        $grant = new CollaborationGrant(...array_replace(get_object_vars($grant), ['notAfter' => 1120]));
    }
    $minted = app(RoomTokens::class)->mint(...array_replace($arguments, $field === 'protocol' ? [] : [$field => $value]));
    if ($field === 'protocol') {
        // The honest Yjs issuer refuses another protocol. Mutate and re-sign its
        // actual credential to exercise the verifier against a lying adapter.
        $claims = json_decode(base64_decode(strtr(explode('.', $minted['token'])[1], '-_', '+/')), true, flags: JSON_THROW_ON_ERROR);
        $claims['protocol'] = $value;
        $minted['token'] = JWT::encode($claims, Hub::JWT_SECRET, 'HS256', Hub::JWT_KID);
    }
    $honest = app(HocuspocusCollaborationDriver::class)->issueSession($grant);
    $lying = new CollaborationSession(...array_replace(get_object_vars($honest), ['token' => $minted['token']]));
    expect(fn () => verifyGrantCredential($grant, $lying))->toThrow(AssertionFailedError::class);
})->with([
    'read DTO write token' => ['writable', true],
    'same id other principal' => ['principal', new ActorRef('customer', 42)],
    'other tenant' => ['tenant', null],
    'other node and room' => ['documentId', '43'],
    'other drive and room' => ['driveId', '8'],
    'other generation' => ['generation', 4],
    'other schema' => ['schemaVersion', 2],
    'other format' => ['stateFormat', 'foreign'],
    'other protocol' => ['protocol', 'foreign'],
    'long expiry' => ['notAfter', 1300],
]);
