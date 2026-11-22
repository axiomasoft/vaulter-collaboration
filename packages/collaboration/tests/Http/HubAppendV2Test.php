<?php

declare(strict_types=1);

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Symfony\Component\HttpFoundation\Response;
use Vaulter\Collaboration\CollaborationCall;
use Vaulter\Collaboration\CollaborationHub;
use Vaulter\Collaboration\Data\RoomRef;
use Vaulter\Collaboration\Exceptions\CollaborationUpdateTooLargeException;
use Vaulter\Collaboration\Http\Middleware\LimitHubAppend;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Revocation\PermissionVersion;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Drive\Models\Node;
use Vaulter\Testing\Fixtures\TestUser;
use Vaulter\ValueObjects\Access\ActorRef;

/*
 * Protocol 2 at the HTTP boundary: append answers the committed receipt and a retry the same one; load replays the
 * checkpoint and the committed tail (C, H]; every answer carries X-Vaulter-Collab-Protocol: 2 (a call without it is
 * refused: ProtocolVersionTest).
 */
beforeEach(function (): void {
    Hub::configure();
    $this->node = Hub::document();
    $this->token = Hub::token($this->node);
});

it('appends an update and answers the committed receipt with the protocol header', function (): void {
    $id = (string) Str::uuid();

    Hub::callV2('append', Hub::seedBody($this->node, "\x00\x01update", updateId: $id), $this->token)
        ->assertOk()
        ->assertHeader(HubProtocol::HEADER, '2')
        ->assertExactJson(['generation' => 0, 'update_id' => $id, 'seq' => 1, 'sha256' => hash('sha256', "\x00\x01update"), 'persisted' => true, 'permissions_stale' => false]);

    expect([Hub::aggregate($this->node)->pending_generation, Hub::aggregate($this->node)->pending_through_seq])->toBe([0, 1]);
});

it('answers a retried append with the same receipt', function (): void {
    $body = Hub::seedBody($this->node, 'update');

    $first = Hub::callV2('append', $body, $this->token)->assertOk()->json();
    $retry = Hub::callV2('append', $body, $this->token)->assertOk()->json();
    Hub::callV2('append', Hub::appendBody($this->node, 'other', $body['update_id']), $this->token)
        ->assertStatus(422)
        ->assertJsonPath('code', 'collaboration_update_mismatch')
        ->assertJsonPath('meta.context.reason', 'receipt');

    expect($retry)->toBe($first);
});

it('loads the checkpoint and the committed tail under protocol 2', function (): void {
    $ids = [(string) Str::uuid(), (string) Str::uuid()];
    Hub::callV2('append', Hub::seedBody($this->node, 'first', updateId: $ids[0]), $this->token)->assertOk();
    Hub::callV2('append', Hub::appendBody($this->node, 'second', $ids[1]), $this->token)->assertOk();

    Hub::callV2('load', ['room' => Hub::room($this->node)], $this->token)
        ->assertOk()
        ->assertHeader(HubProtocol::HEADER, '2')
        ->assertJsonPath('generation', 0)
        ->assertJsonPath('schema_version', 1)
        ->assertJsonPath('type', 'vaulter/rich-text')
        ->assertJsonPath('checkpoint', null)
        ->assertJsonPath('checkpoint_seq', 0)
        ->assertJsonPath('head_seq', 2)
        // No checkpoint yet: the JSON is reported with the tail (the hub seeds from it only while the log is empty).
        ->assertJsonPath('content.content.0.content.0.text', 'Draft')
        ->assertJsonPath('tail', [
            ['seq' => 1, 'update_id' => $ids[0], 'payload' => base64_encode('first')],
            ['seq' => 2, 'update_id' => $ids[1], 'payload' => base64_encode('second')],
        ]);
});

it('loads an empty log of a document nobody appended to, without creating its head', function (): void {
    Hub::callV2('load', ['room' => Hub::room($this->node)], $this->token)
        ->assertOk()
        ->assertJsonPath('head_seq', 0)
        ->assertJsonPath('tail', []);

    expect(DB::table(app(DatabaseOptions::class)->table('collaboration_heads'))->count())->toBe(0);
});

it('refuses a protocol 2 load of a document the subject cannot see with the 404 of a missing one', function (): void {
    $hidden = Hub::document(level: null);

    Hub::callV2('load', ['room' => Hub::room($hidden)], Hub::token($hidden))
        ->assertNotFound()
        ->assertJsonPath('code', 'node_not_found');
});

it('seeds a load from the content of the locked row, together with its state version', function (): void {
    $call = new CollaborationCall(
        room: Hub::room($this->node),
        ref: new RoomRef(driveId: (string) $this->node->drive_id, nodeId: (string) $this->node->getKey(), epoch: 0),
        principal: new ActorRef((new TestUser)->getMorphClass(), '1'),
        protocol: 'yjs',
        stateFormat: 'yjs-update-v1', mode: 'rw', schemaVersion: 1, tenant: null,
        permissionsVersion: new PermissionVersion(drive: 0, global: 0), jti: 'test-call', expiresAt: time() + 300,
    );
    $hub = app(CollaborationHub::class);
    $room = $hub->open($call, $call->room);

    // A REST PUT commits between open() and the locked read of the log.
    $opened = Hub::aggregate($this->node)->content;
    $version = Hub::aggregate($this->node)->state_version + 1;
    DB::table(app(DatabaseOptions::class)->table('documents'))
        ->where('node_id', $this->node->getKey())
        ->update(['content' => json_encode(Hub::tiptap('Changed')), 'state_version' => $version]);

    $loaded = $hub->loadLog($room, $call);

    expect($opened['content'][0]['content'][0]['text'])->toBe('Draft')
        ->and($loaded['state_version'])->toBe($version)
        ->and($loaded['content']['content'][0]['content'][0]['text'])->toBe('Changed');
});

