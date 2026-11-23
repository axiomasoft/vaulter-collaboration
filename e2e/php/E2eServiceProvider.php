<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\E2E;

use Illuminate\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Str;
use LogicException;
use Vaulter\Ai\Core\Contracts\Office;
use Vaulter\Ai\Core\Data\CallContext as OfficeContext;
use Vaulter\Ai\Core\Data\OfficeRequest;
use Vaulter\Ai\Core\Enums\OfficeOperation;
use Vaulter\Ai\Core\OfficeServiceProvider;
use Vaulter\Ai\Documents\Contracts\DocumentScopeResolver;
use Vaulter\Ai\Documents\DocumentsAiServiceProvider;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\Persistence\CommandActor;
use Vaulter\Collaboration\Persistence\CommandJournal;
use Vaulter\Collaboration\Persistence\CompactionLeases;
use Vaulter\Collaboration\Persistence\LogTables;
use Vaulter\Collaboration\Testing\Fixtures\FakeHostUserResolver;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Documents\Actions\Documents\CreateDocumentAction;
use Vaulter\Documents\Content\TipTap\TipTapContent;
use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Documents\Models\Documents\Document;
use Vaulter\Documents\State\PendingMarker;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Exceptions\Contracts\ProblemException;
use Vaulter\ValueObjects\Access\Actor;

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
        // The strict stand can load the sibling Office packages to exercise the real SDK.
        $office = $_SERVER['VAULTER_E2E_OFFICE_PATH'] ?? $_ENV['VAULTER_E2E_OFFICE_PATH'] ?? null;
        if (is_string($office) && is_dir($office.'/packages/core/src')) {
            $loader = require dirname(__DIR__, 2).'/vendor/autoload.php';
            $loader->addPsr4('Vaulter\\Ai\\Core\\', $office.'/packages/core/src');
            $loader->addPsr4('Vaulter\\Ai\\Documents\\', $office.'/packages/documents/src');
            $this->app->register(OfficeServiceProvider::class);
            $this->app->register(DocumentsAiServiceProvider::class);
            config([
                'vaulter-ai.profiles.documents.approval' => 'automatic',
                'vaulter-ai-documents.projection.auto_index' => false,
            ]);
        }
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

        if ($this->app->bound(Office::class)) {
            Route::post('/e2e/office/{drive}/{operation}', static function (Request $request, string $drive, string $operation) {
                $body = json_decode($request->getContent(), flags: JSON_THROW_ON_ERROR);
                $storage = Vaulter::findDriveById($drive)?->snapshot();
                abort_if($storage === null, 404);
                $scope = app(DocumentScopeResolver::class)->forDriveEvent($storage->tenantId, $drive);
                $office = app(Office::class)->handle(
                    new OfficeContext((string) $scope['tenant_id'], $scope['project_scope'], 'user-1', driveId: $drive, actor: AccessTestHelpers::user()),
                    new OfficeRequest(1, OfficeOperation::from($operation), $body),
                );

                return response()->json($office->toStdClass());
            });
        }

        Route::get('/e2e/setup', static function (Request $request) {
            $drive = DriveTestHelpers::drive(random_int(1, 2_000_000_000));
            $storage = $drive->model();
            $padding = (int) $request->query('padding', 0);
            abort_if($padding < 0 || $padding > 512000, 422);
            $blocks = [
                ['type' => 'paragraph', 'attrs' => ['blockId' => 'payment-terms'], 'content' => [
                    ['type' => 'text', 'text' => 'Аванс в течение 15 дней'],
                ]],
                ['type' => 'paragraph', 'attrs' => ['blockId' => 'bank'], 'content' => [
                    ['type' => 'text', 'text' => 'Банк А'],
                ]],
            ];
            for ($offset = 0; $offset < $padding; $offset += 2048) {
                $blocks[] = ['type' => 'paragraph', 'attrs' => ['blockId' => 'padding-'.$offset], 'content' => [
                    ['type' => 'text', 'text' => str_repeat('x', min(2048, $padding - $offset))],
                ]];
            }
            $node = app(CreateDocumentAction::class)->execute(DocumentTestHelpers::context($storage), new CreateDocumentInput(
                storage: $storage,
                name: 'E2E Spec',
                content: $request->query('scenario') === 'A42'
                    ? TipTapContent::fromArray(['type' => 'doc', 'content' => $blocks])
                    : DocumentTestHelpers::content('Hello from setup'),
                parent: DriveTestHelpers::model($drive->root()),
            ));
            $writer = AccessTestHelpers::grant($node, RoleRegistry::WRITER, subjectId: 1);
            AccessTestHelpers::grant($node, RoleRegistry::READER, subjectId: 2);
            AccessTestHelpers::grant($node, RoleRegistry::WRITER, subjectId: 3);
            DriveTestHelpers::actor($drive, 4);
            $document = DocumentTestHelpers::document($node);

            return response()->json([
                'node_id' => (string) $node->getKey(),
                'drive_id' => (string) $node->drive_id,
                'first_revision_id' => (string) $document->current_revision_id,
                'writer_user' => 1,
                'viewer_user' => 2,
                'second_writer_user' => 3,
                'owner_user' => 4,
                'writer_grant_id' => (string) $writer->getKey(),
            ]);
        });

        Route::post('/e2e/document/{node}/command', static function (Request $request, string $node) {
            abort_unless(config('vaulter-collaboration.strict_profile') === true, 404);
            $document = Document::query()->where('node_id', $node)->firstOrFail();
            $nodeModel = DriveTestHelpers::model($node);
            $commandId = $request->input('command', 'A42');
            $replacement = $request->input('replacement', '30');
            $expected = $request->input('expected', '15');
            $scope = new CommandActor(Actor::user(AccessTestHelpers::user())->ref(), null, 'A42', 'user-1',
                (string) $nodeModel->drive_id, $node);
            try {
                $registered = app(CommandJournal::class)->register(
                    $scope, $commandId, $request->input('proposal', (string) Str::uuid()), hash('sha256', $expected.':'.$replacement),
                    $document->collab_epoch, $document->schema_version, $request->input('position', 0), [
                        'preconditions' => [['block_id' => 'payment-terms', 'expected_text' => 'Аванс в течение '.$expected.' дней', 'expected_marks' => []]],
                        'atomic_effects' => [
                            ['effect' => 'replace_exact', 'block_id' => 'payment-terms', 'expected' => $expected, 'replacement' => $replacement],
                            ['effect' => 'insert_paragraph_after', 'block_id' => 'payment-terms', 'text' => 'Основание: решение финансового директора'],
                        ],
                    ],
                );
            } catch (ProblemException $failure) {
                return response()->json(['code' => $failure->problemCode(), 'meta' => $failure->problemDetails()], $failure->httpStatus());
            }

            return response()->json($registered);
        });

        Route::get('/e2e/document/{node}/command/{command}', static function (string $node, string $command) {
            abort_unless(config('vaulter-collaboration.strict_profile') === true, 404);
            $nodeModel = DriveTestHelpers::model($node);
            $scope = new CommandActor(Actor::user(AccessTestHelpers::user())->ref(), null, 'A42', 'user-1',
                (string) $nodeModel->drive_id, $node);

            return response()->json(app(CommandJournal::class)->status($scope, $command));
        });

        Route::post('/e2e/document/{node}/revoke/{grant}', static function (string $node, string $grant) {
            $model = DriveTestHelpers::model($node);
            Vaulter::drive($model->storage()->firstOrFail())
                ->actingAs(AccessTestHelpers::user(4))
                ->access()->revoke($node, $grant);

            return response()->noContent();
        });

        Route::get('/e2e/document/{node}/journal', static function (string $node) {
            $document = Document::query()->where('node_id', $node)->firstOrFail();
            $id = (string) $document->getKey();
            $generation = $document->collab_epoch;
            $log = app(LogTables::class);

            return response()->json([
                'generation' => $generation,
                'head_seq' => $log->rows('collaboration_heads', $id, $generation)->value('head_seq'),
                'checkpoint_seq' => $log->rows('collaboration_heads', $id, $generation)->value('checkpoint_seq'),
                'profile' => $log->rows('collaboration_heads', $id, $generation)->value('profile'),
                'owner_fence' => $log->rows('collaboration_heads', $id, $generation)->value('owner_fence'),
                'pending_through_seq' => $document->syncState?->pending_through_seq,
                'receipts' => $log->rows('collaboration_receipts', $id, $generation)->orderBy('seq')->get(['update_id', 'seq', 'sha256']),
            ]);
        });

        Route::post('/e2e/document/{node}/drain', static function (string $node) {
            $document = Document::query()->with('syncState')->where('node_id', $node)->firstOrFail();
            $binding = $document->collaborationBinding();
            $through = $document->syncState?->pending_through_seq;
            abort_if($binding === null || $through === null, 409);
            $requested = app(CompactionLeases::class)->requestDrain(new PendingMarker(
                documentId: (string) $document->getKey(),
                nodeId: $node,
                binding: $binding,
                throughSeq: $through,
            ));
            abort_unless($requested, 409);

            return response()->noContent();
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
