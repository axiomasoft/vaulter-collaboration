<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests;

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Foundation\Application;
use Orchestra\Testbench\TestCase as OrchestraTestCase;
use Vaulter\Collaboration\Tests\Support\ValidateReleaseOpenApiResponses;
use Vaulter\Collaboration\VaulterCollaborationServiceProvider;
use Vaulter\Documents\VaulterDocumentsServiceProvider;
use Vaulter\Drive\VaulterDriveServiceProvider;
use Vaulter\Media\VaulterMediaServiceProvider;
use Vaulter\Testing\Concerns\RefreshesDatabaseForSchemaVariant;
use Vaulter\Testing\Concerns\UsesSuiteDatabase;
use Vaulter\Testing\Support\OpenApi\ValidatesOpenApiResponses;
use Vaulter\VaulterServiceProvider;

/**
 * Boots the kernel, the CAS engine, the drive, the documents and the collaboration package. The collaboration module
 * is opt-in and stays off here, as it does in a host that did not switch it on; the tests that exercise the
 * module use {@see Collaboration\CollaborationEnabledTestCase}.
 */
abstract class TestCase extends OrchestraTestCase
{
    use RefreshesDatabaseForSchemaVariant;
    use UsesSuiteDatabase;
    use ValidatesOpenApiResponses;

    /**
     * @param  Application              $app
     * @return array<int, class-string>
     */
    protected function getPackageProviders($app): array
    {
        return [
            VaulterServiceProvider::class,
            // The drive module is what documents require, and the drive needs the CAS engine of the media package.
            VaulterMediaServiceProvider::class,
            VaulterDriveServiceProvider::class,
            VaulterDocumentsServiceProvider::class,
            VaulterCollaborationServiceProvider::class,
        ];
    }

    /**
     * @param Application $app
     */
    /** @var array<string, mixed> */
    public static array $configOverrides = [];

    public static ?string $environmentOverride = null;

    protected function defineEnvironment($app): void
    {
        if ((string) env('VAULTER_OPENAPI_VALIDATE') === '1') {
            $app->make(Kernel::class)->pushMiddleware(ValidateReleaseOpenApiResponses::class);
        }

        $this->pinSuiteConnection($app);
        $this->pinOpenSuite($app);
        $app['config']->set('vaulter-drive.access.permission_driver', 'null');

        // A whole-application scenario (CollaborationBootMatrixTest) sets these before refreshing the application; empty otherwise.
        foreach (self::$configOverrides as $key => $value) {
            $app['config']->set($key, $value);
        }
        if (self::$environmentOverride !== null) {
            $environment = self::$environmentOverride;
            // Testbench pins `testing` after this hook; production guards read the environment only when they run.
            $app->booting(static function () use ($app, $environment): void {
                $app['env'] = $environment;
            });
        }
    }

    protected function defineDatabaseMigrations(): void
    {
        $this->migrateSuiteDatabase();
    }
}
