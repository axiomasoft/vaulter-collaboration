<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation;

use Carbon\CarbonImmutable;
use Closure;
use Illuminate\Support\Facades\Log;
use Packman\Attributes\Internal;
use Throwable;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Persistence\CommandEventType;
use Vaulter\Contracts\Observability\MetricsRecorder;
use Vaulter\Documents\Enums\DocumentEventType;
use Vaulter\Drive\Enums\Events\DriveEventType;
use Vaulter\Events\EventTypeContract;
use Vaulter\Events\Outbox\ConsumeResult;
use Vaulter\Events\Outbox\DeliveryClass;
use Vaulter\Events\Outbox\DeliveryControl;
use Vaulter\Events\Outbox\OutboxConsumer;
use Vaulter\Events\Outbox\OutboxEnvelope;

/**
 * Sends committed room and permission changes to the hubs. Delivery is ephemeral: the journal's
 * generation and owner fences and the backend's token checks also apply when delivery fails.
 */
#[Internal]
final readonly class ControlConsumer implements OutboxConsumer
{
    public const string ID = 'collaboration.control';

    /** The version of the control message format. */
    public const int VERSION = 1;

    public function __construct(
        private PermissionVersions $versions,
        private ControlTransport $transport,
        private MetricsRecorder $metrics,
        private CollaborationOptions $config,
    ) {}

    public function id(): string
    {
        return self::ID;
    }

    public function deliveryClass(): DeliveryClass
    {
        return DeliveryClass::Ephemeral;
    }

    public function subscribes(EventTypeContract $type): bool
    {
        return match ($type) {
            DriveEventType::EffectivePermissionsChanged, DriveEventType::GrantRevoked,
            DocumentEventType::DocumentRestored, DocumentEventType::DocumentUpdated,
            CommandEventType::Committed => true,
            default => false,
        };
    }

    public function consume(OutboxEnvelope $envelope, DeliveryControl $control): ConsumeResult
    {
        $permission = in_array($envelope->type, [DriveEventType::EffectivePermissionsChanged->value, DriveEventType::GrantRevoked->value], true);
        if ($permission && $envelope->createdAt->lessThan(CarbonImmutable::now()->subSeconds($this->config->hubTokenTtl() + $this->config->hubClockSkew()))) {
            $this->metrics->counter(name: 'vaulter_collab_control_stale_total', labels: ['transport' => $this->transport->name()]);

            return ConsumeResult::done();
        }
        $this->publish(fn (): ?array => $this->message($envelope), $envelope->type, $envelope->eventId);

        return ConsumeResult::done();
    }

    public function handoff(OwnerLeaseChanged $event): void
    {
        $this->publish(static fn (): array => [
            'type' => 'handoff_request', 'room' => $event->room, 'owner_fence' => $event->previousFence,
        ], 'handoff_request');
    }

    /** @param Closure(): (array<string, mixed>|null) $message */
    private function publish(Closure $message, string $eventType, ?string $eventId = null): void
    {
        $transport = $this->transport->name();
        try {
            $body = $message();
            if ($body === null) {
                return;
            }
            $this->transport->publish(json_encode(['v' => self::VERSION] + $body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
            $this->metrics->counter(name: 'vaulter_collab_control_published_total', labels: ['transport' => $transport]);
        } catch (Throwable $failure) {
            Log::warning('[Vaulter] A collaboration control message was not delivered.', [
                'event_id' => $eventId,
                'event_type' => $eventType,
                'transport' => $transport,
                'error' => $failure->getMessage(),
            ]);
            $this->metrics->counter(name: 'vaulter_collab_control_failures_total', labels: ['transport' => $transport]);
        }
    }

    /** @return array<string, mixed>|null */
    private function message(OutboxEnvelope $envelope): ?array
    {
        $data = $envelope->payload['data'] ?? [];
        if (!is_array($data)) {
            return null;
        }
        $driveId = $envelope->payload['drive_id'] ?? null;
        $driveId = is_string($driveId) && $driveId !== '' ? $driveId : null;

        return match ($envelope->type) {
            CommandEventType::Committed->value => [
                'type' => 'wakeup', 'document_id' => $data['document_id'] ?? null,
                'generation' => $data['generation'] ?? null, 'position' => $data['position'] ?? null,
            ],
            DocumentEventType::DocumentRestored->value, DocumentEventType::DocumentUpdated->value => $this->epochBump($envelope, $data, $driveId),
            DriveEventType::GrantRevoked->value => $this->subjectRevocation($data, $driveId),
            // Inherited and group permissions can affect principals that the invalidation does not name.
            DriveEventType::EffectivePermissionsChanged->value => [
                'drive_id' => $driveId,
                'scope' => is_string($data['scope'] ?? null) ? $data['scope'] : ($driveId === null ? 'global' : 'drive'),
                'permissions_version' => $this->versions->of(PermissionVersions::key($driveId)),
                'at' => $envelope->createdAt->utc()->format('Y-m-d\TH:i:s.v\Z'),
            ],
            default => null,
        };
    }

    /** @param array<array-key, mixed> $data
     * @return array{type: string, room: string}|null
     */
    private function epochBump(OutboxEnvelope $envelope, array $data, ?string $driveId): ?array
    {
        $subject = $envelope->payload['subject'] ?? null;
        $node = is_array($subject) ? ($subject['id'] ?? null) : null;
        $epoch = $data['epoch'] ?? null;
        if ($driveId === null || !is_string($node) || $node === '' || !is_int($epoch) || $epoch < 1) {
            return null;
        }

        return ['type' => 'epoch_bump_4409', 'room' => $this->config->room($driveId, $node, $epoch - 1)];
    }

    /** @param array<array-key, mixed> $data
     * @return array{type: string, drive_id: string, scope: string, subject_id: string, subject_type: string}|null
     */
    private function subjectRevocation(array $data, ?string $driveId): ?array
    {
        $subject = $data['subject'] ?? null;
        if ($driveId === null || !is_array($subject) || !is_string($subject['id'] ?? null) || $subject['id'] === ''
            || !is_string($subject['type'] ?? null) || $subject['type'] === '') {
            return null;
        }

        return [
            'type' => 'revoke_subject', 'drive_id' => $driveId, 'scope' => 'drive',
            'subject_id' => $subject['id'], 'subject_type' => $subject['type'],
        ];
    }
}
