# Developer shortcuts. Studio itself starts with `bash run.sh`; see README.md.
PYTEST ?= .venv/bin/pytest
PYTHON ?= .venv/bin/python
PACKAGE ?= paiton-studio-source.zip

.PHONY: test build ui-test dev package

test:
	$(PYTEST) -q
	npm run test:unit

build:
	npm run build

ui-test:
	npm run test:ui

dev:
	npm run dev

package:
	$(PYTHON) -m studio.packaging $(PACKAGE)
