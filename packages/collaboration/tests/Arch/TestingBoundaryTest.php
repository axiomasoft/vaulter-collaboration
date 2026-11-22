<?php

declare(strict_types=1);

// The Testing namespaces ship in the package for hosts' test suites; production code
// must never depend on them, or a test double would reach a running application.
// One expectation per production namespace: Pest's ignoring() drops matching
// dependencies as well, and a list of subjects is not checked one by one, so
// either would let a production class use a Testing one unseen.
foreach (glob(dirname(__DIR__, 2).'/src/*') ?: [] as $path) {
    $name = basename($path, '.php');
    if ($name !== 'Testing') {
        $subject = 'Vaulter\\Collaboration\\'.$name;
        arch("{$subject} never uses the Testing namespaces")
            ->expect($subject)
            ->not->toUse(['Vaulter\Testing', 'Vaulter\Drive\Testing', 'Vaulter\Documents\Testing', 'Vaulter\Collaboration\Testing', 'Vaulter\Media\Testing']);
    }
}
