<?php

declare(strict_types=1);

use Symfony\Component\Finder\Finder;

/*
 * The bypass this test forbids: collaboration changes the state documents own only through the
 * documents state contract (CollaborativeState). Its sources name no v_documents table, write no document row, and
 * neither the documents' state writer nor their store repository — without exception since the protocol 1 store
 * (vaulter.v1.collaboration.hub.store) is gone.
 */

/** @return array<string, string> path relative to src/ => contents */
function boundarySources(): array
{
    $root = dirname(__DIR__, 2).'/src';
    $files = [];
    foreach ((new Finder)->files()->in($root)->name('*.php') as $file) {
        // Code only: a docblock may name what the code must not do.
        $code = '';
        foreach (token_get_all($file->getContents()) as $token) {
            if (!is_array($token) || !in_array($token[0], [T_COMMENT, T_DOC_COMMENT], true)) {
                $code .= is_array($token) ? $token[1] : $token;
            }
        }
        $files[substr($file->getPathname(), strlen($root) + 1)] = $code;
    }
    ksort($files);

    return $files;
}

/** @return list<string> */
function boundaryOffenders(string $pattern): array
{
    $offenders = [];
    foreach (boundarySources() as $path => $contents) {
        if (preg_match($pattern, $contents) === 1) {
            $offenders[] = $path;
        }
    }

    return $offenders;
}

it('never names the documents table, except as the target of its own foreign keys', function (): void {
    expect(boundaryOffenders('/v_documents\b|(?<!->on\(\$this->helpers)->table\(\s*[\'"]documents[\'"]\s*\)/'))->toBe([]);
});

it('writes no document row through the documents model', function (): void {
    expect(boundaryOffenders('/\bDocument::(query|where|whereKey)\([^;]*->(update|delete|insert|forceFill|save|increment|decrement)\(/s'))->toBe([])
        ->and(boundaryOffenders('/\$(document|aggregate)\w*->(save|update|forceFill|delete)\(/i'))->toBe([]);
});

it('uses neither the documents state writer nor their store repository', function (): void {
    expect(boundaryOffenders('/\bDocumentStateWriter\b|\bDocumentStoreRepository\b|\bDocumentRevisionStoreRepository\b/'))->toBe([]);
});

it('has no full-state store: the hub store route and its action are gone', function (): void {
    expect(app('router')->has('vaulter.v1.collaboration.hub.store'))->toBeFalse()
        ->and(array_key_exists('Actions/PersistCollaborationStateAction.php', boundarySources()))->toBeFalse()
        ->and(array_key_exists('Http/Controllers/Collaboration/HubStoreController.php', boundarySources()))->toBeFalse();
});

it('changes the pending marker of a document only through the documents state contract', function (): void {
    expect(boundaryOffenders('/pending_generation|pending_through_seq/'))->toBe([])
        ->and(boundarySources()['Persistence/UpdateLog.php'])->toContain('->markPending(');
});
