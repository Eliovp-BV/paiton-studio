# Notices and licensing

## Application licensing status

A license for Paiton Studio as a complete application has not yet been assigned.
Do not infer a blanket open-source or redistribution license from source availability.
The component licenses below remain in effect, including their obligations for
covered combinations. No exception to the retained AGPL license has been granted.

## Mail integration

PaitonMail includes portions of Gigamail, Copyright (C) 2026 Adecubed, under
AGPL-3.0-or-later. The retained license, origin revision and modification notices
are in [studio/mail_core/LICENSE](studio/mail_core/LICENSE) and
[studio/mail_core/NOTICE](studio/mail_core/NOTICE). PaitonMail's added mail modules
and frontend are also marked AGPL-3.0-or-later. Covered combinations remain subject
to that license; the application licensing status above does not override it.
The running UI offers Studio source and build files to its users. The proprietary
Paiton compiler is not included in that offer.

## External inference packages

Inference packages and model weights are installed separately. They retain their
original license files, model terms and provenance. Studio uses their public
runtime interfaces or submits trusted workflow data to them. The proprietary
compiler implementation and binaries are not included in this repository.

Relevant package notices include:

- Paiton public runtime: retained Apache-2.0 notices.
- FLUX.2 klein base weights: Apache-2.0; quantized-checkpoint provenance limitations remain in the package notices.
- SDNQ conversion and ComfyUI: GPL-3.0. Process separation alone does not determine distribution obligations.
- MiniMax H3: custom community model license and retained encoder/derivative terms.
- Qwen3-Coder: upstream and quantized model cards declare Apache-2.0, with the quantizer's unpinned upstream-revision limitation.

The setup screen links the source and license for each supported package, including
Qwen3.8, GPT-OSS, MiniCPM, Wan and FastWan. Follow the terms of the exact installed
package; this notice does not replace its model card or license. Bundling runtime
engines or weights with Studio requires a separate review of redistribution rights.

## Application dependencies and artwork

React, Vite, Lucide, FastAPI, Pillow, PyAV and other dependencies retain their own
licenses. The dependency lockfiles identify the application versions. PyAV wheels
include FFmpeg components; preserve their wheel notices in a bundled distribution.

`web/art/alpine-studio.png` is original environmental artwork generated locally
with the Paiton FLUX.2 klein adapter. It is bundled for the offline workspace and
is not automatically inserted into user projects. The screenshots in
`media/screenshots/` show the running Studio application with example projects
and actual locally generated media and writing.

AMD, Radeon and RDNA are trademarks of Advanced Micro Devices, Inc. Naming the
hardware used for testing does not imply AMD certification or endorsement of Studio.
