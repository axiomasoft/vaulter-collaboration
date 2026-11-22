<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Vaulter\Collaboration\Http\Middleware\LimitHubAppend;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Models\Node;

/*
 * Scenario 17: the append refuses what it cannot take before it allocates or writes — a body above
 * limits.request_bytes by its Content-Length (ahead of the signature check; a declared seed carries a whole state, and a
 * body that turns out no seed is held to request_bytes once read), a payload above limits.update_bytes by its
 * base64 length, a malformed envelope, another protocol version — and a subject who cannot see the document gets the
 * same 404 as a document that does not exist.
 */

function validRows(): int
{
    return DB::table(app(DatabaseOptions::class)->table('collaboration_updates'))->count()
        + DB::table(app(DatabaseOptions::class)->table('collaboration_receipts'))->count()
        + DB::table(app(DatabaseOptions::class)->table('collaboration_heads'))->count();
}

/**
 * An append that declares the seed of an empty log (X-Vaulter-Collab-Seed: 1), signed like every hub call.
 *
 * @param array<string, mixed> $body
 */
function seedCall(array $body, string $token): TestResponse
{
    $body['nonce'] = bin2hex(random_bytes(8));

    return test()->postJson(Docs::url('collaboration/hub/append'), $body, [
        ...Hub::headers($body, $token),
        HubProtocol::HEADER => '2',
        LimitHubAppend::SEED_HEADER => '1',
    ]);
}

/** @return array<string, mixed> a problem body without its per-request id */
function validProblem(TestResponse $response): array
{
    $body = $response->json();
    unset($body['request_id']);

    return $body;
}

beforeEach(function (): void {
    Hub::configure();
    $this->node = Hub::document();
});

it('refuses a body above limits.request_bytes by its Content-Length before the signature is checked', function (): void {
    config()->set('vaulter-collaboration.limits.request_bytes', 512);

    // No token and no signature: the size gate answers before anything reads the body.
    $this->call('POST', Docs::url('collaboration/hub/append'), [], [], [], ['CONTENT_TYPE' => 'application/json', 'CONTENT_LENGTH' => '4096'], str_repeat('x', 4096))
        ->assertStatus(413)
        ->assertJsonPath('code', 'collaboration_update_too_large')
        ->assertJsonPath('meta.context.max_bytes', 512);
    expect(validRows())->toBe(0);
});

it('refuses a payload above limits.update_bytes by its base64 length, and takes one at the limit', function (): void {
    config()->set('vaulter-collaboration.limits.update_bytes', 30);

    Hub::callV2('append', Hub::appendBody($this->node, str_repeat('a', 31)), Hub::token($this->node))
        ->assertStatus(413)
        ->assertJsonPath('code', 'collaboration_update_too_large');
    expect(validRows())->toBe(0);

    Hub::callV2('append', Hub::seedBody($this->node, 'valid-seed'), Hub::token($this->node))->assertOk();
    Hub::callV2('append', Hub::appendBody($this->node, str_repeat('a', 30)), Hub::token($this->node))
        ->assertOk()
        ->assertJsonPath('seq', 2);
});

it('bounds a seed by max_state_bytes, not limits.update_bytes: it carries the whole initial state', function (): void {
    config()->set('vaulter-collaboration.limits.update_bytes', 30);
    config()->set('vaulter-collaboration.max_state_bytes', 60);

    Hub::callV2('append', Hub::seedBody($this->node, str_repeat('s', 61)), Hub::token($this->node))
        ->assertStatus(413)
        ->assertJsonPath('code', 'collaboration_update_too_large');
    expect(validRows())->toBe(0);

    Hub::callV2('append', Hub::seedBody($this->node, str_repeat('s', 60)), Hub::token($this->node))
        ->assertOk()
        ->assertJsonPath('seq', 1);
    // Every later record is one update again.
    Hub::callV2('append', Hub::appendBody($this->node, str_repeat('a', 31)), Hub::token($this->node))
        ->assertStatus(413)
        ->assertJsonPath('code', 'collaboration_update_too_large');
});

it('lets a declared seed of a whole state through the request gate, and holds a body that is no seed to limits.request_bytes', function (): void {
    config()->set('vaulter-collaboration.limits.request_bytes', 1024);
    config()->set('vaulter-collaboration.max_state_bytes', 4096);
    $token = Hub::token($this->node);
    // 2048 bytes of state: its base64 alone is past request_bytes.
    $seed = Hub::seedBody($this->node, str_repeat('s', 2048));

    Hub::callV2('append', $seed, $token)
        ->assertStatus(413)
        ->assertJsonPath('code', 'collaboration_update_too_large')
        ->assertJsonPath('meta.context.max_bytes', 1024);
    expect(validRows())->toBe(0);

    seedCall($seed, $token)
        ->assertOk()
        ->assertJsonPath('seq', 1);

    // An update that declares a seed it is not passes the gate, and is refused once its body is read.
    seedCall(Hub::appendBody($this->node, str_repeat('a', 2048)), $token)
        ->assertStatus(413)
        ->assertJsonPath('code', 'collaboration_update_too_large')
        ->assertJsonPath('meta.context.max_bytes', 1024);
    expect(Compaction::seqs($this->node))->toBe([1]);
});

