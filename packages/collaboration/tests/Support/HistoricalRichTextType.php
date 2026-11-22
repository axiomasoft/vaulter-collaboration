<?php

declare(strict_types=1);

namespace Vaulter\Documents\Fixtures;

use Vaulter\Documents\Content\OpaqueContent;
use Vaulter\Documents\Contracts\DocumentCodec;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Documents\Contracts\DocumentType;
use Vaulter\Documents\Contracts\SupportsCollaboration;
use Vaulter\Documents\Data\Types\DocumentFeatures;
use Vaulter\Documents\Data\Types\DocumentViewer;
use Vaulter\Documents\Exceptions\InvalidDocumentContentException;

/** Test-only next first-party implementation; stored schema1 decoding is deliberately strict. */
final class HistoricalRichTextType implements DocumentType, SupportsCollaboration
{
    public int $version = 1;

    public string $format = 'yjs-update-v1';

    public function key(): string
    {
        return 'vaulter/rich-text';
    }

    public function label(): string
    {
        return 'Yjs fixture';
    }

    public function schemaVersion(): int
    {
        return $this->version;
    }

    public function codec(): DocumentCodec
    {
        return new class implements DocumentCodec
        {
            public function decode(array $raw, int $schemaVersion): DocumentContent
            {
                if ($schemaVersion !== 1) {
                    throw InvalidDocumentContentException::missingDocNode();
                }

                return OpaqueContent::fromArray($raw);
            }

            public function maxSizeBytes(): ?int
            {
                return null;
            }
        };
    }

    public function defaultContent(): DocumentContent
    {
        return OpaqueContent::fromArray(['columns' => []]);
    }

    public function viewer(): DocumentViewer
    {
        return new DocumentViewer('acme/yjs-viewer');
    }

    public function features(): DocumentFeatures
    {
        return new DocumentFeatures(editable: true, previewable: true, downloadable: false);
    }

    public function collaborationProtocol(): string
    {
        return 'yjs';
    }

    public function collaborationStateFormat(): string
    {
        return $this->format;
    }

    public function projectFromState(string $state): ?DocumentContent
    {
        return null;
    }
}
