"""Local-owner browser pairing; persistent grants contain only token hashes."""
import hashlib
import ipaddress
import secrets
import threading
import time
from .store import uid

PAIR_SECONDS = 600
SESSION_SECONDS = 30 * 24 * 60 * 60


def local_peer(peer, headers=None):
    # Never turn forwarded browser input into local-owner authority. The server
    # entry point also disables Uvicorn's proxy-header address rewriting.
    if any(name in (headers or {}) for name in ('forwarded', 'x-forwarded-for', 'x-real-ip')):
        return False
    try:
        address = ipaddress.ip_address(peer or '')
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return address.is_loopback
    except ValueError:
        return False


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


class Pairing:
    def __init__(self, store, clock=time.time):
        self.store, self.clock = store, clock
        self.lock = threading.RLock()
        self.attempts = {}
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS browser_network(
                    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL,
                    pair_hash TEXT NOT NULL DEFAULT '', pair_expires REAL NOT NULL DEFAULT 0);
                INSERT OR IGNORE INTO browser_network(id,enabled) VALUES(1,0);
                CREATE TABLE IF NOT EXISTS browser_grants(
                    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                    created REAL NOT NULL, expires REAL NOT NULL);
            ''')

    def snapshot(self):
        with self.store.connect() as db:
            row = db.execute('SELECT enabled,pair_expires FROM browser_network WHERE id=1').fetchone()
            devices = [dict(item) for item in db.execute(
                'SELECT id,name,created,expires FROM browser_grants WHERE expires>? ORDER BY created', (self.clock(),))]
        return dict(enabled=bool(row['enabled']), devices=devices,
                    pairing_expires=row['pair_expires'] if row['pair_expires'] > self.clock() else None)

    def configure(self, enabled):
        with self.lock, self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('UPDATE browser_network SET enabled=?,pair_hash=?,pair_expires=0 WHERE id=1', (int(enabled), ''))
            if not enabled:
                db.execute('DELETE FROM browser_grants')
        return self.new_code() if enabled else self.snapshot()

    def new_code(self):
        token = secrets.token_urlsafe(18)
        with self.lock, self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT enabled FROM browser_network WHERE id=1').fetchone()
            if not row['enabled']:
                raise ValueError('Allow network devices before creating a pairing token.')
            db.execute('UPDATE browser_network SET pair_hash=?,pair_expires=? WHERE id=1',
                       (digest(token), self.clock() + PAIR_SECONDS))
        return {**self.snapshot(), 'pairing_token': token}

    def pair(self, token, name, peer):
        if not isinstance(token, str) or not 20 <= len(token) <= 128:
            token = ''
        with self.lock:
            now = self.clock()
            self.attempts = {key: value for key, value in self.attempts.items() if value[0] > now - 60}
            first, count = self.attempts.get(peer, (now, 0))
            if count >= 10 or (peer not in self.attempts and len(self.attempts) >= 256):
                raise ValueError('Too many pairing attempts. Wait a minute, then try again.')
            self.attempts[peer] = (first, count + 1)
            with self.store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                now = self.clock()
                row = db.execute('SELECT * FROM browser_network WHERE id=1').fetchone()
                if (not row['enabled'] or row['pair_expires'] <= now or not row['pair_hash']
                    or not secrets.compare_digest(row['pair_hash'], digest(token))):
                    raise ValueError('The pairing token is invalid or expired. Create a new token on the Studio host.')
                db.execute('DELETE FROM browser_grants WHERE expires<=?', (now,))
                if db.execute('SELECT count(*) FROM browser_grants').fetchone()[0] >= 100:
                    raise ValueError('Remove an old paired device before adding another.')
                session = secrets.token_urlsafe(32)
                db.execute('INSERT INTO browser_grants VALUES(?,?,?,?,?)',
                           (uid(), digest(session), name.strip()[:80] or 'Paired browser', now, now + SESSION_SECONDS))
                db.execute('UPDATE browser_network SET pair_hash=?,pair_expires=0 WHERE id=1', ('',))
            self.attempts.pop(peer, None)
        return session

    def authorized(self, token):
        if not isinstance(token, str) or not 20 <= len(token) <= 128:
            return False
        with self.store.connect() as db:
            row = db.execute('SELECT enabled FROM browser_network WHERE id=1').fetchone()
            if not row['enabled']:
                return False
            return db.execute('SELECT 1 FROM browser_grants WHERE token_hash=? AND expires>?',
                              (digest(token), self.clock())).fetchone() is not None

    def revoke(self, identity):
        with self.lock, self.store.connect() as db:
            db.execute('DELETE FROM browser_grants WHERE id=?', (identity,))
        return self.snapshot()
