<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Controllers\Collaboration;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Exceptions\CollaborationUpdateTooLargeException;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Persistence\Checkpoint;
use Vaulter\Collaboration\Persistence\CheckpointRequest;
use Vaulter\Documents\State\CollaborationStateBinding;
use Vaulter\Support\Identity;

/**
 * Protocol 2 checkpoint publication: the hub publishes what it merged under a compaction lease. Body
 * `{document, generation, lease_token, covered_from, covered_through, expected_checkpoint_version, state (base64 Yjs),
 * content (its JSON projection)}`; the answer `{checkpoint_version, marker_cleared}`. A lease that does not hold the
 * generation or a log that moved since the lease read it answers 409 collaboration_checkpoint_conflict, a closed
 * generation 409 collaboration_epoch_mismatch; either changes and deletes nothing. The state's base64 length is checked
 * against `max_state_bytes` before it is decoded.
 */
#[Internal]
final readonly class HubCheckpointController
{
    public function __construct(private Checkpoint $checkpoint, private CollaborationOptions $config) {}

    public function __invoke(Request $request): JsonResponse
    {
        HubProtocol::require($request);

        return HubProtocol::mark(new JsonResponse($this->checkpoint->publish($this->publication($request))->toArray()));
    }

    private function publication(Request $request): CheckpointRequest
    {
        $document = $request->input('document');
        $generation = $request->input('generation');
        $token = $request->input('lease_token');
        $from = $request->input('covered_from');
        $through = $request->input('covered_through');
        $version = $request->input('expected_checkpoint_version');
        $state = $request->input('state');
        $content = $request->input('content');
        $protocol = $request->input('protocol');
        $format = $request->input('state_format');
        $schema = $request->input('schema_version');
        $type = $request->input('type');

        $counter = static fn (mixed $value): bool => is_int($value) && $value >= 0;
        $errors = array_filter([
            'protocol' => is_string($protocol) && trim($protocol) !== '' ? null : 'The protocol must name the leased binding.',
            'state_format' => is_string($format) && trim($format) !== '' ? null : 'The state_format must name the leased binding.',
            'schema_version' => is_int($schema) && $schema >= 1 ? null : 'The schema_version must be a positive integer.',
            'type' => is_string($type) && $type !== '' ? null : 'The type must name the leased document type.',
            'document' => (is_string($document) && $document !== '') || is_int($document) ? null : 'The document must be a node id.',
            'generation' => $counter($generation) ? null : 'The generation must be a non-negative integer.',
            'lease_token' => is_string($token) && $token !== '' ? null : 'The lease_token must be the token of a compaction lease.',
            'covered_from' => $counter($from) ? null : 'The covered_from must be a non-negative integer.',
            'covered_through' => $counter($through) ? null : 'The covered_through must be a non-negative integer.',
            'expected_checkpoint_version' => $counter($version) ? null : 'The expected_checkpoint_version must be a non-negative integer.',
            'state' => is_string($state) && $state !== '' ? null : 'The state must be a non-empty base64 string.',
            // The projection is a JSON object (a document).
            'content' => is_array($content) && !array_is_list($content) ? null : 'The content must be the JSON projection of the state.',
        ]);
        if ($errors !== [] || (!is_string($document) && !is_int($document)) || !is_int($generation) || !is_string($token)
            || !is_string($protocol) || !is_string($format) || !is_int($schema) || !is_string($type)
            || !is_int($from) || !is_int($through) || !is_int($version) || !is_string($state) || !is_array($content)) {
            throw ValidationException::withMessages(array_map(static fn (string $message): array => [$message], $errors));
        }

        return new CheckpointRequest(
            nodeId: Identity::stringify($document),
            generation: $generation,
            leaseToken: $token,
            coveredFrom: $from,
            coveredThrough: $through,
            expectedCheckpointVersion: $version,
            state: $this->state($state),
            content: array_filter($content, is_string(...), ARRAY_FILTER_USE_KEY),
            binding: new CollaborationStateBinding($protocol, $format, $schema, $generation),
            documentType: $type,
        );
    }

    /** The binary state, refused by its base64 length before decoding allocates it. */
    private function state(string $encoded): string
    {
        $max = $this->config->maxStateBytes();
        if (strlen($encoded) > 4 * (int) ceil($max / 3)) {
            throw new CollaborationUpdateTooLargeException(intdiv(strlen($encoded), 4) * 3, $max);
        }
        $decoded = base64_decode($encoded, strict: true);
        if ($decoded === false || $decoded === '') {
            throw ValidationException::withMessages(['state' => ['The state must be valid base64-encoded binary.']]);
        }
        if (strlen($decoded) > $max) {
            throw new CollaborationUpdateTooLargeException(strlen($decoded), $max);
        }

        return $decoded;
    }
}
