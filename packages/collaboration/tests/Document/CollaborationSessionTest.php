<?php

declare(strict_types=1);

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\HocuspocusCollaborationDriver;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Documents\Actions\Documents\CreateDocumentAction;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\Data\Collaboration\CollaborationGrant;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Documents\Presentation\DocumentPresenter;
use Vaulter\Drive\Data\Snapshots\Mapping\NodeSnapshotMapper;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Kernel;
use Vaulter\Modules\MissingExtensionException;
use Vaulter\ValueObjects\Access\ActorRef;

/**
 * Драйверный слой (ADR-0001): issueSession кодирует режим (rw/ro) из
 * writable, Hocuspocus подписывает JWT с правильными claim'ами/exp, а комната всегда
 * привязана к одному узлу и поколению. Это «сердце» выдачи токена — проверяем форму
 * дескриптора для Hocuspocus отдельно от HTTP.
 */
function roomOf(Node $node, int $epoch = 0): string
{
    return app(CollaborationOptions::class)->room((string) $node->drive_id, (string) $node->getKey(), $epoch);
}

function documentNode(): Node
{
    $drive = DocumentTestHelpers::drive();

    return app(CreateDocumentAction::class)->execute(DocumentTestHelpers::context($drive->model()), new CreateDocumentInput(
        storage: $drive->model(),
        name: 'Spec',
        content: DocumentTestHelpers::content('First draft'),
        parent: DriveTestHelpers::model($drive->root()),
    ));
}

it('mints a hocuspocus room JWT with the room/sub/mode/epoch/exp claims', function (): void {
    config()->set('vaulter-collaboration.hub.jwt_keys', ['k1' => 'shh-secret-at-least-32-bytes-long-for-hs256']);
    config()->set('vaulter-collaboration.hub.jwt_active_kid', 'k1');
    config()->set('vaulter-collaboration.hub.issuer', 'https://vaulter.test');
    config()->set('vaulter-collaboration.hub.url', 'ws://hub:1234');
    config()->set('vaulter-collaboration.hub.token_ttl', 240);

    $node = documentNode();
    $presentation = app(DocumentPresenter::class)->present(app(NodeSnapshotMapper::class)->map($node));
    expect($presentation->capabilities->editable)->toBeTrue()
        ->and($presentation->capabilities->collaborative)->toBeTrue();
    $before = time();
    $session = app(HocuspocusCollaborationDriver::class)->issueSession(sessionGrant($node, 3, true, 42));

    expect($session->protocol)->toBe('yjs')
        ->and($session->endpoint)->toBe('ws://hub:1234')
        ->and($session->mode)->toBe(CollaborationMode::Write)
        ->and($session->token)->toBeString()->not->toBe('');

    $claims = JWT::decode($session->token, new Key('shh-secret-at-least-32-bytes-long-for-hs256', 'HS256'));

    expect($claims->room)->toBe(roomOf($node, 3))
        ->and($claims->sub)->toBe('42')
        ->and($claims->document_id)->toBe((string) $node->getKey())
        ->and($claims->generation)->toBe(3)
        ->and($claims->scope)->toBe('write')
        ->and($claims->exp)->toBeGreaterThanOrEqual($before + 240)
        ->and($claims->exp)->toBeLessThanOrEqual(time() + 240);
});

it('encodes the ro mode into the hocuspocus JWT of a read-only session', function (): void {
    config()->set('vaulter-collaboration.hub.jwt_keys', ['k1' => 'shh-secret-at-least-32-bytes-long-for-hs256']);
    config()->set('vaulter-collaboration.hub.jwt_active_kid', 'k1');
    config()->set('vaulter-collaboration.hub.issuer', 'https://vaulter.test');

    $node = documentNode();
    $session = app(HocuspocusCollaborationDriver::class)->issueSession(sessionGrant($node, 0, false, 1));

    $claims = JWT::decode($session->token, new Key('shh-secret-at-least-32-bytes-long-for-hs256', 'HS256'));

    expect($session->mode)->toBe(CollaborationMode::Read)
        ->and($claims->scope)->toBe('read');
});

it('binds the hocuspocus room JWT to a single node', function (): void {
    config()->set('vaulter-collaboration.hub.jwt_keys', ['k1' => 'shh-secret-at-least-32-bytes-long-for-hs256']);
    config()->set('vaulter-collaboration.hub.jwt_active_kid', 'k1');
    config()->set('vaulter-collaboration.hub.issuer', 'https://vaulter.test');

    $nodeA = documentNode();
    $nodeB = documentNode();

    $sessionA = app(HocuspocusCollaborationDriver::class)->issueSession(sessionGrant($nodeA, 0, true, 1));
    $claimsA = JWT::decode($sessionA->token, new Key('shh-secret-at-least-32-bytes-long-for-hs256', 'HS256'));

    // The token for node A carries node A's room — never node B's.
    expect($claimsA->room)->toBe(roomOf($nodeA))
        ->and($claimsA->room)->not->toBe(roomOf($nodeB));
});

it('resolves the node-collaboration driver from config', function (): void {
    expect(app(Kernel::class)->extensions()->handler(CollaborationProtocolDriver::class, 'yjs'))->toBeInstanceOf(HocuspocusCollaborationDriver::class);
});

it('rejects an unknown node-collaboration driver with an operator-facing remedy', function (): void {
    expect(fn () => app(Kernel::class)->extensions()->handler(CollaborationProtocolDriver::class, 'unknown'))
        ->toThrow(MissingExtensionException::class);
});

function sessionGrant(Node $node, int $generation, bool $writable, int $actor): CollaborationGrant
{
    return new CollaborationGrant(
        nodeId: (string) $node->getKey(), driveId: (string) $node->drive_id, tenant: null,
        principal: new ActorRef('user', $actor),
        mode: $writable ? CollaborationMode::Write : CollaborationMode::Read,
        generation: $generation, schemaVersion: 1, documentType: 'vaulter/rich-text', protocol: 'yjs', stateFormat: 'yjs-update-v1', notAfter: time() + 300,
    );
}

it('bounds real JWT expiry by the grant ceiling and supports only exact Yjs state', function (): void {
    config()->set('vaulter-collaboration.hub.jwt_keys', ['k1' => 'shh-secret-at-least-32-bytes-long-for-hs256']);
    config()->set('vaulter-collaboration.hub.jwt_active_kid', 'k1');
    config()->set('vaulter-collaboration.hub.issuer', 'https://vaulter.test');
    $grant = sessionGrant(documentNode(), 3, true, 42);
    $grant = new CollaborationGrant(...array_replace(get_object_vars($grant), ['notAfter' => time() + 10]));
    $driver = app(HocuspocusCollaborationDriver::class);
    $session = $driver->issueSession($grant);
    $session->assertGrant($grant, $driver->version());
    $claims = JWT::decode($session->token, new Key('shh-secret-at-least-32-bytes-long-for-hs256', 'HS256'));
    expect($claims->exp)->toBe($grant->notAfter)->and($session->expiresAt)->toBe($claims->exp);
    foreach ([false, true] as $checkpoint) {
        foreach (CollaborationMode::cases() as $mode) {
            expect($driver->supportsState('vaulter/rich-text', 'yjs-update-v1', 1, $checkpoint, $mode))->toBeTrue()
                ->and($driver->supportsState('vaulter/rich-text', 'other', 1, $checkpoint, $mode))->toBeFalse()
                ->and($driver->supportsState('vaulter/rich-text', 'yjs-update-v1', 2, $checkpoint, $mode))->toBeFalse();
        }
    }
});
