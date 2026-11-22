<?php

declare(strict_types=1);

use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Drive\Models\Node;

/*
 * Every hub route speaks collaboration protocol 2 only: a call without X-Vaulter-Collab-Protocol, or naming
 * another version, is refused with 409 collaboration_protocol_mismatch (never retried by the hub) before anything is
 * read or written, and every answer repeats the header. There is no protocol 1 path left: no full-state store, no
 * protocol 1 load.
 */
beforeEach(function (): void {
    Hub::configure();
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $this->node = Hub::document();
});

/**
 * One call per hub route, as the hub makes it: the room calls with the room token, the worker calls signed only.
 *
 * @return array{array<string, mixed>, string|null}
 */
function protocolCall(string $route, Node $node): array
{
    return match ($route) {
        'authenticate', 'load' => [['room' => Hub::room($node)], Hub::token($node)],
        'append' => [Hub::seedBody($node, 'update'), Hub::token($node)],
        'compaction/lease' => [['hub_id' => Compaction::HUB, 'max' => 5], null],
        'checkpoint' => [[
            'document' => (string) $node->getKey(), 'generation' => 0, 'lease_token' => 'none', 'covered_from' => 0, 'covered_through' => 1,
            'expected_checkpoint_version' => 1, 'state' => base64_encode('state'), 'content' => Hub::tiptap('x'),
        ], null],
        default => throw new LogicException('Unknown hub route '.$route),
    };
}

it('refuses a call without protocol 2 on every hub route, before anything is read or written', function (string $route, ?string $protocol): void {
    Compaction::append($this->node, 'pending');
    $before = [Compaction::seqs($this->node), Compaction::marker($this->node), Compaction::head($this->node)?->leaseToken];
    [$body, $token] = protocolCall($route, $this->node);

    Hub::callV2($route, $body, $token, protocol: $protocol)
        ->assertStatus(409)
        ->assertHeader('Content-Type', 'application/problem+json')
        ->assertJsonPath('code', 'collaboration_protocol_mismatch')
        ->assertJsonPath('retryable', 'never');

    expect([Compaction::seqs($this->node), Compaction::marker($this->node), Compaction::head($this->node)?->leaseToken])->toBe($before);
})->with(['authenticate', 'load', 'append', 'compaction/lease', 'checkpoint'])
    ->with(['no header' => [null], 'protocol 1' => ['1'], 'protocol 3' => ['3']]);

it('repeats the protocol header on every answer of a room call', function (string $route): void {
    [$body, $token] = protocolCall($route, $this->node);

    Hub::call($route, $body, $token)->assertOk()->assertHeader(HubProtocol::HEADER, '2');
})->with(['authenticate', 'load', 'append']);

it('repeats the protocol header on the worker\'s answers', function (): void {
    Compaction::append($this->node, 'pending');

    Hub::callV2('compaction/lease', ['hub_id' => Compaction::HUB, 'max' => 5], null)->assertOk()->assertHeader(HubProtocol::HEADER, '2');
});

it('names the protocol in the mismatch so the hub can tell a deployment fault', function (): void {
    Hub::callV2('load', ['room' => Hub::room($this->node)], Hub::token($this->node), protocol: '1')
        ->assertStatus(409)
        ->assertJsonPath('meta.context.expected', 2);
});
