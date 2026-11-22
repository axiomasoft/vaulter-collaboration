<?php

declare(strict_types=1);

/*
 * The machine map of the scenarios (collaboration#tests 1-20): packages/collaboration/tests/i17-scenarios.json says,
 * for each scenario, which lanes carry it and which files hold it. Paths are relative to packages/collaboration; a file of
 * another package is named from the monorepo root (packages/<name>/...) and is checked only where that root exists (not in
 * the clean-consumer copy of this package, which has no sibling tests). The test reads that map and the file system
 * only. It cannot run the scenarios; it keeps the map from drifting away from the files: none may be missing, every lane
 * must have a file of its kind, and the three scenarios that need real processes (2, 3, 10, docker stand) have their
 * file under hub/test/stand.
 */

const I17_STAND_SCENARIOS = [2, 3, 10];

/** The lane => a file of the kind the lane runs, as a regular expression over the path relative to packages/collaboration. */
const I17_LANE_FILES = [
    'php' => '#^(tests|packages/documents/tests)/.+Test\.php$#',
    'serial' => '#^tests/Concurrency/.+RaceTest\.php$#',
    'node' => '#^hub/test/[^/]+\.test\.js$#',
    'vitest' => '#^packages/vue-collaboration/tests/.+\.test\.ts$#',
    'stand' => '#^hub/test/stand/[^/]+\.stand\.js$#',
];

/** @return array<string, array{lanes: list<string>, files: list<string>}> */
function i17Map(): array
{
    $map = json_decode((string) file_get_contents(dirname(__DIR__).'/i17-scenarios.json'), true, flags: JSON_THROW_ON_ERROR);

    return is_array($map) ? $map : [];
}

it('maps exactly the scenarios 1 to 20', function (): void {
    $keys = array_map(strval(...), array_keys(i17Map()));
    sort($keys, SORT_NUMERIC);

    expect($keys)->toBe(array_map(strval(...), range(1, 20)));
});

it('gives every scenario known lanes and files, each file existing', function (): void {
    $root = dirname(__DIR__, 2);
    $monorepo = dirname($root, 2);
    $inMonorepo = is_file($monorepo.'/release/packages.json');

    foreach (i17Map() as $number => $entry) {
        expect($entry['lanes'] ?? null)->toBeArray()->not->toBeEmpty("scenario $number has lanes")
            ->and($entry['files'] ?? null)->toBeArray()->not->toBeEmpty("scenario $number has files");
        expect(array_diff($entry['lanes'], array_keys(I17_LANE_FILES)))->toBe([], "scenario $number names an unknown lane");
        expect(array_unique($entry['lanes']))->toHaveCount(count($entry['lanes']), "scenario $number repeats a lane");
        expect(array_unique($entry['files']))->toHaveCount(count($entry['files']), "scenario $number repeats a file");

        foreach ($entry['files'] as $file) {
            $path = str_starts_with($file, 'packages/') ? $monorepo.'/'.$file : $root.'/'.$file;

            if (str_starts_with($file, 'packages/') && !$inMonorepo) {
                continue;
            }

            expect(is_file($path))->toBeTrue("scenario $number: $file does not exist");
        }
    }
});

it('holds, for every lane of a scenario, a file of that lane\'s kind', function (): void {
    foreach (i17Map() as $number => $entry) {
        foreach ($entry['lanes'] as $lane) {
            $matching = array_filter($entry['files'], static fn (string $file): bool => preg_match(I17_LANE_FILES[$lane], $file) === 1);

            expect($matching)->not->toBe([], "scenario $number: lane $lane has no file of its kind");
        }
    }
});

it('puts the stand scenarios 2, 3 and 10 in hub/test/stand, and no other scenario on the stand lane', function (): void {
    $map = i17Map();
    $onStand = [];

    foreach ($map as $number => $entry) {
        if (in_array('stand', $entry['lanes'], true)) {
            $onStand[] = (int) $number;
        }
    }
    sort($onStand);

    expect($onStand)->toBe(I17_STAND_SCENARIOS);

    foreach (I17_STAND_SCENARIOS as $number) {
        $standFiles = array_filter($map[(string) $number]['files'], static fn (string $file): bool => str_starts_with($file, 'hub/test/stand/'));

        expect($standFiles)->not->toBe([], "scenario $number needs a file in hub/test/stand");
    }
});

it('leaves no stand file outside the map', function (): void {
    $mapped = [];
    foreach (i17Map() as $entry) {
        foreach ($entry['files'] as $file) {
            $mapped[$file] = true;
        }
    }

    $files = array_map(
        static fn (string $path): string => 'hub/test/stand/'.basename($path),
        glob(dirname(__DIR__, 2).'/hub/test/stand/*.stand.js') ?: [],
    );

    expect($files)->not->toBe([]);
    foreach ($files as $file) {
        expect($mapped)->toHaveKey($file);
    }
});
