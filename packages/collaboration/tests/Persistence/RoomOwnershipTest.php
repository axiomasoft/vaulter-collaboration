<?php

declare(strict_types=1);

use Vaulter\Collaboration\Persistence\CompactionLeases;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\Data\Collaboration\CollaborationGrant;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Data\Collaboration\CollaborationSession;
use Vaulter\Documents\Exceptions\CollaborationUnavailableException;
use Vaulter\Documents\Fixtures\HistoricalRichTextType;
use Vaulter\Documents\Types\DocumentTypeRegistry;
use Vaulter\Kernel;
use Vaulter\Modules\CompiledModules;
use Vaulter\Modules\SlotContribution;

it('shares the journal and checkpoint path with a second driver while isolating its leases', function (): void {
    require_once __DIR__.'/../Support/HistoricalRichTextType.php';
    Hub::configure();
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $type = new HistoricalRichTextType;
    $type->protocol = 'univer-sheets';
    $type->format = 'sheets-update-v1';
    $registry = new DocumentTypeRegistry(app());
    $registry->register($type);
    $registry->freeze();
    app()->instance(DocumentTypeRegistry::class, $registry);

    $driver = new class implements CollaborationProtocolDriver
    {
        public function protocol(): string
        {
            return 'univer-sheets';
        }

        public function version(): string
        {
            return 'univer-sheets/1';
        }

        public function supportsState(string $documentType, string $stateFormat, int $schemaVersion, bool $hasCheckpoint, CollaborationMode $mode): bool
        {
            return $documentType === 'vaulter/rich-text' && $stateFormat === 'sheets-update-v1' && $schemaVersion === 1;
        }

        public function issueSession(CollaborationGrant $grant): CollaborationSession
        {
            throw new LogicException('This fixture exercises the journal directly.');
        }
    };
    $compiled = app(Kernel::class)->compiled();
    $contributions = $compiled->contributions;
    $contributions[CollaborationProtocolDriver::class][] = new SlotContribution(
        CollaborationProtocolDriver::class, 'test.sheets.protocol', 'collaboration', $driver::class, key: 'univer-sheets',
    );
    $kernel = new Kernel(app());
    $kernel->seal(new CompiledModules(...array_replace(get_object_vars($compiled), ['contributions' => $contributions])));
    app()->instance(Kernel::class, $kernel);

    $node = Hub::document(content: $type->defaultContent());
    $committed = Compaction::append($node, 'sheets-seed');
    $leases = app(CompactionLeases::class);
    expect(Compaction::head($node)?->protocol)->toBe('univer-sheets/1')
        ->and($leases->grant('yjs-worker', 1))->toBe([])
        ->and($leases->grant('other-version', 1, 'univer-sheets/2'))->toBe([]);
    [$lease] = $leases->grant('sheets-worker', 1, 'univer-sheets/1');
    expect($lease->protocol)->toBe('univer-sheets/1');
    Compaction::publish($lease, overrides: ['content' => ['columns' => []]]);
    $journal = app(UpdateLog::class);
    expect($journal->snapshot($node->getKey(), $committed->generation)->checkpoint)->toBe('sheets-seed');

    $type->protocol = 'yjs';
    expect(fn () => $journal->snapshot($node->getKey(), $committed->generation))->toThrow(CollaborationUnavailableException::class);
});
