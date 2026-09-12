"""One durable GPU queue with explicit recovery and lifetime ownership."""
import threading
import time

from .runtime import Cancelled, InputRejected, RuntimeFailure, gpu_status
from .resources import Lease, gpu_lease

TERMINAL = {'completed', 'cancelled', 'failed'}
RECOVERY_MESSAGE = 'Waiting for Studio to recover its previous creation tool. Check Docker access; saved requests will stay queued.'


class Worker:
    def __init__(self, store, runtime):
        self.store, self.runtime = store, runtime
        self.closed = threading.Event()
        self.thread = None
        self.lock = None
        self._lifecycle_lock = threading.RLock()
        self._diagnostic_lock = threading.Lock()
        self._worker_done = threading.Event()
        self._worker_done.set()
        self._stop_threads = {}
        self._recovery_needed = True
        self._next_recovery = 0
        self._recovery_failures = 0
        self._next_workflow = 0
        self._next_admission = 0
        self._warm_lease = None
        self.poll_seconds = .25
        self.recovery_retry_seconds = 1
        self.workflow_retry_seconds = 2
        self.admission_retry_seconds = 1
        self._diagnostic = dict(state='stopped', message='Creation queue is stopped.', updated_at=time.time(), workflow_error=None)

    def diagnostics(self):
        with self._diagnostic_lock:
            return {**self._diagnostic, 'recovery_pending': self._recovery_needed,
                    'thread_alive': bool(self.thread and self.thread.is_alive())}

    def _diagnose(self, state=None, message=None, **fields):
        with self._diagnostic_lock:
            values = {**fields}
            if state is not None:
                values['state'] = state
            if message is not None:
                values['message'] = message
            if any(self._diagnostic.get(key) != value for key, value in values.items()):
                self._diagnostic.update(values, updated_at=time.time())

    def _status(self, identity, state, message, **fields):
        # An unchanged waiting message must not write an event on every tick.
        current = self.store.job(identity)
        if current['state'] == state and current['message'] == message and all(current.get(key) == value for key, value in fields.items()):
            return
        self.store.status(identity, state, message, **fields)

    def _waiting(self, message):
        for job in self.store.rows("SELECT * FROM jobs WHERE state='queued'"):
            self._status(job['id'], 'queued', message)

    def _attempt_recovery(self):
        if not self._recovery_needed:
            return True
        if time.monotonic() < self._next_recovery:
            return False
        try:
            self._drop_warm()
            if hasattr(self.runtime, 'cleanup_owned'):
                # The adapter raises if ownership/release cannot be checked.
                if self.runtime.cleanup_owned() is False:
                    raise RuntimeFailure('Previous creation tools could not be recovered.')
            interrupted = self.store.rows("SELECT * FROM jobs WHERE state NOT IN ('completed','cancelled','failed','queued')")
            for job in interrupted:
                self.runtime.stop(job.get('container'))
            # Durable states change only after every required stop succeeded.
            for job in interrupted:
                self._status(job['id'], 'cancelled' if job['cancel'] else 'failed',
                             'Cancelled request recovered after Studio stopped.' if job['cancel'] else 'Interrupted when Studio closed. Your project is saved. Retry to start a new request.')
            self._recovery_needed = False
            self._recovery_failures = 0
            self._next_recovery = 0
            self._diagnose('idle', 'Creation queue is ready.')
            return True
        except Exception:
            self._recovery_needed = True
            self._recovery_failures += 1
            self._next_recovery = time.monotonic() + min(30, self.recovery_retry_seconds * 2**min(self._recovery_failures - 1, 5))
            self._diagnose('recovery_blocked', RECOVERY_MESSAGE)
            self._waiting(RECOVERY_MESSAGE)
            return False

    def start(self):
        with self._lifecycle_lock:
            if self.thread and self.thread.is_alive():
                return
            if self._stop_threads:
                raise RuntimeError('Studio is still stopping its previous creation tool.')
            self.lock = Lease(self.store.root / 'controller.lock')
            if not self.lock.acquire():
                raise RuntimeError('Studio is already running for this data directory.')
            self.closed.clear()
            self._worker_done.clear()
            self._recovery_needed = True
            self._next_recovery = 0
            try:
                self._attempt_recovery()
                self.thread = threading.Thread(target=self.loop, name='studio-gpu-queue', daemon=True)
                self.thread.start()
            except BaseException:
                self._worker_done.set()
                self.lock.close()
                raise

    def _release_controller(self):
        with self._lifecycle_lock:
            if self._worker_done.is_set() and not self._stop_threads and self.lock:
                self.lock.close()
                self._diagnose('stopped', 'Creation queue is stopped.')

    def close(self, timeout=35):
        self.closed.set()
        self._diagnose('stopping', 'Stopping Studio’s creation tool. Saved projects are safe.')
        for job in self.store.rows("SELECT * FROM jobs WHERE state NOT IN ('completed','cancelled','failed','queued')"):
            self.cancel(job['id'])
        deadline = time.monotonic() + max(0, timeout)
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=max(0, deadline - time.monotonic()))
        with self._lifecycle_lock:
            stopping = list(self._stop_threads.values())
        for thread in stopping:
            if thread is not threading.current_thread():
                thread.join(timeout=max(0, deadline - time.monotonic()))
        # A timed join is not evidence the runtime ended. Its final operation
        # retains and eventually releases the controller lease itself.
        self._release_controller()

    def cancel(self, identity):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM jobs WHERE id=?', (identity,)).fetchone()
            if row is None:
                raise ValueError('Request not found.')
            job = dict(row)
            if job['state'] in TERMINAL:
                return
            queued = job['state'] == 'queued'
            state = 'cancelled' if queued else 'cancelling'
            message = 'Request cancelled before starting.' if queued else 'Stopping the creation tool. Your saved work is safe.'
            now = time.time()
            if not job['cancel'] or job['state'] != state or job['message'] != message:
                db.execute('UPDATE jobs SET cancel=1,state=?,message=?,progress=NULL,updated=? WHERE id=?', (state, message, now, identity))
                db.execute('INSERT INTO job_events(job,state,message,progress,created) VALUES(?,?,?,?,?)', (identity, state, message, None, now))
        if not queued and job.get('container'):
            self._request_stop(identity, job['container'])

    def _request_stop(self, identity, container):
        with self._lifecycle_lock:
            if identity in self._stop_threads:
                return
            def stop():
                try:
                    self.runtime.stop(container)
                except Exception:
                    self._recovery_needed = True
                    self._next_recovery = 0
                    self._diagnose('recovery_blocked', 'Stopping the creation tool could not be confirmed. Studio will check recovery before running another request.')
                finally:
                    with self._lifecycle_lock:
                        self._stop_threads.pop(identity, None)
                    self._release_controller()
            thread = threading.Thread(target=stop, name='studio-stop-' + identity[:12], daemon=True)
            self._stop_threads[identity] = thread
            thread.start()

    def _tick_workflows(self):
        if not hasattr(self, 'workflows') or time.monotonic() < self._next_workflow:
            return
        try:
            self.workflows.tick()
            if hasattr(self, 'agents'): self.agents.tick()
            self._diagnose(workflow_error=None)
            self._next_workflow = 0
        except Exception as error:
            self._next_workflow = time.monotonic() + self.workflow_retry_seconds
            self._diagnose('workflow_error', 'A project workflow needs attention. Saved jobs are safe; Studio will retry the coordination step.', workflow_error=type(error).__name__)

    def _drop_warm(self):
        if self._warm_lease is not None:
            # Do not release the GPU lease until the exact owned runtime stopped.
            self.runtime.drop_warm()
            self._warm_lease.close()
            self._warm_lease=None

    def _run_job(self, job):
        if time.monotonic() < self._next_admission:
            return
        current = self.store.job(job['id'])
        if self.closed.is_set() or current['state'] != 'queued' or current['cancel']:
            return
        lease = self._warm_lease or gpu_lease()
        entered_runtime = False
        switching_runtime = False
        try:
            # A missing package or cancelled request must not evict a ready chat
            # model. Validate the next tool before paying the cost of switching.
            self.runtime.preflight(job['request'])
            if self.closed.is_set() or self.store.job(job['id'])['cancel']:
                return
            if self._warm_lease is not None and not self.runtime.warm_for(job['request']):
                switching_runtime = True
                self._drop_warm()
                switching_runtime = False
                lease = gpu_lease()
            reusing=self._warm_lease is not None
            if not reusing and not lease.acquire():
                self._status(job['id'], 'queued', 'Another Studio request is using the GPU.')
                self._next_admission = time.monotonic() + self.admission_retry_seconds
                return
            status = gpu_status()
            if status.get('supported') is False:
                raise RuntimeFailure(status['message'])
            if reusing and not self.runtime.warm_owns_gpu(status):
                self._drop_warm()
                reusing=False
                self._status(job['id'],'queued','Waiting for other GPU activity to finish.')
                return
            if not reusing and not status['available']:
                self._status(job['id'], 'queued', status['message'])
                self._next_admission = time.monotonic() + self.admission_retry_seconds
                return
            if self.closed.is_set() or self.store.job(job['id'])['cancel']:
                return
            self._status(job['id'], 'preparing', 'Preparing the creation tool. Your project is already saved.')
            # Shutdown can observe the job as queued immediately before this
            # write. Once preparation is visible, either this check or close's
            # active-job scan must request cancellation before runtime entry.
            if self.closed.is_set():
                self.cancel(job['id'])
                raise Cancelled()
            self._next_admission = 0
            self._diagnose('running', 'A creation request is running.')
            started = time.monotonic()
            entered_runtime = True
            kind, path, metadata = self.runtime.run(job)
            if self.store.job(job['id'])['cancel']:
                raise Cancelled()
            request = job['request']
            if kind=='meeting':
                from .meetings import Meetings
                Meetings(self.store.root).complete(request['meeting_id'],path,metadata)
                self._status(job['id'],'completed','Meeting transcript and notes saved locally.')
                return
            asset_name = 'MCP email assistance' if request.get('purpose') == 'mcp-assistance' else 'PaitonMail reply' if request.get('purpose') == 'mail-reply' else 'Agent result' if request.get('purpose') == 'agent-review' else 'Agent draft' if request.get('purpose') == 'agent-draft' else 'Website plan' if request.get('purpose') == 'website-plan' else 'Website page copy' if request.get('purpose') == 'website-page-copy' else 'Website artwork' if request.get('purpose') in ('website-artwork','website-section-artwork') else {'image': 'New image', 'video': 'Animated scene', 'text': 'Writing draft'}[kind]
            asset = self.store.add_asset(job['project'], kind, asset_name, path.read_bytes(), path.suffix,
                                         {**metadata, 'origin': 'generated', 'job': job['id'], 'request': request,
                                          'source_ids': [request['source']['id']] if request.get('source') else request.get('context_ids', []),
                                          'generation_seconds': time.monotonic() - started})
            self._status(job['id'], 'completed', 'Saved on this computer.', asset=asset['id'])
        except Cancelled:
            self._status(job['id'], 'cancelled', 'Request cancelled. Previous work is preserved.')
        except Exception as error:
            cancelled = self.store.job(job['id'])['cancel']
            message = str(error) if isinstance(error, (RuntimeFailure, ValueError)) else 'The local tool could not finish. Check installed packages and available memory, then retry.'
            self._status(job['id'], 'cancelled' if cancelled else 'failed', 'Request cancelled.' if cancelled else message)
            if (entered_runtime or switching_runtime) and not isinstance(error,InputRejected):
                self._recovery_needed = True
                self._next_recovery = 0
        finally:
            if hasattr(self.runtime,'warm_live') and self.runtime.warm_live():
                self._warm_lease=lease
            else:
                lease.close()
                self._warm_lease=None

    def loop(self):
        try:
            while not self.closed.wait(self.poll_seconds):
                try:
                    with self._lifecycle_lock:
                        stopping = bool(self._stop_threads)
                    if stopping:
                        continue
                    if not self._attempt_recovery():
                        self._waiting(RECOVERY_MESSAGE)
                        continue
                    if self._warm_lease is not None and self.runtime.warm_expired():self._drop_warm()
                    self._tick_workflows()
                    jobs = self.store.rows("SELECT * FROM jobs WHERE state='queued' ORDER BY created,id LIMIT 1")
                    if jobs:
                        self._run_job(jobs[0])
                    elif not self._diagnostic.get('workflow_error'):
                        self._diagnose('idle', 'Creation queue is ready.')
                except Exception:
                    self._diagnose('recovery_blocked', 'The queue could not update saved work. Studio will retry; check the data disk if this continues.')
                    self.closed.wait(self.recovery_retry_seconds)
        finally:
            while self._warm_lease is not None:
                try:self._drop_warm()
                except Exception:
                    self._diagnose('recovery_blocked','Waiting to confirm the local chat model stopped.')
                    time.sleep(1)
            self._worker_done.set()
            self._release_controller()
