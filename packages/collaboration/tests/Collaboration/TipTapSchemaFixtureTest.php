<?php

declare(strict_types=1);

use Vaulter\Documents\Content\TipTap\TipTapSchema;
use Vaulter\Documents\Types\MarkdownDocumentType;
use Vaulter\Documents\Types\RichTextDocumentType;

/**
 * The hub seeds rooms from JSON with its own TipTap extensions
 * (packages/collaboration/hub/src/schema.js). A node, mark or attribute the hub does not know is dropped
 * from the seed, and one the backend does not allow makes every store fail, so both
 * sides are pinned to one snapshot: this test owns tests/Fixtures/tiptap-schema.json,
 * packages/collaboration/hub/test/schema-parity.test.js compares schema.js against it.
 *
 * After an intended schema change: VAULTER_REGENERATE_FIXTURES=1 regenerates the file.
 */
it('pins the TipTap nodes, marks and attributes of the collaborative types in the shared fixture', function (): void {
    $snapshot = static function (TipTapSchema $schema): array {
        $nodes = $schema->nodeTypes();
        $marks = $schema->markTypes();
        sort($nodes);
        sort($marks);

        // Attribute sets: toJSON() dumps every attribute an extension declares (nulls
        // included), so the hub's projection is only storable if the allow-list has them all.
        $attributes = [];
        foreach ([...$nodes, ...$marks] as $type) {
            $allowed = $schema->attributes($type);
            sort($allowed);

            if ($allowed !== []) {
                $attributes[$type] = $allowed;
            }
        }
        ksort($attributes);

        return ['nodes' => $nodes, 'marks' => $marks, 'attributes' => $attributes];
    };
    $expected = json_encode([
        MarkdownDocumentType::KEY => $snapshot(TipTapSchema::markdown()),
        RichTextDocumentType::KEY => $snapshot(TipTapSchema::richText()),
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)."\n";
    $path = __DIR__.'/../Fixtures/tiptap-schema.json';

    if (getenv('VAULTER_REGENERATE_FIXTURES') === '1') {
        file_put_contents($path, $expected);
    }

    expect(file_get_contents($path))->toBe($expected);
});
