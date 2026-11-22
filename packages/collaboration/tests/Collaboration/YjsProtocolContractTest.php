<?php

declare(strict_types=1);

use Firebase\JWT\JWT;
use Illuminate\Support\Carbon;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\AssertionFailedError;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\HocuspocusCollaborationDriver;
use Vaulter\Collaboration\Revocation\PermissionVersions;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\Data\Collaboration\CollaborationGrant;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Data\Collaboration\CollaborationSession;
use Vaulter\Documents\Testing\Contracts\CollaborationProtocolContractTests;
use Vaulter\ValueObjects\Access\ActorRef;

uses(CollaborationProtocolContractTests::class);

function verifiedYjsClaims(string $token): array
{
    $call = app(CollaborationCallResolver::class)->verifyToken($token);
    if ($call === null) {
        throw new InvalidArgumentException('Credential rejected.');
    }

    return ['principal' => $call->principal, 'tenant' => $call->tenant, 'node_id' => $call->ref->nodeId,
        'drive_id' => $call->ref->driveId, 'protocol' => $call->protocol, 'state_format' => $call->stateFormat,
        'generation' => $call->ref->epoch, 'schema_version' => $call->schemaVersion,
        'mode' => $call->mayStore() ? CollaborationMode::Write : CollaborationMode::Read, 'expires_at' => $call->expiresAt];
}

beforeEach(function (): void {
    Hub::configure();
    Carbon::setTestNow(Carbon::createFromTimestamp(time()));
    config()->set('vaulter-collaboration.hub.clock_skew', 0);
    $this->read = new CollaborationGrant('42', '7', '0', new ActorRef('staff', '42'), CollaborationMode::Read, 3, 1, 'vaulter/rich-text', 'yjs', 'yjs-update-v1', Carbon::now()->getTimestamp() + 300);
    $this->write = new CollaborationGrant(...array_replace(get_object_vars($this->read), ['mode' => CollaborationMode::Write]));
});
afterEach(fn () => Carbon::setTestNow());

it('keeps the reusable kit through the actual yjs issuer and verifier', function (int $ttl): void {
    config()->set('vaulter-collaboration.hub.token_ttl', $ttl);
    $driver = app(HocuspocusCollaborationDriver::class);
    $this->assertCollaborationProtocolContract($driver, $this->read, $this->write, verifiedYjsClaims(...));
    foreach ([$this->read, $this->write] as $grant) {
        $session = $driver->issueSession($grant);
        $call = app(CollaborationCallResolver::class)->verifyToken($session->token);
        expect($call->room)->toBe($session->options['room'])
            ->and($call->permissionsVersion->toClaim())->toBe(app(PermissionVersions::class)->current('7')->toClaim());
    }
})->with([120, 300]);

it('makes the reusable kit reject genuinely signed lying tokens', function (string $field, mixed $value, string $failure): void {
    $driver = new class(app(HocuspocusCollaborationDriver::class), $field, $value) implements CollaborationProtocolDriver
    {
        public ?CollaborationSession $last = null;

        public function __construct(private HocuspocusCollaborationDriver $real, private string $field, private mixed $value) {}

        public function protocol(): string
        {
            return $this->real->protocol();
        }

        public function version(): string
        {
            return $this->real->version();
        }

        public function supportsState(string $documentType, string $stateFormat, int $schemaVersion, bool $hasCheckpoint, CollaborationMode $mode): bool
        {
            return $this->real->supportsState($documentType, $stateFormat, $schemaVersion, $hasCheckpoint, $mode);
        }

        public function issueSession(CollaborationGrant $grant): CollaborationSession
        {
            $session = $this->real->issueSession($grant);
            $claims = json_decode(base64_decode(strtr(explode('.', $session->token)[1], '-_', '+/')), true, flags: JSON_THROW_ON_ERROR);
            if ($this->field === 'options.room') {
                return $this->last = new CollaborationSession(...array_replace(get_object_vars($session), ['options' => [...$session->options, 'room' => 'wrong-room']]));
            }
            $claims[$this->field] = $this->field === 'exp' && $this->value === 1301 ? $grant->notAfter + 1 : $this->value;
            $token = JWT::encode($claims, Hub::JWT_SECRET, 'HS256', Hub::JWT_KID);
            if ($this->field === 'tampered') {
                $token .= 'x';
            }

            return $this->last = new CollaborationSession(...array_replace(get_object_vars($session), ['token' => $token]));
        }
    };
    $verify = function (string $token) use ($driver): array {
        $claims = verifiedYjsClaims($token);
        $call = app(CollaborationCallResolver::class)->verifyToken($token);
        Assert::assertTrue($driver->last->options['room'] === $call->room, 'Room differs.');

        return $claims;
    };
    expect(fn () => $this->assertCollaborationProtocolContract($driver, $this->read, $this->write, $verify))->toThrow(AssertionFailedError::class, $failure);
})->with([
    'scope escalation' => ['scope', 'write', 'Verified credential mode'],
    'same id different type' => ['sub_type', 'customer', 'Verified credential principal'],
    'null tenant' => ['tenant', null, 'Verified credential tenant'],
    'format' => ['state_format', 'foreign', 'Verified credential state_format'],
    'schema' => ['schema_version', 2, 'Verified credential schema_version'],
    // The production verifier rejects a foreign wire protocol before lifting any claims.
    'protocol' => ['protocol', 'foreign', 'Credential verifier rejected'],
    'expiry bound' => ['exp', 1301, 'Verified credential expires_at'],
    'room option' => ['options.room', 'wrong-room', 'Credential verifier rejected'],
    'empty type' => ['sub_type', '', 'Credential verifier rejected'],
    'node room conflict' => ['document_id', '43', 'Credential verifier rejected'],
    'drive room conflict' => ['drive_id', '8', 'Credential verifier rejected'],
    'generation room conflict' => ['generation', 4, 'Credential verifier rejected'],
    'invalid room' => ['room', 'invalid', 'Credential verifier rejected'],
    'expired' => ['exp', 1000, 'Credential verifier rejected'],
    'tampered signature' => ['tampered', true, 'Credential verifier rejected'],
]);

it('requires a nonempty yjs checkpoint and preserves pending updates on rejection', function (mixed $checkpoint): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $node = Hub::document();
    Hub::call('append', Hub::seedBody($node, 'seed'), Hub::token($node))->assertOk();
    $lease = Compaction::leaseOf($node);
    $before = Hub::aggregate($node)->getAttributes();
    Hub::callV2('checkpoint', [
        'document' => $lease->nodeId, 'generation' => 0, 'lease_token' => $lease->token,
        'covered_from' => 0, 'covered_through' => 1, 'expected_checkpoint_version' => $lease->checkpointVersion,
        'state' => $checkpoint, 'content' => Hub::tiptap('Seed'),
    ], token: null)->assertStatus(422);
    expect(Hub::aggregate($node)->getAttributes())->toBe($before)
        ->and(Compaction::seqs($node))->toBe([1]);
})->with(['null checkpoint' => null, 'empty checkpoint' => '']);
