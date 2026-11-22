<?php

declare(strict_types=1);

use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Documents\Actions\Documents\CreateDocumentAction;
use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Documents\Presentation\DocumentPresenter;
use Vaulter\Drive\Data\Snapshots\Mapping\NodeSnapshotMapper;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Kernel;
use Vaulter\Testing\Fixtures\TestUser;

/*
 * Realtime collaboration is an opt-in module: `vaulter.modules.collaboration` is false by default, and the
 * module's hub routes are not mounted then (404). The session operation and its route belong to documents:
 * without a protocol driver an authorized reader is refused with 409 collaboration_unavailable, after authorization, and
 * a document the reader cannot see stays 404. This suite's base TestCase leaves the module off, so every test here runs
 * against the true default of a host that installed the package and did not switch it on.
 */
beforeEach(function (): void {
    $this->actingAs((new TestUser)->forceFill(['id' => 1]));
});

function collabGateDocumentNode(): Node
{
    $drive = DocumentTestHelpers::drive();

    return app(CreateDocumentAction::class)->execute(DocumentTestHelpers::context($drive->model()), new CreateDocumentInput(
        storage: $drive->model(),
        name: 'Spec',
        content: DocumentTestHelpers::content('Draft'),
        parent: DriveTestHelpers::model($drive->root()),
    ));
}

it('the collaboration module is off by default', function (): void {
    expect(config('vaulter.modules.collaboration'))->toBeNull()
        ->and(app(Kernel::class)->isActive('collaboration'))->toBeFalse();
});

it('the collaboration session route refuses an authorized reader with 409 when no protocol driver is active', function (): void {
    $node = collabGateDocumentNode();

    $this->postJson(Docs::url('documents/'.$node->getKey().'/collaboration/session'))
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_unavailable')
        ->assertJsonPath('meta.context.reason', 'protocol_unavailable');
});

it('the collaboration session route still answers 404 for a document the reader cannot see or that does not exist', function (): void {
    // This suite's permission driver lets every actor in, so the hidden document is a trashed one; the ACL-invisible
    // case is asserted with the module on (Http/CollaborationSessionV1Test). Neither reaches the 409 above.
    $node = collabGateDocumentNode();
    Vaulter::drive($node->storage()->firstOrFail())->asSystem('test fixture')->nodes()->trash((string) $node->getKey());

    $this->postJson(Docs::url('documents/'.$node->getKey().'/collaboration/session'))
        ->assertNotFound()
        ->assertJsonPath('code', 'node_not_found');
    $this->postJson(Docs::url('documents/987654321/collaboration/session'))
        ->assertNotFound()
        ->assertJsonPath('code', 'node_not_found');
});

it('the hub routes answer 404 when the module is off', function (string $endpoint): void {
    $node = collabGateDocumentNode();

    $this->postJson(Docs::url('collaboration/hub/'.$endpoint), [
        'room' => 'vaulter.documents.'.$node->getKey(),
        'state' => base64_encode('anything'),
    ])->assertNotFound();
})->with(['authenticate', 'load', 'append']);

it('base (non-realtime) content editing keeps working with the collaboration module off', function (): void {
    $node = collabGateDocumentNode();
    $presentation = app(DocumentPresenter::class)->present(app(NodeSnapshotMapper::class)->map($node));
    expect($presentation->capabilities->editable)->toBeTrue()
        ->and($presentation->capabilities->collaborative)->toBeFalse();
    $nodeId = (string) $node->getKey();

    $this->getJson(Docs::url('documents/'.$nodeId.'/content'))->assertOk();

    Docs::put($nodeId, Docs::doc('Autosaved'))->assertOk();
});
