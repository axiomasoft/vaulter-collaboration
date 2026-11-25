<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Str;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Configuration\CollaborationOptions;

/** Resolves relative positions against the current confirmed journal through the configured Hub management hosts. */
#[Internal]
final readonly class HubEvidenceReader
{
    public function __construct(private Factory $http, private CollaborationOptions $options) {}

    /**
     * @param  array<string, mixed>                                                                                               $range
     * @return array{generation: int, position: int, text: string, textPassed: bool, marks: list<string>, marksPassed: bool}|null
     */
    public function verify(string $document, int $generation, int $minimum, array $range): ?array
    {
        $secret = $this->options->hubWebhookSecret();
        if ($secret === null) {
            return null;
        }
        $range['attributes'] = (object) array_map(
            static fn (mixed $value): mixed => is_array($value) ? (object) $value : $value,
            is_array($range['attributes'] ?? null) ? $range['attributes'] : [],
        );
        $payload = json_encode([
            'operation' => 'verify-command', 'document_id' => $document, 'generation' => $generation,
            'range' => array_intersect_key($range, array_flip([
                'block_id', 'window', 'window_leading_utf16', 'relative_start', 'relative_end', 'replacement', 'attributes',
            ])),
            'nonce' => (string) Str::uuid(),
        ], JSON_THROW_ON_ERROR);
        foreach ($this->options->controlHttpUrls() as $url) {
            $timestamp = time();
            try {
                $reply = $this->http->timeout($this->options->controlHttpTimeout())->withoutRedirecting()
                    ->withHeaders([
                        CollaborationCallResolver::TIMESTAMP_HEADER => (string) $timestamp,
                        CollaborationCallResolver::SIGNATURE_HEADER => CollaborationCallResolver::signature($payload, $secret->reveal(), $timestamp),
                    ])->withBody($payload, 'application/json')->post($url.'/verify-command');
            } catch (ConnectionException) {
                continue;
            }
            if ($reply->status() === 409) {
                throw new RoomWriteConflict('generation_changed');
            }
            $data = $reply->json();
            if (!$reply->successful() || !is_array($data) || ($data['generation'] ?? null) !== $generation
                || !is_int($data['position'] ?? null) || $data['position'] < $minimum
                || !is_string($data['text'] ?? null) || !is_bool($data['textPassed'] ?? null)
                || !is_array($data['marks'] ?? null) || !array_is_list($data['marks'])
                || array_filter($data['marks'], is_string(...)) !== $data['marks'] || !is_bool($data['marksPassed'] ?? null)) {
                continue;
            }

            return [
                'generation' => $generation, 'position' => $data['position'],
                'text' => $data['text'], 'textPassed' => $data['textPassed'], 'marks' => $data['marks'], 'marksPassed' => $data['marksPassed'],
            ];
        }

        return null;
    }
}