it('refuses a malformed envelope with 422 and writes nothing', function (string $field, mixed $value): void {
    $body = Hub::appendBody($this->node, 'update');
    $body[$field] = $value;

    Hub::callV2('append', $body, Hub::token($this->node))
        ->assertStatus(422)
        ->assertJsonPath('code', 'validation_failed');
    expect(validRows())->toBe(0);
})->with([
    'update_id not a uuid' => ['update_id', 'not-a-uuid'],
    'sha256 not hex' => ['sha256', 'xyz'],
    'payload not base64' => ['payload', '%%%not base64%%%'],
    'payload empty' => ['payload', ''],
    'negative generation' => ['generation', -1],
    'generation as a string' => ['generation', '0'],
    'unknown origin' => ['origin', 'redis'],
]);

it('refuses a claimed sha256 that is not the hash of the payload with 422 collaboration_update_mismatch', function (): void {
    Hub::callV2('append', Hub::appendBody($this->node, 'update', sha256: hash('sha256', 'other')), Hub::token($this->node))
        ->assertStatus(422)
        ->assertJsonPath('code', 'collaboration_update_mismatch')
        ->assertJsonPath('meta.context.reason', 'hash');
    expect(validRows())->toBe(0);
});

it('refuses a call without protocol 2 with 409 collaboration_protocol_mismatch', function (?string $protocol): void {
    Hub::callV2('append', Hub::appendBody($this->node, 'update'), Hub::token($this->node), protocol: $protocol)
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_protocol_mismatch')
        ->assertJsonPath('retryable', 'never');
    expect(validRows())->toBe(0);
})->with(['no header' => [null], 'protocol 1' => ['1'], 'protocol 3' => ['3']]);

it('refuses a read-only token and a subject who may only read with 403', function (): void {
    Hub::callV2('append', Hub::appendBody($this->node, 'update'), Hub::token($this->node, mode: 'ro'))->assertForbidden();

    $reader = Hub::document(level: RoleRegistry::READER, actorId: 2);
    Hub::callV2('append', Hub::appendBody($reader, 'update'), Hub::token($reader, actorId: 2))->assertForbidden();
    expect(validRows())->toBe(0);
});

it('answers a hidden document, another tenant and a missing document with the same 404', function (): void {
    $hidden = Hub::document(level: null);
    $tenant = Hub::document();
    $missing = Hub::document();
    $missingToken = Hub::token($missing);
    $missingBody = Hub::appendBody($missing, 'update');
    Node::query()->whereKey($missing->getKey())->delete();

    $answers = [
        validProblem(Hub::callV2('append', Hub::appendBody($hidden, 'update'), Hub::token($hidden))->assertNotFound()),
        validProblem(Hub::callV2('append', Hub::appendBody($tenant, 'update'), Hub::token($tenant, claims: ['tenant' => 'other-tenant']))->assertNotFound()),
        validProblem(Hub::callV2('append', $missingBody, $missingToken)->assertNotFound()),
    ];

    expect(array_column($answers, 'code'))->toBe(['node_not_found', 'node_not_found', 'node_not_found'])
        ->and(array_map(static fn (array $answer): array => array_diff_key($answer, ['detail' => true, 'meta' => true]), $answers))
        ->sequence(
            fn ($first) => $first->toBe(array_diff_key($answers[2], ['detail' => true, 'meta' => true])),
            fn ($second) => $second->toBe(array_diff_key($answers[2], ['detail' => true, 'meta' => true])),
            fn ($third) => $third->toBeArray(),
        )
        ->and(validRows())->toBe(0);
});

it('requires first seed CAS with no writes then accepts its retry and later ordinary append', function (): void {
    $token = Hub::token($this->node);
    $snapshot = static fn (): array => array_map(static fn (string $t) => DB::table($t)->get()->toJson(), ['v_documents', 'v_collaboration_heads', 'v_collaboration_updates', 'v_collaboration_receipts']);
    $before = $snapshot();
    Hub::callV2('append', Hub::appendBody($this->node, 'foreign-state'), $token)->assertStatus(409)->assertJsonPath('code', 'collaboration_seed_conflict');
    expect($snapshot())->toBe($before);
    $seed = Hub::seedBody($this->node, 'authoritative-seed');
    Hub::callV2('append', $seed, $token)->assertOk()->assertJsonPath('seq', 1);
    Hub::callV2('append', $seed, $token)->assertOk()->assertJsonPath('seq', 1);
    Hub::callV2('append', Hub::appendBody($this->node, 'later'), $token)->assertOk()->assertJsonPath('seq', 2);
    expect(Compaction::seqs($this->node))->toBe([1, 2])->and(Compaction::rows('collaboration_receipts'))->toBe(2);
});