it('answers a subject without View on a document whose generation moved with the 404 of a missing one', function (string $endpoint): void {
    $request = static fn (Node $node): array => $endpoint === 'append'
        ? Hub::appendBody($node, 'update', generation: 0)
        : ['room' => Hub::room($node, 0)];
    $problem = static function (TestResponse $response): array {
        $body = $response->assertNotFound()->json();

        return array_diff_key($body, ['request_id' => true, 'detail' => true, 'meta' => true]);
    };

    // The room token is of generation 0; the document then moved to generation 1.
    $hidden = Hub::document(level: null);
    $hiddenToken = Hub::token($hidden);
    Hub::aggregate($hidden)->forceFill(['collab_epoch' => 1])->save();

    $missing = Hub::document(level: null);
    $missingToken = Hub::token($missing);
    $missingBody = $request($missing);
    Node::query()->whereKey($missing->getKey())->delete();

    $answers = [
        $problem(Hub::callV2($endpoint, $request($hidden), $hiddenToken)),
        $problem(Hub::callV2($endpoint, $missingBody, $missingToken)),
    ];

    expect($answers[0])->toBe($answers[1])
        ->and($answers[0]['code'])->toBe('node_not_found');

    // A subject who sees the document still learns that the generation moved.
    $visible = Hub::document();
    $visibleToken = Hub::token($visible);
    Hub::aggregate($visible)->forceFill(['collab_epoch' => 1])->save();
    Hub::callV2($endpoint, $request($visible), $visibleToken)
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_epoch_mismatch');
})->with(['append', 'load']);

it('refuses an append without a usable Content-Length with 413 before the signature check', function (?string $length): void {
    config()->set('vaulter-collaboration.limits.request_bytes', 1000);
    $server = array_filter(['CONTENT_TYPE' => 'application/json', 'CONTENT_LENGTH' => $length], static fn (?string $value): bool => $value !== null);

    $this->call('POST', Docs::url('collaboration/hub/append'), [], [], [], $server, str_repeat('x', 5000))
        ->assertStatus(413)
        ->assertJsonPath('code', 'collaboration_update_too_large')
        ->assertJsonPath('meta.context.size_bytes', null)
        ->assertJsonPath('meta.context.max_bytes', 1000);
})->with(['missing' => [null], 'not a number' => ['5e3'], 'signed' => ['-1']]);

it('never reads the body to measure it', function (?string $length, bool $passes): void {
    config()->set('vaulter-collaboration.limits.request_bytes', 1000);
    $request = CountingBodyRequest::create('/append', 'POST', [], [], [], ['CONTENT_TYPE' => 'application/json'], str_repeat('x', 5000));
    $request->headers->remove('Content-Length');
    if ($length !== null) {
        $request->headers->set('Content-Length', $length);
    }

    $reached = false;
    $gate = static function () use ($request, &$reached): Response {
        return app(LimitHubAppend::class)->handle($request, static function () use (&$reached): Response {
            $reached = true;

            return new Response;
        });
    };

    $passes ? $gate() : expect($gate)->toThrow(CollaborationUpdateTooLargeException::class);
    expect($reached)->toBe($passes)
        ->and($request->reads)->toBe(0);
})->with([
    'missing' => [null, false],
    'not a number' => ['abc', false],
    'above the limit' => ['5000', false],
    'within the limit' => ['1000', true],
]);

it('sizes the append gate by the checkpoint limit for a declared seed, still without reading the body', function (?string $seed, ?string $parameter, bool $passes): void {
    config()->set('vaulter-collaboration.limits.request_bytes', 1000);
    // A base64 state of 3000 bytes and request_bytes on top: 5000.
    config()->set('vaulter-collaboration.max_state_bytes', 3000);
    $request = CountingBodyRequest::create('/append', 'POST', [], [], [], ['CONTENT_TYPE' => 'application/json'], str_repeat('x', 4000));
    $request->headers->set('Content-Length', '4000');
    if ($seed !== null) {
        $request->headers->set(LimitHubAppend::SEED_HEADER, $seed);
    }

    $reached = false;
    $gate = static function () use ($request, $parameter, &$reached): Response {
        return app(LimitHubAppend::class)->handle($request, static function () use (&$reached): Response {
            $reached = true;

            return new Response;
        }, $parameter);
    };

    $passes ? $gate() : expect($gate)->toThrow(CollaborationUpdateTooLargeException::class);
    expect($reached)->toBe($passes)
        ->and($request->reads)->toBe(0);
})->with([
    'a declared seed' => ['1', LimitHubAppend::APPEND, true],
    'no seed header' => [null, LimitHubAppend::APPEND, false],
    'another header value' => ['true', LimitHubAppend::APPEND, false],
    'a route without seeds' => ['1', null, false],
]);

/** A request that counts the reads of its body. */
final class CountingBodyRequest extends Request
{
    public int $reads = 0;

    public function getContent(bool $asResource = false)
    {
        $this->reads++;

        return parent::getContent($asResource);
    }
}
