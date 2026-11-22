<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Collaboration;

use Firebase\JWT\JWT;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Vaulter\Collaboration\CollaborationCall;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Revocation\PermissionVersions;
use Vaulter\Collaboration\Testing\Fixtures\FakeHostUserResolver;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Actions\Documents\CreateDocumentAction;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Documents\Models\Documents\Document;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Testing\Fixtures\TestUser;

/**
 * The hub's side of the protocol for tests: room tokens shaped exactly like
 * HocuspocusCollaborationDriver mints them, and requests signed the way
 * packages/collaboration/hub/src/backend.js signs them, with `X-Vaulter-Collab-Protocol: 2`. An unsigned or
 * token-less request never reaches the controller.
 */
final class HubTestHelpers
{
    public const string WEBHOOK_SECRET = 'webhook-shared-secret';

    public const string JWT_SECRET = 'jwt-signing-secret-that-is-at-least-32-bytes';

    public const string JWT_KID = 'k1';

    public const string ISSUER = 'https://vaulter.test';

    public static function configure(): void
    {
        config()->set('vaulter-drive.access.permission_driver', 'database');
        config()->set('vaulter-collaboration.hub.webhook_secret', self::WEBHOOK_SECRET);
        config()->set('vaulter-collaboration.hub.jwt_keys', [self::JWT_KID => self::JWT_SECRET]);
        config()->set('vaulter-collaboration.hub.jwt_active_kid', self::JWT_KID);
        config()->set('vaulter-collaboration.hub.issuer', self::ISSUER);
        config()->set('vaulter-collaboration.hub.timestamp_tolerance', 300);

        // The hub calls carry only the token subject; materialise it without a host
        // user provider.
        app()->bind(HostUserResolver::class, static fn (): FakeHostUserResolver => new FakeHostUserResolver(userType: (new TestUser)->getMorphClass()));
    }

    public static function document(
        ?string $level = RoleRegistry::WRITER,
        int $actorId = 1,
        ?DocumentContent $content = null,
        string $type = 'vaulter/rich-text',
        int $schemaVersion = 1,
    ): Node {
        $drive = DocumentTestHelpers::drive();

        $node = app(CreateDocumentAction::class)->execute(DocumentTestHelpers::context($drive->model()), new CreateDocumentInput(
            storage: $drive->model(),
            name: 'Spec',
            content: $content ?? DocumentTestHelpers::content('Draft'),
            parent: DriveTestHelpers::model($drive->root()),
            type: $type,
            schemaVersion: $schemaVersion,
        ));

        if ($level !== null) {
            AccessTestHelpers::grant($node, $level, subjectId: $actorId);
        }

        return $node;
    }

    /** A stored legacy type can disappear; the production create action refuses uninstalled types. */
    public static function documentOfRemovedType(int $actorId = 1): Node
    {
        $node = self::document(actorId: $actorId);
        app(VaulterDatabase::class)->write(fn () => self::aggregate($node)->forceFill(['type' => 'acme/gone'])->save());

        return $node;
    }

    public static function room(Node $node, ?int $epoch = null): string
    {
        return app(CollaborationOptions::class)->room($node->drive_id, $node->getKey(), $epoch ?? self::aggregate($node)->collab_epoch);
    }

    /**
     * A room token as RoomTokens mints it: `$mode` rw is the scope write, anything else read; the permission versions
     * are the drive's current ones.
     *
     * @param array<string, mixed> $claims overrides of the minted claims
     */
    public static function token(Node $node, string $mode = 'rw', int $actorId = 1, ?int $epoch = null, array $claims = []): string
    {
        $epoch ??= self::aggregate($node)->collab_epoch;

        return JWT::encode(
            payload: [
                'iss' => self::ISSUER,
                'aud' => CollaborationOptions::JWT_AUDIENCE,
                'sub' => (string) $actorId,
                'sub_type' => (new TestUser)->getMorphClass(),
                'protocol' => CollaborationOptions::JWT_PROTOCOL,
                'state_format' => 'yjs-update-v1',
                'document_id' => (string) $node->getKey(),
                'drive_id' => (string) $node->drive_id,
                'tenant' => null,
                'generation' => $epoch,
                'schema_version' => 1,
                'scope' => $mode === 'rw' ? CollaborationCall::SCOPE_WRITE : CollaborationCall::SCOPE_READ,
                'permissions_version' => app(PermissionVersions::class)->current((string) $node->drive_id)->toClaim(),
                'room' => self::room($node, $epoch),
                'iat' => now()->getTimestamp(),
                'nbf' => now()->getTimestamp(),
                'exp' => now()->getTimestamp() + 300,
                'jti' => (string) Str::uuid(),
                ...$claims,
            ],
            key: self::JWT_SECRET,
            alg: 'HS256',
            keyId: self::JWT_KID,
        );
    }

