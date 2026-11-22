<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Support;

use Vaulter\Documents\Content\OpaqueContent;
use Vaulter\Documents\Content\OpaqueJsonCodec;
use Vaulter\Documents\Contracts\DocumentCodec;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Documents\Contracts\DocumentType;
use Vaulter\Documents\Contracts\UpgradesSchema;
use Vaulter\Documents\Data\Types\DocumentFeatures;
use Vaulter\Documents\Data\Types\DocumentViewer;

/** The next release of acme/kanban: schema 2 names every column's cards "items". */
final readonly class AcmeKanbanV2Type implements DocumentType, UpgradesSchema
{
    public function key(): string
    {
        return 'acme/kanban';
    }

    public function label(): string
    {
        return 'Kanban board';
    }

    public function schemaVersion(): int
    {
        return 2;
    }

    public function codec(): DocumentCodec
    {
        return new OpaqueJsonCodec(maxSizeBytes: 4096);
    }

    public function defaultContent(): DocumentContent
    {
        return OpaqueContent::fromArray(['columns' => []]);
    }

    public function viewer(): DocumentViewer
    {
        return new DocumentViewer(key: 'acme/kanban-board');
    }

    public function features(): DocumentFeatures
    {
        return new DocumentFeatures(editable: true, previewable: true, downloadable: false);
    }

    public function upgrade(array $content, int $fromVersion): array
    {
        if ($fromVersion >= 2 || !is_array($content['columns'] ?? null)) {
            return $content;
        }

        $columns = [];
        foreach ($content['columns'] as $column) {
            if (is_array($column) && array_key_exists('cards', $column)) {
                $column['items'] = $column['cards'];
                unset($column['cards']);
            }
            $columns[] = $column;
        }
        $content['columns'] = $columns;

        return $content;
    }
}
