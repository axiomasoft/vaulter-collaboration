<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Documents\Events\Documents\DocumentContentUpdated;
use Vaulter\Documents\Events\Revisions\DocumentRestored;
use Vaulter\Events\DomainEvent;
use Vaulter\Events\EventSink;
use Vaulter\Events\SinkResult;
use Vaulter\Events\SinkWriter;

/**
 * Closes the log of a generation a restore or a REST replace left (`collaboration.generations`, an event sink): in the
 * transaction of the documents event that moved the document's generation on, under the document lock that write
 * holds, every open head of an earlier generation gets retired_at. From then on that generation refuses appends,
 * leases and checkpoints, and its rows wait for the prune.
 *
 * The documents' own writes record the events; a generation the document left while this module was off is retired
 * by the prune instead. The sink keeps nothing of the event itself: it answers Skipped.
 */
#[Internal]
final readonly class GenerationCloser implements EventSink
{
    public function __construct(private DatabaseOptions $tables) {}

    public function record(DomainEvent $event, SinkWriter $writer): SinkResult
    {
        if ($event instanceof DocumentRestored || $event instanceof DocumentContentUpdated) {
            $now = Carbon::now();
            $writer->connection()->table($this->tables->table('collaboration_heads'))
                ->where('document_id', $event->documentId())
                ->where('generation', '<', $event->epoch)
                ->whereNull('retired_at')
                ->update(['retired_at' => $now, 'updated_at' => $now]);
        }

        return SinkResult::Skipped;
    }
}