    /**
     * @param  array<string, mixed>  $body
     * @return array<string, string>
     */
    public static function headers(array $body, ?string $token, ?int $timestamp = null, ?string $secret = null): array
    {
        $timestamp ??= time();
        $signature = CollaborationCallResolver::signature(rawBody: (string) json_encode($body), secret: $secret ?? self::WEBHOOK_SECRET, timestamp: $timestamp);

        return array_filter([
            'Authorization' => $token === null ? null : 'Bearer '.$token,
            CollaborationCallResolver::TIMESTAMP_HEADER => (string) $timestamp,
            CollaborationCallResolver::SIGNATURE_HEADER => $signature,
        ], static fn (?string $value): bool => $value !== null);
    }

    /**
     * One hub call, protocol 2 like every hub route. Like the hub, every body carries a fresh nonce: two calls with the
     * same payload in the same second (authenticate, then load) must not share a signature, or the second one reads as
     * a replay.
     *
     * @param array<string, mixed> $body
     */
    public static function call(string $endpoint, array $body, ?string $token): TestResponse
    {
        return self::callV2($endpoint, $body, $token);
    }

    /**
     * One hub call with a chosen `X-Vaulter-Collab-Protocol` (`$protocol` null leaves the header out).
     *
     * @param array<string, mixed> $body
     */
    public static function callV2(string $endpoint, array $body, ?string $token, ?string $protocol = '2'): TestResponse
    {
        $body['nonce'] = bin2hex(random_bytes(8));
        $headers = self::headers($body, $token);
        if ($protocol !== null) {
            $headers[HubProtocol::HEADER] = $protocol;
        }

        return test()->postJson('api/vaulter/v1/collaboration/hub/'.$endpoint, $body, $headers);
    }

    /**
     * A protocol 2 append body as the hub sends it: the payload is the binary update, its hash is computed unless given.
     *
     * @return array<string, mixed>
     */
    public static function appendBody(Node $node, string $payload, ?string $updateId = null, ?int $generation = null, ?string $sha256 = null, string $origin = 'client', ?int $seedStateVersion = null): array
    {
        $generation ??= self::aggregate($node)->collab_epoch;

        return array_filter([
            'room' => self::room($node, $generation),
            'generation' => $generation,
            'update_id' => $updateId ?? (string) Str::uuid(),
            'sha256' => $sha256 ?? hash('sha256', $payload),
            'payload' => base64_encode($payload),
            'origin' => $origin,
            'seed_state_version' => $seedStateVersion,
        ], static fn (mixed $value): bool => $value !== null);
    }

    /**
     * The hub's seed of an empty generation: the first record, from the JSON of the state version load returned.
     *
     * @return array<string, mixed>
     */
    public static function seedBody(Node $node, string $payload, ?int $stateVersion = null, ?string $updateId = null): array
    {
        return self::appendBody($node, $payload, $updateId, origin: 'server', seedStateVersion: $stateVersion ?? self::aggregate($node)->state_version);
    }

    /** @return array<string, mixed> */
    public static function tiptap(string $text): array
    {
        return ['type' => 'doc', 'content' => [
            ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => $text]]],
        ]];
    }

    public static function aggregate(Node $node): Document
    {
        return Document::query()->where('node_id', $node->getKey())->firstOrFail();
    }
}
