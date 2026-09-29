"""Browser pairing and revocation use synthetic peers and clocks."""
from concurrent.futures import ThreadPoolExecutor
import pytest
from studio.pairing import Pairing, local_peer, PAIR_SECONDS, SESSION_SECONDS
from studio.store import Store


@pytest.fixture
def pairing(tmp_path):
    now=[1000.0]
    value=Pairing(Store(tmp_path),clock=lambda:now[0])
    return value,now


def test_pairing_is_opt_in_one_time_and_hash_only(pairing):
    value,now=pairing
    assert not value.snapshot()['enabled']
    code=value.configure(True)['pairing_token']
    grant=value.pair(code,'Synthetic browser','192.0.2.1')
    assert value.authorized(grant) and not value.authorized(code)
    with pytest.raises(ValueError,match='invalid or expired'):
        value.pair(code,'Another browser','192.0.2.2')
    assert grant not in str(value.snapshot()) and code not in str(value.snapshot())
    for table in ('browser_network','browser_grants'):
        text=str(value.store.rows('SELECT * FROM '+table))
        assert grant not in text and code not in text
    assert Pairing(value.store,clock=value.clock).authorized(grant)


def test_codes_and_sessions_expire_and_rotation_does_not_revoke_existing_devices(pairing):
    value,now=pairing
    old=value.configure(True)['pairing_token']
    code=value.new_code()['pairing_token']
    with pytest.raises(ValueError):value.pair(old,'Browser','192.0.2.1')
    grant=value.pair(code,'Browser','192.0.2.1')
    code=value.new_code()['pairing_token']
    now[0]+=PAIR_SECONDS
    with pytest.raises(ValueError):value.pair(code,'Other','192.0.2.2')
    assert value.authorized(grant)
    now[0]+=SESSION_SECONDS
    assert not value.authorized(grant)


def test_revocation_and_disabling_take_effect_immediately(pairing):
    value,now=pairing
    first=value.pair(value.configure(True)['pairing_token'],'First','192.0.2.1')
    second=value.pair(value.new_code()['pairing_token'],'Second','192.0.2.2')
    identity=next(device['id'] for device in value.snapshot()['devices'] if device['name']=='First')
    value.revoke(identity)
    assert not value.authorized(first) and value.authorized(second)
    value.configure(False)
    assert not value.authorized(second) and not value.snapshot()['devices']
    value.configure(True)
    assert not value.authorized(second)


def test_concurrent_consumption_creates_only_one_grant(pairing):
    value,now=pairing
    code=value.configure(True)['pairing_token']
    def claim(index):
        try:return value.pair(code,'Browser',f'192.0.2.{index}')
        except ValueError:return None
    with ThreadPoolExecutor(max_workers=4) as pool:
        tokens=list(pool.map(claim,range(8)))
    assert len([token for token in tokens if token])==1
    assert len(value.snapshot()['devices'])==1


def test_pairing_attempts_are_bounded_per_peer(pairing):
    value,now=pairing
    value.configure(True)
    for _ in range(10):
        with pytest.raises(ValueError,match='invalid or expired'):value.pair('invalid','Browser','192.0.2.1')
    code=value.new_code()['pairing_token']
    with pytest.raises(ValueError,match='Too many'):value.pair(code,'Browser','192.0.2.1')
    now[0]+=61
    assert value.authorized(value.pair(code,'Browser','192.0.2.1'))


def test_code_expiring_while_waiting_for_lock_is_not_accepted(pairing):
    value,now=pairing
    code=value.configure(True)['pairing_token']
    now[0]+=PAIR_SECONDS-.5
    class DelayedLock:
        def __enter__(self):now[0]+=1
        def __exit__(self,*args):pass
    value.lock=DelayedLock()
    with pytest.raises(ValueError,match='expired'):value.pair(code,'Browser','192.0.2.1')


def test_code_expiring_while_waiting_for_database_is_not_accepted(pairing,monkeypatch):
    from contextlib import contextmanager
    value,now=pairing
    code=value.configure(True)['pairing_token']
    now[0]+=PAIR_SECONDS-.5
    original=value.store.connect
    class DelayedDatabase:
        def __init__(self,db):self.db=db
        def execute(self,sql,*args):
            result=self.db.execute(sql,*args)
            if sql=='BEGIN IMMEDIATE':now[0]+=1
            return result
    @contextmanager
    def connect():
        with original() as db:yield DelayedDatabase(db)
    monkeypatch.setattr(value.store,'connect',connect)
    with pytest.raises(ValueError,match='expired'):value.pair(code,'Browser','192.0.2.1')


@pytest.mark.parametrize('peer',['127.0.0.1','127.3.4.5','::1','::ffff:127.0.0.1'])
def test_only_unforwarded_loopback_has_owner_access(peer):
    assert local_peer(peer)
    assert not local_peer(peer,{'x-forwarded-for':'127.0.0.1'})
    assert not local_peer(peer,{'forwarded':'for=127.0.0.1'})


@pytest.mark.parametrize('peer',['192.168.1.1','172.17.0.1','0.0.0.0','localhost','testclient','',None])
def test_hostnames_lan_and_bridges_are_not_local_owner(peer):
    assert not local_peer(peer)
