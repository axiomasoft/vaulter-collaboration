<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\E2E;

use Illuminate\Foundation\Application;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use LogicException;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\Testing\Fixtures\FakeHostUserResolver;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Documents\Actions\Documents\CreateDocumentAction;
use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Documents\Models\Documents\Document;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;

/** Explicitly registered by the local Testbench stands. */
final class E2eServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        if (!$this->app->environment('local', 'testing')) {
            throw new LogicException('The collaboration test stand requires a local or testing environment.');
        }

        config([
            'vaulter.modules.collaboration' => true,
            'vaulter-drive.access.permission_driver' => 'database',
            'vaulter.ids.strategy' => 'bigint',
            'vaulter.routes.middleware.authenticated' => ['api', E2eActingAs::class],
            // The stand drives two hubs and bursts faster than the public API default.
            'vaulter.routes.rate_limits.public' => 6000,
            'vaulter-documents.revisions.checkpoint_interval_seconds' => 0,
        ]);
    }

    public function boot(): void
    {
        $this->app->booted(static function (Application $app): void {
            // Module boot installs the default resolver. Use the same test principal as the HTTP fixture.
            $app->bind(HostUserResolver::class, static fn (): FakeHostUserResolver => new FakeHostUserResolver(
                userType: AccessTestHelpers::user()->getMorphClass(),
            ));
            // A seed and a writer update suffice for the checkpoint tests.
            config(['vaulter-collaboration.compaction.trigger_updates' => 2]);
        });

        Route::get('/e2e/health', static fn () => response()->json(['status' => 'ok']));

        Route::get('/e2e/setup', static function () {
            $drive = DriveTestHelpers::drive(random_int(1, 2_000_000_000));
            $storage = $drive->model();
            $node = app(CreateDocumentAction::class)->execute(DocumentTestHelpers::context($storage), new CreateDocumentInput(
                storage: $storage,
                name: 'E2E Spec',
                content: DocumentTestHelpers::content('Hello from setup'),
                parent: DriveTestHelpers::model($drive->root()),
            ));
            AccessTestHelpers::grant($node, RoleRegistry::WRITER, subjectId: 1);
            AccessTestHelpers::grant($node, RoleRegistry::READER, subjectId: 2);
            $document = DocumentTestHelpers::document($node);

            return response()->json([
                'node_id' => (string) $node->getKey(),
                'drive_id' => (string) $node->drive_id,
                'first_revision_id' => (string) $document->current_revision_id,
                'writer_user' => 1,
                'viewer_user' => 2,
                'room' => app(CollaborationOptions::class)->room($node->drive_id, $node->getKey(), $document->collab_epoch),
            ]);
        });

        Route::get('/e2e/snapshot/{node}', static function (string $node) {
            $document = Document::query()->where('node_id', $node)->firstOrFail();
            $latest = $document->revisions()->with('syncState')->orderByDesc('number')->first();
            $size = $latest?->syncState?->collab_state_size;

            return response()->json([
                'node_id' => $node,
                'number' => $latest?->number,
                'collab_state_size' => $size,
                'has_state' => $size !== null && $size > 0,
            ]);
        });

        Route::get('/e2e/document/{node}', static function (string $node) {
            $document = Document::query()->with(['payload', 'syncState'])->where('node_id', $node)->firstOrFail();

            return response()->json([
                'node_id' => $node,
                'epoch' => $document->collab_epoch,
                'state_version' => $document->state_version,
                'collab_state_size' => $document->syncState?->collab_state_size,
                'content' => $document->payload?->content,
            ]);
        });
    }
}
