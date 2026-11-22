<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Controllers\Collaboration;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Persistence\CompactionLease;
use Vaulter\Collaboration\Persistence\CompactionLeases;

/**
 * Protocol 2 compaction lease: the hub's compaction worker asks for up to `max` (1..100) document generations
 * due for a checkpoint. Body `{hub_id, max, report?}`. The answer is a list, drain requests first, of `{document,
 * generation, lease_token, lease_expires_at, checkpoint_seq, head_seq, checkpoint_version, type, schema_version,
 * checkpoint (base64, null before the first one), content (the JSON to seed from when there is no checkpoint, else
 * null), tail: [{seq, update_id, payload}]}`: what the hub merges, read with the lease under the document and head locks,
 * and the values its publication repeats. With `report: true` the answer also says what is still due for compaction
 * after these leases, whichever hub holds it ({@see CompactionLeases::pending()}): `X-Vaulter-Collab-Pending` counts
 * the generations, `X-Vaulter-Collab-Pending-Documents` names the first of them as `document:generation`,
 * comma-separated. The call is the hub's own, not a room connection's: the body signature authenticates it.
 */
#[Internal]
final readonly class HubCompactionLeaseController
{
    /** The header that counts the generations still due for compaction. */
    public const string PENDING_HEADER = 'X-Vaulter-Collab-Pending';

    /** The header that names the first of them. */
    public const string PENDING_DOCUMENTS_HEADER = 'X-Vaulter-Collab-Pending-Documents';

    public function __construct(
        private CompactionLeases $leases,
    ) {}

    public function __invoke(Request $request): JsonResponse
    {
        HubProtocol::require($request);
        $hubId = $request->input('hub_id');
        $max = $request->input('max', 1);
        $report = $request->input('report', false);
        $errors = array_filter([
            'hub_id' => is_string($hubId) && $hubId !== '' && strlen($hubId) <= 191 ? null : 'The hub_id must be a string of 1 to 191 bytes.',
            'max' => is_int($max) && $max >= 1 && $max <= CompactionLeases::MAX ? null : 'The max must be an integer from 1 to '.CompactionLeases::MAX.'.',
            'report' => is_bool($report) ? null : 'The report must be a boolean.',
        ]);
        if ($errors !== [] || !is_string($hubId) || !is_int($max)) {
            throw ValidationException::withMessages(array_map(static fn (string $message): array => [$message], $errors));
        }

        $entries = array_map($this->entry(...), $this->leases->grant($hubId, $max));
        $response = new JsonResponse($entries);
        if ($report === true) {
            $pending = $this->leases->pending();
            $response->headers->set(self::PENDING_HEADER, (string) $pending['total']);
            $response->headers->set(self::PENDING_DOCUMENTS_HEADER, implode(',', array_map(
                static fn (array $generation): string => $generation['document'].':'.$generation['generation'],
                $pending['generations'],
            )));
        }

        return HubProtocol::mark($response);
    }

    /** @return array<string, mixed> */
    private function entry(CompactionLease $lease): array
    {
        $log = $lease->log;

        return [
            'document' => $lease->nodeId,
            'generation' => $log->generation,
            'lease_token' => $lease->token,
            'lease_expires_at' => self::wire($lease->expiresAt),
            'checkpoint_seq' => $log->checkpointSeq,
            'head_seq' => $log->headSeq,
            'checkpoint_version' => $lease->checkpointVersion,
            'type' => $log->type,
            'schema_version' => $log->binding->schemaVersion,
            'protocol' => $log->binding->protocol,
            'state_format' => $log->binding->stateFormat,
            'checkpoint' => $log->checkpoint === null ? null : base64_encode($log->checkpoint),
            'content' => $log->checkpoint === null
                ? $log->content
                : null,
            'tail' => $log->tail,
        ];
    }

    /** The lease expiry as it has always been on the wire: UTC with microseconds and a trailing Z. */
    private static function wire(DateTimeInterface $time): string
    {
        return DateTimeImmutable::createFromInterface($time)->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.u\Z');
    }
}
