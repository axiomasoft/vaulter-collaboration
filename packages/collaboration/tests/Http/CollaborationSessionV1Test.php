<?php

declare(strict_types=1);

use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\AcmeKanbanV2Type;
use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Documents\Content\OpaqueContent;
use Vaulter\Documents\Types\MarkdownDocumentType;
use Vaulter\Documents\Types\RichTextDocumentType;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;

/** The session a client joins a document's room with: its mode follows the caller's rights and its token is never stored. */
beforeEach(function (): void {
    Hub::configure();
});

it('issues a read-write session to an editor and never lets it be cached', function (): void {
    $node = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
    $this->actingAs(AccessTestHelpers::user(1));

    $response = $this->postJson(Docs::url('documents/'.$node->getKey().'/collaboration/session'))
        ->assertCreated()
        ->assertJsonPath('data.mode', 'write')
        ->assertJsonPath('data.generation', 0)
        ->assertJsonPath('data.node_id', (string) $node->getKey())
        ->assertJsonPath('data.options.room', Hub::room($node))
        ->assertJsonStructure(['data' => ['protocol', 'version', 'options', 'node_id', 'generation', 'schema_version', 'mode', 'token', 'endpoint', 'expires_at']]);

    expect($response->headers->get('Cache-Control'))->toContain('no-store');
});

it('issues a read-only session to a reader and to an editor whose client speaks another schema', function (): void {
    $node = Hub::document(level: RoleRegistry::READER, actorId: 1);
    $this->actingAs(AccessTestHelpers::user(1));
    $this->postJson(Docs::url('documents/'.$node->getKey().'/collaboration/session'))->assertCreated()->assertJsonPath('data.mode', 'read');

    $editor = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
    $this->postJson(Docs::url('documents/'.$editor->getKey().'/collaboration/session'), ['schema_version' => 99])
        ->assertCreated()
        ->assertJsonPath('data.mode', 'read');
    $this->postJson(Docs::url('documents/'.$editor->getKey().'/collaboration/session'), ['schema_version' => 'x'])
        ->assertStatus(422)
        ->assertJsonValidationErrors('schema_version');
});

it('answers a caller without a grant 404', function (): void {
    $node = Hub::document(level: null);
    $this->actingAs(AccessTestHelpers::user(1));

    $this->postJson(Docs::url('documents/'.$node->getKey().'/collaboration/session'))->assertNotFound()->assertJsonPath('code', 'node_not_found');
});

it('is refused with collaboration_unavailable for a document type that cannot collaborate', function (): void {
    DocumentTestHelpers::installTypes([RichTextDocumentType::class, MarkdownDocumentType::class, AcmeKanbanV2Type::class]);
    $node = Hub::document(level: RoleRegistry::WRITER, actorId: 1, content: OpaqueContent::fromArray(['columns' => []]), type: 'acme/kanban', schemaVersion: 2);
    $this->actingAs(AccessTestHelpers::user(1));

    $this->postJson(Docs::url('documents/'.$node->getKey().'/collaboration/session'))
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_unavailable');
});
