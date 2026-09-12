"""Persisted task preferences and deterministic capability routing."""
import json
import shutil
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from .registry import PACKAGES, compatible_profiles, compatibility
from .runtime import RuntimeFailure
from .telemetry import gpu_status


class Defaults(BaseModel):
    model_config = ConfigDict(extra='forbid')
    image: str = 'auto'
    video: str = 'auto'
    write: str = 'auto'
    website: str = 'auto'
    chat: str = 'auto'
    code: str = 'auto'
    video_text: str = 'auto'


class Appearance(BaseModel):
    model_config = ConfigDict(extra='forbid')
    compact_queue: bool = False
    show_gpu_details: bool = True


class Generation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    seed: int = Field(default=771, ge=0, le=2**53-1, strict=True)


class Performance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    keep_ready_minutes: Literal[2, 5, 15] = 2


class SettingsInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    defaults: Defaults = Field(default_factory=Defaults)
    appearance: Appearance = Field(default_factory=Appearance)
    generation: Generation = Field(default_factory=Generation)
    performance: Performance = Field(default_factory=Performance)


def get_settings(store):
    with store.connect() as db:
        row = db.execute("SELECT value FROM preferences WHERE key='settings'").fetchone()
    return SettingsInput.model_validate(json.loads(row['value']) if row else {}).model_dump()


def candidates(role):
    return compatible_profiles(role)


def resolve_profile(store, runtime, role, identity=None):
    eligible = candidates(role)
    hardware = gpu_status()
    choice = identity or 'auto'
    if choice == 'auto':
        choice = get_settings(store)['defaults'][role]
    if choice != 'auto':
        selected = next((p for p in eligible if p['id'] == choice), None)
        if selected is None:
            raise ValueError('Choose a model that supports this creation task.')
        eligible_hardware = compatibility(selected, hardware)
        if not eligible_hardware['compatible']:
            raise ValueError(eligible_hardware['reason'])
        runtime.preflight({'profile': selected})
        return selected
    # Registry recommendations take precedence; no silent substitution for an explicit choice.
    packages = {p['id']: p for p in PACKAGES}
    eligible.sort(key=lambda p: role not in packages[p['package']].get('default_for', []))
    for selected in eligible:
        if not compatibility(selected, hardware)['compatible']:
            continue
        try:
            runtime.preflight({'profile': selected})
            return selected
        except (RuntimeFailure, OSError, ValueError, KeyError):
            continue
    raise ValueError('No installed compatible model is ready for this task. Open Settings or Creation tools.')


def save_settings(store, body):
    for role, identity in body.defaults.model_dump().items():
        if identity != 'auto' and identity not in {p['id'] for p in candidates(role)}:
            raise ValueError('That model cannot be used for the selected task.')
    with store.connect() as db:
        db.execute("INSERT INTO preferences VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (json.dumps(body.model_dump()),))
    return get_settings(store)


def settings_response(store):
    files = store.rows('SELECT * FROM assets')
    size = sum(store.file(a).stat().st_size for a in files if store.file(a).is_file())
    return {**get_settings(store), 'version': 1, 'storage': {
        'projects': len(store.rows('SELECT id FROM projects')), 'assets': len(files),
        'bytes': size, 'free_bytes': shutil.disk_usage(store.root).free}}
