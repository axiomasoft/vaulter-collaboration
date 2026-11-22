<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Log;
use Packman\Attributes\Internal;
use Throwable;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Contracts\Observability\MetricsRecorder;
use Vaulter\Drive\Enums\Events\DriveEventType;
use Vaulter\Events\EventTypeContract;
use Vaulter\Events\Outbox\ConsumeResult;
use Vaulter\Events\Outbox\DeliveryClass;
use Vaulter\Events\Outbox\DeliveryControl;
use Vaulter\Events\Outbox\OutboxConsumer;
use Vaulter\Events\Outbox\OutboxEnvelope;

/**
 * The collaboration module's control consumer (`collaboration.control`, ephemeral): after a change of effective
 * permissions commits, it tells the hubs `{v: 1, drive_id|null, scope, permissions_version, at}` through the
 * configured {@see ControlTransport}, so they re-check the rights of the connections of that drive (every connection
 * for a global change) at once instead of on the next append or renewal. `permissions_version` is the version of the
 * drive (or the global one) now, which every token issued before the change is older than.
 *
 * Control traffic only: it holds no retention, and a message that fails to go out is logged and counted
 * (`vaulter_collab_control_failures_total`) but not retried — the token lifetime and the checks of every append and
 * renewal bound what a lost message costs. A change older than `hub.token_ttl + hub.clock_skew` is dropped unsent
 * (`vaulter_collab_control_stale_total`): every token issued before it has expired, so a module re-enabled after a
 * pause never replays old messages. The `none` transport sends nothing.
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
        return $type === DriveEventType::EffectivePermissionsChanged;
    }

    public function consume(OutboxEnvelope $envelope, DeliveryControl $control): ConsumeResult
    {
        if ($envelope->type !== DriveEventType::EffectivePermissionsChanged->value) {
            return ConsumeResult::done();
        }
        $transport = $this->transport->name();
        if ($envelope->createdAt->lessThan(CarbonImmutable::now()->subSeconds($this->config->hubTokenTtl() + $this->config->hubClockSkew()))) {
            $this->metrics->counter(name: 'vaulter_collab_control_stale_total', labels: ['transport' => $transport]);

            return ConsumeResult::done();
        }
        $message = $this->message($envelope);

        try {
            $this->transport->publish(json_encode($message, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
            $this->metrics->counter(name: 'vaulter_collab_control_published_total', labels: ['transport' => $transport]);
        } catch (Throwable $failure) {
            Log::warning('[Vaulter] A collaboration control message was not delivered; the hubs re-check the rights on the next append or renewal.', [
                'event_id' => $envelope->eventId,
                'drive_id' => $message['drive_id'],
                'transport' => $transport,
                'error' => $failure->getMessage(),
            ]);
            $this->metrics->counter(name: 'vaulter_collab_control_failures_total', labels: ['transport' => $transport]);
        }

        return ConsumeResult::done();
    }

    /**
     * @return array{v: int, drive_id: string|null, scope: string, permissions_version: int, at: string}
     */
    private function message(OutboxEnvelope $envelope): array
    {
        $data = $envelope->payload['data'] ?? [];
        $driveId = is_array($data) && is_string($data['drive_id'] ?? null) && $data['drive_id'] !== '' ? $data['drive_id'] : null;
        $scope = is_array($data) && is_string($data['scope'] ?? null) ? $data['scope'] : ($driveId === null ? 'global' : 'drive');

        return [
            'v' => self::VERSION,
            'drive_id' => $driveId,
            'scope' => $scope,
            'permissions_version' => $this->versions->of(PermissionVersions::key($driveId)),
            'at' => $envelope->createdAt->utc()->format('Y-m-d\TH:i:s.v\Z'),
        ];
    }
}
