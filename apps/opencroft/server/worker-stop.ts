// The dev server runs the app in a worker thread and replaces that worker when
// it restarts. No signal reaches a worker thread, so the dev server asks the
// outgoing worker to stop with the first message, and the worker answers with
// the second once its database is released.
//
// Kept free of imports: the dev server's config loads this file, and it must
// not open the database the worker is about to be asked to release.

export const WORKER_STOP_REQUEST = 'opencroft:worker-stop'
export const WORKER_STOPPED = 'opencroft:worker-stopped'
