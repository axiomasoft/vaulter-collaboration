<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\E2E;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;

final class E2eActingAs
{
    public function handle(Request $request, Closure $next): Response
    {
        $id = $request->header('X-E2E-User');
        if ($id === '1' || $id === '2') {
            $user = AccessTestHelpers::user((int) $id);
            Auth::setUser($user);
            $request->setUserResolver(static fn () => $user);
        }

        return $next($request);
    }
}
