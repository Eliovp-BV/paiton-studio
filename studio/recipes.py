"""Local reusable task templates. Rendering never creates work or touches a runtime."""
import re
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .store import uid

LIMITS = {'chat': 8000, 'coding': 1200, 'write': 2500, 'image': 2500, 'page': 2500}
PLACEHOLDER = re.compile(r'\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}')


def plain_text(value):
    try:
        value.encode('utf-8')
    except UnicodeError:
        raise ValueError('Use valid UTF-8 text.') from None
    if any(ord(char) < 32 and char not in '\n\r\t' or char == '\x7f' for char in value):
        raise ValueError('Use plain text without control characters.')
    return value


def variables(template):
    remaining = PLACEHOLDER.sub('', template)
    if '{{' in remaining or '}}' in remaining:
        raise ValueError('Use placeholders such as {{topic}}: a letter followed by letters, numbers or underscores, up to 32 characters.')
    names = list(dict.fromkeys(PLACEHOLDER.findall(template)))
    if len(names) > 8:
        raise ValueError('Use at most 8 different inputs in a recipe.')
    return names


class RecipeInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default='', max_length=500)
    target: Literal['chat', 'coding', 'write', 'image', 'page']
    template: str = Field(min_length=1, max_length=8000)

    @field_validator('name', 'description', 'template')
    @classmethod
    def text(cls, value):
        return plain_text(value)

    @field_validator('name')
    @classmethod
    def name_text(cls, value):
        value = value.strip()
        if not value or '\n' in value or '\r' in value or '\t' in value:
            raise ValueError('Choose a nonempty recipe name on one line.')
        return value

    @model_validator(mode='after')
    def validate_template(self):
        if not self.template.strip():
            raise ValueError('Write a task template first.')
        if len(self.template) > LIMITS[self.target]:
            raise ValueError(f'{self.target.capitalize()} recipes allow at most {LIMITS[self.target]:,} characters. No text was truncated.')
        variables(self.template)
        return self


class RevisionInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    expected_revision: int = Field(ge=1)


class RecipeUpdate(RecipeInput):
    expected_revision: int = Field(ge=1)


class RenderInput(RevisionInput):
    values: dict[str, str] = Field(default_factory=dict, max_length=8)

    @field_validator('values')
    @classmethod
    def input_text(cls, values):
        for value in values.values():
            plain_text(value)
            if not value.strip():
                raise ValueError('Fill in every recipe input before previewing.')
            if len(value) > 8000:
                raise ValueError('Keep each recipe input below 8,000 characters.')
        return values


class RecipeManager:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS recipes(
                id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL,
                description TEXT NOT NULL, target TEXT NOT NULL, template TEXT NOT NULL,
                created REAL NOT NULL, updated REAL NOT NULL)''')

    @staticmethod
    def _public(row):
        value = dict(row)
        return {**value, 'variables': variables(value['template']), 'prompt_limit': LIMITS[value['target']]}

    @staticmethod
    def _row(db, identity, expected=None):
        row = db.execute('SELECT * FROM recipes WHERE id=?', (identity,)).fetchone()
        if row is None:
            raise HTTPException(404, 'This recipe no longer exists. Your local draft has been kept.')
        if expected is not None and row['revision'] != expected:
            raise HTTPException(409, 'This recipe changed in another window. Compare the saved version before replacing it; your draft has been kept.')
        return row

    def list(self):
        with self.store.connect() as db:
            return [self._public(row) for row in db.execute('SELECT * FROM recipes ORDER BY updated DESC,id')]

    def get(self, identity):
        with self.store.connect() as db:
            return self._public(self._row(db, identity))

    def create(self, body):
        body = RecipeInput.model_validate(body)
        now, identity = time.time(), uid()
        with self.store.connect() as db:
            db.execute('INSERT INTO recipes VALUES(?,?,?,?,?,?,?,?)', (identity, 1, body.name, body.description, body.target, body.template, now, now))
            return self._public(self._row(db, identity))

    def update(self, identity, body):
        body = RecipeUpdate.model_validate(body)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._row(db, identity, body.expected_revision)
            db.execute('UPDATE recipes SET revision=revision+1,name=?,description=?,target=?,template=?,updated=? WHERE id=?',
                       (body.name, body.description, body.target, body.template, time.time(), identity))
            return self._public(self._row(db, identity))

    def delete(self, identity, body):
        body = RevisionInput.model_validate(body)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._row(db, identity, body.expected_revision)
            db.execute('DELETE FROM recipes WHERE id=?', (identity,))
        return {'deleted': identity}

    def duplicate(self, identity, body):
        body = RevisionInput.model_validate(body)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = self._row(db, identity, body.expected_revision)
            now, duplicate = time.time(), uid()
            db.execute('INSERT INTO recipes VALUES(?,?,?,?,?,?,?,?)',
                       (duplicate, 1, row['name'][:95] + ' copy', row['description'], row['target'], row['template'], now, now))
            return self._public(self._row(db, duplicate))

    def render(self, identity, body):
        body = RenderInput.model_validate(body)
        with self.store.connect() as db:
            recipe = self._public(self._row(db, identity, body.expected_revision))
        if set(body.values) != set(recipe['variables']):
            raise HTTPException(422, 'Provide exactly the inputs named in this recipe.')
        length = len(recipe['template']) + sum(len(body.values[match.group(1)]) - len(match.group(0))
                                              for match in PLACEHOLDER.finditer(recipe['template']))
        if length > recipe['prompt_limit']:
            raise HTTPException(422, f'The completed task exceeds the {recipe["prompt_limit"]:,}-character limit for {recipe["target"]}. Shorten the inputs; no text was truncated.')
        # Check expansion size before allocating it; replacements are literal and single-pass.
        prompt = PLACEHOLDER.sub(lambda match: body.values[match.group(1)], recipe['template'])
        return {key: recipe[key] for key in ('id', 'revision', 'name', 'target')} | {'prompt': prompt}

    def router(self):
        router = APIRouter(prefix='/api/recipes', tags=['recipes'])

        @router.get('')
        def listing(): return self.list()

        @router.post('', status_code=201)
        def create(body: RecipeInput): return self.create(body)

        @router.get('/{identity}')
        def get(identity: str): return self.get(identity)

        @router.patch('/{identity}')
        def update(identity: str, body: RecipeUpdate): return self.update(identity, body)

        @router.delete('/{identity}')
        def delete(identity: str, body: RevisionInput): return self.delete(identity, body)

        @router.post('/{identity}/duplicate', status_code=201)
        def duplicate(identity: str, body: RevisionInput): return self.duplicate(identity, body)

        @router.post('/{identity}/render')
        def render(identity: str, body: RenderInput): return self.render(identity, body)

        return router
