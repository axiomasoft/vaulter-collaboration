<?php

declare(strict_types=1);

use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Vaulter\Collaboration\Tests\Collaboration\CollaborationEnabledTestCase;
use Vaulter\Collaboration\Tests\TestCase;
use Vaulter\Testing\Concerns\WithoutDatabaseSchema;
use Vaulter\Testing\Support\TestGroups;

// The hub protocol, the session and the room tokens run with the opt-in collaboration module ACTIVE: its routes are
// mounted and its driver is provided.
uses(CollaborationEnabledTestCase::class, RefreshDatabase::class)->in('Collaboration', 'Http', 'Operations', 'Doctor', 'Persistence', 'Console', 'Revocation', 'Document/CollaborationSessionTest.php');

// A restore drains a pending document only outside any transaction (PendingStateGuard): these migrate per test instead
// of wrapping it in one, which would hide the difference.
uses(CollaborationEnabledTestCase::class, DatabaseMigrations::class)->in('Restore');

// A managed drain waits for the hub outside any transaction and an uninstall rolls the migrations back: these
// migrate per test as well. The raw disable leaves the module off (its default) and drains nothing either.
uses(CollaborationEnabledTestCase::class, DatabaseMigrations::class)->in('Disable/ManagedDrainTest.php', 'Disable/UninstallGuardTest.php');
uses(TestCase::class, DatabaseMigrations::class)->in('Disable/RawDisableTest.php');

// PostgreSQL ForkRace scenarios: forked backends must see committed fixtures, so these migrate per test instead of
// wrapping it in a transaction.
uses(CollaborationEnabledTestCase::class, DatabaseMigrations::class)->in('Concurrency');

// The module in its default state (OFF) and in the states the activation matrix names; each test sets what it needs.
uses(TestCase::class, RefreshDatabase::class)->in('Document/CollaborationFeatureGateTest.php');

uses(TestCase::class)->in('Module');

// Registrar and configuration checks use a booted application without a schema.
uses(TestCase::class)->in('Configuration', 'Providers');
uses(WithoutDatabaseSchema::class)->in('Configuration', 'Providers');

// The shape checks read the booted route table of the active module.
uses(CollaborationEnabledTestCase::class, WithoutDatabaseSchema::class)->in('Arch');

// Test groups: database, serial, extended, stand and the engine-only engine:* — see groups.php.
TestGroups::bind(__DIR__, 'collaboration');
