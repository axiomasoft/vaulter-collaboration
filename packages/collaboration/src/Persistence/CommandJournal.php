<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Illuminate\Contracts\Container\Container;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Str;
use LogicException;
use Packman\Attributes\Internal;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use stdClass;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\Drain\DrainState;
use Vaulter\Collaboration\RoomOwnership;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Access\CollaborationAccessPolicy;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\LockedDocumentState;
use Vaulter\Drive\Enums\Access\Ability;
use Vaulter\Drive\Enums\DriveStatus;
use Vaulter\Drive\Exceptions\Access\PermissionDeniedException;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Events\EventRecorder;
use Vaulter\Support\Identity;
use Vaulter\ValueObjects\Access\Actor;
use Vaulter\ValueObjects\Access\ActorRef;

/** Durable intents and business receipts. Node and document authority always precede the journal row lock. */
#[Spi(SpiKind::Call)]
final readonly class CommandJournal
{
    private const int TARGET_LIMIT = 16;

    #[Internal]
    public function __construct(
        private VaulterDatabase $db,
        private CollaborativeState $state,
        private LogTables $tables,
        private UpdateLog $updates,
        private RoomOwnership $rooms,
        private DrainState $draining,
        private EventRecorder $events,
        private CollaborationAccessPolicy $policy,
        private Container $container,
        private CollaborationOptions $options,
        private HubEvidenceReader $verifier,
    ) {}

    /**
     * @param  array<string, mixed> $intent
     * @return array<string, mixed>
     */
    public function register(CommandActor $scope, string $key, string $proposal, string $digest, int $generation, int $schema, int $readPosition, array $intent): array
    {
        if ($key === '' || strlen($key) > 255 || !Str::isUuid($proposal) || !preg_match('/\A[0-9a-f]{64}\z/', $digest)
            || $generation < 0 || $schema < 1 || $readPosition < 0) {
            throw new RoomWriteConflict('invalid_intent');
        }
        $fingerprint = hash('sha256', json_encode(self::canonical([$proposal, $digest, $generation, $schema, $readPosition, $intent]), JSON_THROW_ON_ERROR));

        return $this->db->transaction(function () use ($scope, $key, $proposal, $digest, $generation, $schema, $readPosition, $intent, $fingerprint): array {
            $doc = $this->state->lock($scope->resourceId);
            $writable = $this->authorize($scope);
            $existing = $this->scope($scope)->where('command_id', $key)->lockForUpdate()->first();
            if ($existing !== null) {
                if ($this->fingerprint($existing) !== $fingerprint) {
                    throw new RoomWriteConflict('key_conflict');
                }

                return $this->replay($existing);
            }
            if (!$writable) {
                throw PermissionDeniedException::forAbility(Ability::Edit->value);
            }
            $this->rooms->assertGeneration($doc, $generation);
            if ($doc->schemaVersion !== $schema) {
                throw new RoomWriteConflict('schema_changed');
            }
            if ($this->options->strictProfile() && $this->rooms->head($doc) === null) {
                $this->rooms->selectProfile($doc, strict: true);
            }
            $head = $this->rooms->strictHead($doc);
            if ($head->headSeq < $readPosition) {
                throw new RoomWriteConflict('projection_behind');
            }
            $now = $this->tables->leaseClock();
            $id = (string) Str::uuid7();
            $this->table()->insert([
                'id' => $id,
                'tenant_id' => (int) $scope->tenant,
                'project_scope' => $scope->project,
                'effective_subject' => $scope->subject,
                'resource_id' => Identity::key($scope->resourceId),
                'document_id' => Identity::key($doc->documentId),
                'command_id' => $key,
                'proposal_id' => $proposal,
                'proposal_digest' => $this->binary($digest),
                'fingerprint' => $this->binary($fingerprint),
                'generation' => $generation,
                'schema_version' => $schema,
                'read_position' => $readPosition,
                'intent' => json_encode([
                    'principal_type' => $scope->principal->type,
                    'principal_id' => $scope->principal->id,
                    'drive_id' => $scope->driveId,
                    'tenant' => $scope->tenant,
                    'operation' => (object) $intent,
                ], JSON_THROW_ON_ERROR),
                'registered_at' => $this->tables->timestamp($now),
                'replay_until' => $this->tables->timestamp($now->copy()->addDay()),
            ]);

            return $this->result($this->row($id));
        });
    }

    /** @return array<string, mixed>|null */
    public function status(CommandActor $scope, string $key): ?array
    {
        return $this->db->transaction(function () use ($scope, $key): ?array {
            $this->state->lock($scope->resourceId);
            $this->authorize($scope);
            $row = $this->scope($scope)->where('command_id', $key)->first();

            return $row === null ? null : $this->replay($row);
        });
    }

    /** @return array{document_id: string, evidence: array<array-key, mixed>, generation: int, to_seq: int|null, ...} */
    public function evidence(CommandActor $scope, string $receipt): array
    {
        if (!Str::isUuid($receipt)) {
            throw NodeNotFoundException::forId($scope->resourceId);
        }

        return $this->db->transaction(function () use ($scope, $receipt): array {
            $doc = $this->state->lock($scope->resourceId);
            $this->authorize($scope);
            $row = $this->scope($scope)->where('receipt_id', $receipt)->first();
            if ($row === null || $doc->documentId !== Identity::stringify($row->document_id)) {
                throw NodeNotFoundException::forId($scope->resourceId);
            }
            if ($row->evidence === null || !LogTables::time($row->evidence_expires_at, 'UTC')?->greaterThan($this->tables->leaseClock())) {
                throw new RoomWriteConflict('evidence_unavailable');
            }

            return $this->result($row) + ['document_id' => $doc->documentId, 'evidence' => self::json($row->evidence)];
        });
    }

    /** @return array{generation: int, position: int, text: string, textPassed: bool, marks: list<string>, marksPassed: bool}|null */
    public function verifyCurrent(CommandActor $scope, string $receipt): ?array
    {
        $proof = $this->evidence($scope, $receipt);
        $ranges = $proof['evidence']['ranges'] ?? null;
        $range = is_array($ranges) ? ($ranges[0] ?? null) : null;
        if (!is_array($range) || $proof['to_seq'] === null) {
            throw new RoomWriteConflict('evidence_unavailable');
        }
        $namedRange = array_filter($range, is_string(...), ARRAY_FILTER_USE_KEY);
        $result = $this->verifier->verify($proof['document_id'], $proof['generation'], $proof['to_seq'], $namedRange);
        if ($result !== null) {
            $this->db->transaction(function () use ($scope, $result): void {
                $doc = $this->state->lock($scope->resourceId);
                $this->authorize($scope);
                $this->rooms->assertGeneration($doc, $result['generation']);
            });
        }

        return $result;
    }

    /** @return array{generation: int, position: int}|null */
    public function receiptMarker(CommandActor $scope, string $receipt): ?array
    {
        if (!Str::isUuid($receipt)) {
            return null;
        }

        return $this->db->transaction(function () use ($scope, $receipt): ?array {
            $doc = $this->state->lock($scope->resourceId);
            $this->authorize($scope);
            $row = $this->scope($scope)->where('receipt_id', $receipt)->first();
            if ($row === null || $doc->documentId !== Identity::stringify($row->document_id)) {
                return null;
            }

            return ['generation' => LogTables::int($row->generation), 'position' => LogTables::int($row->to_seq)];
        });
    }

    /**
     * Pair a projected snapshot's state version with its journal sequence under the document and head locks.
     *
     * @return array{generation: int, position: int}|null
     */
    public function projected(CommandActor $scope, int $generation, int $stateVersion): ?array
    {
        return $this->db->transaction(function () use ($scope, $generation, $stateVersion): ?array {
            $doc = $this->state->lock($scope->resourceId);
            if ($doc->writeMode !== 'journal') {
                return null;
            }
            $this->authorize($scope);
            $head = $this->rooms->head($doc);
            if ($head === null ? !$this->options->strictProfile() : $head->profile !== 'strict') {
                return null;
            }
            if ($doc->generation !== $generation) {
                throw new RoomWriteConflict('generation_changed');
            }
            if ($doc->stateVersion !== $stateVersion || $doc->pending !== null || ($head !== null && $head->headSeq !== $head->checkpointSeq)) {
                throw new RoomWriteConflict('projection_behind');
            }

            return ['generation' => $generation, 'position' => $head->checkpointSeq ?? 0];
        });
    }

    /** @return list<array{document: string, generation: int}> */
    #[Internal]
    public function targets(): array
    {
        $this->db->transaction(function (): void {
            $now = $this->tables->timestamp($this->tables->leaseClock());
            // Tombstones retain their fingerprint and receipt identity; expired evidence and finished intents can be cleared.
            $expired = $this->table()->where('evidence_expires_at', '<=', $now)->whereNull('redacted_at')
                ->orderBy('evidence_expires_at')->limit(100)->lockForUpdate()->pluck('id');
            if ($expired->isNotEmpty()) {
                $this->table()->whereIn('id', $expired)->update(['redacted_at' => $now, 'evidence' => null]);
            }
            $this->table()->where('state', 'running')->whereNull('document_id')->update([
                'state' => 'rejected', 'rejection_code' => 'resource_unavailable', 'finalized_at' => $now, 'intent' => null,
            ]);
        });

        $targets = [];
        do {
            $remaining = self::TARGET_LIMIT - count($targets);
            $query = $this->table()->useWritePdo()->where('state', 'running')->whereNotNull('document_id');
            foreach ($targets as $target) {
                $query->whereNot(static fn (Builder $query): Builder => $query
                    ->where('document_id', Identity::key($target['document']))->where('generation', $target['generation']));
            }
            $page = $query->selectRaw('document_id, generation, min(registered_at) as first_registered')
                ->groupBy('document_id', 'generation')->orderBy('first_registered')->orderBy('document_id')->orderBy('generation')
                ->limit($remaining)->get();
            foreach ($page as $row) {
                $document = Identity::stringify($row->document_id);
                $generation = LogTables::int($row->generation);
                if ($this->availableTarget($document, $generation)) {
                    $targets[] = ['document' => $document, 'generation' => $generation];
                }
            }
            // Rejected groups leave the pending set, so another page can fill any slots they occupied.
        } while (count($targets) < self::TARGET_LIMIT && $page->count() === $remaining);

        return $targets;
    }

    private function availableTarget(string $document, int $generation): bool
    {
        // Each target gets its own transaction so discovery never holds locks from multiple documents.
        return $this->db->transaction(function () use ($document, $generation): bool {
            $doc = $this->state->lockByDocumentId($document);
            if ($doc !== null && !$doc->trashed && $doc->driveStatus === DriveStatus::Active) {
                return true;
            }

            $commands = $this->tables->rows('collaboration_commands', $document, $generation)->where('state', 'running');
            $rows = (clone $commands)->orderBy('id')->lockForUpdate()->get(['id', 'intent']);
            $now = $this->tables->timestamp($this->tables->leaseClock());
            foreach ($rows as $row) {
                (clone $commands)->where('id', $row->id)->update([
                    'state' => 'rejected', 'rejection_code' => 'resource_unavailable', 'finalized_at' => $now,
                    'intent' => self::redactOperation($row),
                ]);
            }

            return false;
        });
    }

    /** @return array<string, mixed>|null */
    #[Internal]
    public function next(LockedDocumentState $doc): ?array
    {
        $row = $this->table()->where('document_id', Identity::key($doc->documentId))
            ->where('generation', $doc->generation)->where('state', 'running')
            ->orderBy('registered_at')->orderBy('id')->first();

        return $row === null ? null : $this->result($row) + ['intent' => self::json($row->intent)['operation']];
    }

    /**
     * @param  list<UpdateEnvelope> $updates
     * @param  array<array-key, mixed> $evidence
     * @return array<string, mixed>
     */
    #[Internal]
    public function settle(string $id, string $owner, int $fence, int $generation, int $base, string $fingerprint, array $updates, array $evidence, ?string $reject = null, ?string $protocol = null): array
    {
        $this->draining->assertAccepting();

        return $this->db->transaction(function () use ($id, $owner, $fence, $generation, $base, $fingerprint, $updates, $evidence, $reject, $protocol): array {
            $address = $this->row($id);
            $doc = $this->state->lock(Identity::stringify($address->resource_id));
            if ($protocol !== null && $this->rooms->protocol($doc) !== $protocol) {
                throw new RoomWriteConflict('unsupported_protocol');
            }
            $head = $this->rooms->head($doc);
            $row = $this->row($id, lock: true);
            if (!hash_equals($this->fingerprint($row), $fingerprint)
                || $doc->documentId !== Identity::stringify($row->document_id)) {
                throw new RoomWriteConflict('key_conflict');
            }
            $scope = $this->storedScope($row);
            if ($row->state !== 'running') {
                $this->authorize($scope);

                return $this->replay($row);
            }
            $this->rooms->assertGeneration($doc, $generation);
            if (LogTables::int($row->generation) !== $generation) {
                throw new RoomWriteConflict('generation_changed');
            }
            $this->rooms->assertOwner($doc, $owner, $fence);
            if ($head?->headSeq !== $base || $base < LogTables::int($row->read_position)) {
                throw new RoomWriteConflict('base_moved');
            }
            try {
                if (!$this->authorize($scope)) {
                    $reject = 'edit_revoked';
                }
            } catch (NodeNotFoundException|PermissionDeniedException) {
                $reject = 'edit_revoked';
            }
            if ($doc->schemaVersion !== LogTables::int($row->schema_version)) {
                $reject = 'schema_changed';
            }
            $this->rooms->assertOwner($doc, $owner, $fence);
            $now = $this->tables->leaseClock();
            $terminal = [
                'owner_fence' => $fence, 'base_seq' => $base, 'finalized_at' => $this->tables->timestamp($now),
                'intent' => self::redactOperation($row),
            ];
            if ($reject !== null) {
                $terminal += ['state' => 'rejected', 'rejection_code' => $reject];
            } else {
                $position = $base;
                foreach ($updates as $update) {
                    $position = $this->updates->writeLocked($doc, $position, $update, allowDuplicate: false)->seq;
                }
                $receipt = (string) Str::uuid7();
                $terminal += [
                    'state' => 'committed', 'receipt_id' => $receipt, 'to_seq' => $position,
                    'from_seq' => $position === $base ? null : $base + 1,
                    'evidence' => json_encode((object) $evidence, JSON_THROW_ON_ERROR),
                    'evidence_expires_at' => $this->tables->timestamp($now->copy()->addDay()),
                ];
                $this->events->record(new CommandCommitted($scope, $doc->documentId, $receipt, $generation, $position));
            }
            $this->table()->where('id', $id)->where('state', 'running')->update($terminal);
            $this->draining->assertAccepting();

            return $this->result($this->row($id));
        });
    }

    private function authorize(CommandActor $scope): bool
    {
        $user = $this->container->make(HostUserResolver::class)->find($scope->principal);
        if ($user === null) {
            throw NodeNotFoundException::forId($scope->resourceId);
        }
        $actor = Actor::user($user);
        if ($actor->ref()->type !== $scope->principal->type
            || Identity::stringify($actor->ref()->id) !== Identity::stringify($scope->principal->id)) {
            throw NodeNotFoundException::forId($scope->resourceId);
        }
        $result = $this->policy->evaluateReference($actor, $scope->driveId, $scope->resourceId, $scope->tenant, $scope->project);

        return $result->grant->mode === CollaborationMode::Write;
    }

    private function storedScope(stdClass $row): CommandActor
    {
        $intent = self::json($row->intent);
        $type = $intent['principal_type'] ?? null;
        $id = Identity::key($intent['principal_id'] ?? null);
        $tenant = $intent['tenant'] ?? null;
        $drive = $intent['drive_id'] ?? null;
        $project = $row->project_scope;
        $subject = $row->effective_subject;
        if (!is_string($type) || $id === null || !array_key_exists('tenant', $intent)
            || ($tenant !== null && !is_string($tenant)) || !is_string($drive) || !is_string($project) || !is_string($subject)) {
            throw new LogicException('Invalid stored collaboration command scope.');
        }

        return new CommandActor(new ActorRef($type, $id), $tenant, $project, $subject, $drive, Identity::stringify($row->resource_id));
    }

    private static function redactOperation(stdClass $row): string
    {
        $identity = self::json($row->intent);
        unset($identity['operation']);

        return json_encode($identity, JSON_THROW_ON_ERROR);
    }

    private function table(): Builder
    {
        return $this->tables->table('collaboration_commands');
    }

    private function scope(CommandActor $scope): Builder
    {
        return $this->table()->where([
            'tenant_id' => (int) $scope->tenant, 'project_scope' => $scope->project, 'effective_subject' => $scope->subject,
            'resource_id' => Identity::key($scope->resourceId),
        ]);
    }

    private function row(string $id, bool $lock = false): stdClass
    {
        $query = $this->table()->where('id', $id);

        return ($lock ? $query->lockForUpdate() : $query)->first() ?? throw new RoomWriteConflict('unknown_command');
    }

    /** @return array<string, mixed> */
    private function replay(stdClass $row): array
    {
        if (!LogTables::time($row->replay_until, 'UTC')?->greaterThan($this->tables->leaseClock())) {
            throw new RoomWriteConflict('key_expired');
        }

        return $this->result($row);
    }

    /** @return array{generation: int, to_seq: int|null, ...} */
    private function result(stdClass $row): array
    {
        return [
            'id' => $row->id, 'command_id' => $row->command_id, 'fingerprint' => $this->fingerprint($row),
            'generation' => LogTables::int($row->generation), 'schema_version' => LogTables::int($row->schema_version),
            'state' => $row->state, 'receipt_id' => $row->receipt_id, 'rejection_code' => $row->rejection_code,
            'base_seq' => $row->base_seq === null ? null : LogTables::int($row->base_seq),
            'from_seq' => $row->from_seq === null ? null : LogTables::int($row->from_seq),
            'to_seq' => $row->to_seq === null ? null : LogTables::int($row->to_seq),
        ];
    }

    private function binary(string $hex): string
    {
        if ($this->db->connection()->getDriverName() === 'pgsql') {
            return '\\x'.$hex;
        }
        $binary = hex2bin($hex);

        return $binary !== false ? $binary : throw new LogicException('Invalid collaboration command digest.');
    }

    private function fingerprint(stdClass $row): string
    {
        if (is_resource($row->fingerprint)) {
            $row->fingerprint = stream_get_contents($row->fingerprint);
        }

        return bin2hex(Identity::stringify($row->fingerprint));
    }

    /** @return array<array-key, mixed> */
    private static function json(mixed $json): array
    {
        $decoded = json_decode(Identity::stringify($json), true, flags: JSON_THROW_ON_ERROR);

        return is_array($decoded) ? $decoded : throw new LogicException('Invalid stored collaboration command JSON.');
    }

    private static function canonical(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        if (!array_is_list($value)) {
            ksort($value, SORT_STRING);
        }

        return array_map(self::canonical(...), $value);
    }
}
