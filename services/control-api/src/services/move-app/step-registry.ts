import type { StepHandlerMap } from './saga-executor.js';
import { executeReserveDest } from './step-reserve-dest.js';
import { executeBlockWrites } from './step-block-writes.js';
import { executeDumpData } from './step-dump-data.js';
import { executeRestoreData } from './step-restore-data.js';
import { executeDumpKv } from './step-dump-kv.js';
// restoring_kv: registered in Task 6
import { executeCopyBlobs } from './step-copy-blobs.js';
import { executeCopyRuntime } from './step-copy-runtime.js';
import { executeFlipRouting } from './step-flip-routing.js';
import { executeReverseReplication } from './step-reverse-replication.js';
import { executeUnblockWrites } from './step-unblock-writes.js';
import { executeAbort } from './step-abort.js';

export const stepHandlers: StepHandlerMap = {
  aborting: executeAbort,
  requested: async () => ({ next: 'reserving_dest', patch: {} }),
  reserving_dest: executeReserveDest,
  blocking_writes: executeBlockWrites,
  dumping_data: executeDumpData,
  restoring_data: executeRestoreData,
  dumping_kv: executeDumpKv,
  // restoring_kv: executeRestoreKv,  // TODO: Task 6
  copying_blobs: executeCopyBlobs,
  copying_runtime: executeCopyRuntime,
  flipping_routing: executeFlipRouting,
  setting_up_reverse_replication: executeReverseReplication,
  unblocking_writes: executeUnblockWrites,
};
