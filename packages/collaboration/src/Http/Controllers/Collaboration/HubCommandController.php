<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Controllers\Collaboration;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use JsonException;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Exceptions\CollaborationUpdateTooLargeException;
use Vaulter\Collaboration\HocuspocusCollaborationDriver;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Persistence\CommandJournal;
use Vaulter\Collaboration\Persistence\Head;
use Vaulter\Collaboration\Persistence\LogSnapshot;
use Vaulter\Collaboration\Persistence\RoomWriteConflict;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\RoomOwnership;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\LockedDocumentState;

/** Signed calls by the room owner. A command's authority comes from the registered PHP actor. */
#[Internal]
final readonly class HubCommandController
{
    public function __construct(
        private VaulterDatabase $db,
        private CollaborativeState $state,
        private RoomOwnership $rooms,
        private CommandJournal $journal,
        private UpdateLog $updates,
        private CollaborationOptions $options,
        private HocuspocusCollaborationDriver $driver,
    ) {}

    public function __invoke(Request $request): JsonResponse
    {
        HubProtocol::require($request);

        return match ($request->route()?->getName()) {
            'vaulter.v1.collaboration.hub.ownership.acquire' => $this->acquire($request),
            'vaulter.v1.collaboration.hub.ownership.renew' => $this->renew($request),
            'vaulter.v1.collaboration.hub.commands.next' => $this->next($request),
            'vaulter.v1.collaboration.hub.commands.settle' => $this->settle($request),
            default => abort(404),
        };
    }

    private function acquire(Request $request): JsonResponse
    {
        return $this->locked($request, function (LockedDocumentState $doc) use ($request): array {
            $owner = $this->uuid($request->input('owner_id'), 'owner_id');
            $providedFence = $request->input('owner_fence');
            $head = $providedFence === null
                ? $this->rooms->acquire($doc, $owner)
                : $this->rooms->assertOwner($doc, $owner, $this->position($providedFence, 'owner_fence', min: 1));
            $result = $this->lease($head);
            if ($request->input('include_log') === true) {
                $after = $request->input('after_seq');
                $result['log'] = $this->snapshot($this->updates->read($doc, $after === null ? null : $this->position($after, 'after_seq')));
            }
            $ids = $request->input('historical_client_ids');
            if ($ids !== null) {
                $base = $this->position($request->input('base_seq'), 'base_seq');
                if ($head->headSeq !== $base) {
                    throw new RoomWriteConflict('base_moved');
                }
                if (!is_array($ids) || !array_is_list($ids) || count($ids) > 100000) {
                    throw $this->invalid('historical_client_ids');
                }
                $ids = array_map(fn (mixed $id): int => $this->position($id, 'historical_client_ids', min: 1, max: 0xFFFFFFFF), $ids);
                $result['server_client_id'] = $this->rooms->allocateServer($doc, (int) $doc->tenantId, $owner, $ids);
            }

            return $result;
        });
    }

    private function renew(Request $request): JsonResponse
    {
        return $this->locked($request, function (LockedDocumentState $doc) use ($request): array {
            [$owner, $fence] = $this->owner($request);
            if ($request->input('release') === true) {
                $this->rooms->release($doc, $owner, $fence);

                return ['released' => true];
            }

            return $this->lease($this->rooms->renew($doc, $owner, $fence));
        });
    }

    private function next(Request $request): JsonResponse
    {
        if (!$request->has('document_id')) {
            return HubProtocol::mark(new JsonResponse(['targets' => $this->journal->targets()]));
        }

        return $this->locked($request, function (LockedDocumentState $doc) use ($request): array {
            if ($request->input('read_log') === true) {
                $head = $this->rooms->head($doc);
                if ($head?->profile !== 'strict' || $doc->writeMode !== 'journal' || $doc->trashed) {
                    throw new RoomWriteConflict('strict_profile_required');
                }

                return ['log' => $this->snapshot($this->updates->read($doc))];
            }
            [$owner, $fence] = $this->owner($request);
            $this->rooms->assertOwner($doc, $owner, $fence);

            return ['command' => $this->journal->next($doc)];
        });
    }

    private function settle(Request $request): JsonResponse
    {
        [$owner, $fence] = $this->owner($request);
        $generation = $this->position($request->input('generation'), 'generation');
        $base = $this->position($request->input('base_seq'), 'base_seq');
        $kind = $request->input('kind');
        if ($kind === 'seed') {
            return $this->locked($request, function (LockedDocumentState $doc) use ($request, $owner, $fence, $generation, $base): array {
                $update = $this->envelope($request->input('update'), $generation, $this->position($request->input('seed_state_version'), 'seed_state_version'));

                return $this->updates->appendFenced($doc->nodeId, $update, $owner, $fence, $base, static fn (): null => null)->ack();
            });
        }
        $id = $this->uuid($request->input('id'), 'id');
        $fingerprint = $this->hash($request->input('fingerprint'), 'fingerprint');
        $updates = $request->input('updates', []);
        if (!is_array($updates) || !array_is_list($updates) || count($updates) > 100 || !in_array($kind, ['commit', 'reject'], true)) {
            throw $this->invalid('kind');
        }
        $reason = $request->input('reason');
        // The signed payload carries exact text windows. Laravel's string normalizer
        // removes boundary spaces from parsed inputs.
        try {
            $signed = json_decode($request->getContent(), true, flags: JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw $this->invalid('evidence');
        }
        $evidence = is_array($signed) ? ($signed['evidence'] ?? []) : [];
        if ($kind === 'reject') {
            if ($updates !== [] || $reason !== 'precondition_failed') {
                throw $this->invalid('evidence');
            }
            $evidence = [];
        } elseif ($reason !== null || !is_array($evidence) || $evidence === [] || array_is_list($evidence)) {
            throw $this->invalid('evidence');
        }
        $envelopes = array_map(fn (mixed $row): UpdateEnvelope => $this->envelope($row, $generation), $updates);

        return HubProtocol::mark(new JsonResponse(
            $this->journal->settle($id, $owner, $fence, $generation, $base, $fingerprint, $envelopes, $evidence, $reason, protocol: $this->driver->version()),
        ));
    }

    /** @param Closure(LockedDocumentState): array<string, mixed> $operation */
    private function locked(Request $request, Closure $operation): JsonResponse
    {
        $document = $request->input('document_id');
        $generation = $this->position($request->input('generation'), 'generation');
        if (!is_string($document) || $document === '' || strlen($document) > 64
            || (!ctype_digit($document) && !Str::isUuid($document) && !Str::isUlid($document))) {
            throw $this->invalid('document_id');
        }
        $result = $this->db->transaction(function () use ($document, $generation, $operation): array {
            $locked = $this->state->lockByDocumentId($document) ?? throw new RoomWriteConflict('resource_unavailable');
            $this->rooms->assertGeneration($locked, $generation);
            if ($this->rooms->protocol($locked) !== $this->driver->version()) {
                throw new RoomWriteConflict('unsupported_protocol');
            }

            return $operation($locked);
        });

        return HubProtocol::mark(new JsonResponse($result));
    }

    /** @return array{string, int} */
    private function owner(Request $request): array
    {
        return [$this->uuid($request->input('owner_id'), 'owner_id'), $this->position($request->input('owner_fence'), 'owner_fence', min: 1)];
    }

    /** @return array<string, mixed> */
    private function lease(Head $head): array
    {
        return [
            'owner_fence' => $head->ownerFence,
            'owner_expires_at' => $head->ownerExpiresAt?->toISOString(),
            'head_seq' => $head->headSeq,
        ];
    }

    /** @return array<string, mixed> */
    private function snapshot(LogSnapshot $log): array
    {
        return [
            'generation' => $log->generation, 'state_version' => $log->stateVersion, 'type' => $log->type,
            'schema_version' => $log->schemaVersion, 'profile' => $log->profile, 'checkpoint_seq' => $log->checkpointSeq,
            'state_format' => $log->binding->stateFormat,
            'head_seq' => $log->headSeq, 'checkpoint' => $log->checkpoint === null ? null : base64_encode($log->checkpoint),
            'content' => $log->checkpoint === null ? $log->content : null, 'tail' => $log->tail,
        ];
    }

    private function envelope(mixed $row, int $generation, ?int $seed = null): UpdateEnvelope
    {
        if (!is_array($row) || !is_string($row['payload'] ?? null)) {
            throw $this->invalid('updates');
        }
        $max = $seed === null ? $this->options->updateBytes() : $this->options->maxStateBytes();
        if (strlen($row['payload']) > 4 * (int) ceil($max / 3)) {
            throw new CollaborationUpdateTooLargeException(intdiv(strlen($row['payload']), 4) * 3, $max);
        }
        $payload = base64_decode($row['payload'], strict: true);
        if ($payload === false || $payload === '') {
            throw $this->invalid('updates');
        }
        if (strlen($payload) > $max) {
            throw new CollaborationUpdateTooLargeException(strlen($payload), $max);
        }

        return new UpdateEnvelope($generation, $this->uuid($row['update_id'] ?? null, 'update_id'), $payload, $this->hash($row['sha256'] ?? null, 'sha256'), 'server', $seed);
    }

    private function position(mixed $value, string $field, int $min = 0, int $max = 9007199254740991): int
    {
        if (!is_int($value) || $value < $min || $value > $max) {
            throw $this->invalid($field);
        }

        return $value;
    }

    private function uuid(mixed $value, string $field): string
    {
        if (!is_string($value) || !Str::isUuid($value)) {
            throw $this->invalid($field);
        }

        return strtolower($value);
    }

    private function hash(mixed $value, string $field): string
    {
        if (!is_string($value) || preg_match('/\A[0-9a-f]{64}\z/', $value) !== 1) {
            throw $this->invalid($field);
        }

        return $value;
    }

    private function invalid(string $field): ValidationException
    {
        return ValidationException::withMessages([$field => ['Invalid collaboration journal request.']]);
    }
}
