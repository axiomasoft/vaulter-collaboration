<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Support;

use Illuminate\Testing\TestResponse;
use RuntimeException;
use Vaulter\Drive\Testing\Http\V1;

/** Fixtures of the collaboration REST v1 suite on top of the core V1 helpers; every call runs as the test's acting user. */
final class DocumentsV1
{
    public static function url(string $path): string
    {
        return V1::url($path);
    }

    /** A TipTap document with one paragraph. @return array<string, mixed> */
    public static function doc(string $text = 'Hello'): array
    {
        return ['type' => 'doc', 'content' => [['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => $text]]]]];
    }

    /** The tag the caller reads for a document's content. */
    public static function etag(string $nodeId): string
    {
        $etag = test()->getJson(self::url('documents/'.$nodeId.'/content'))->assertOk()->headers->get('ETag');

        return is_string($etag) ? $etag : throw new RuntimeException('No ETag on documents.content.show');
    }

    /** @return array{If-Match: string} */
    public static function ifMatch(string $nodeId): array
    {
        return ['If-Match' => self::etag($nodeId)];
    }

    /**
     * PUT a document's content with the tag the caller currently reads (or $etag).
     *
     * @param array<string, mixed> $content
     */
    public static function put(string $nodeId, array $content, ?string $etag = null): TestResponse
    {
        return test()->putJson(self::url('documents/'.$nodeId.'/content'), ['content' => $content], ['If-Match' => $etag ?? self::etag($nodeId)]);
    }
}
