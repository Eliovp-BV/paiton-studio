# Paiton Studio user guide

[← Back to the getting-started guide](README.md)

Use this guide for updates, backups, existing model packages and optional connected tools. For everyday creation, the **Wiki** inside Studio is available locally.

[Network access](#network-access) · [Backups](#save-and-back-up-your-work) · [Updates](#update-studio) · [Existing models](#connect-existing-models) · [Loading](#queue-and-model-memory) · [Meetings](#transcribe-a-meeting) · [MCP](#connect-applications-with-mcp)

## Network access

Run one Studio server per workspace. The default launch command is:

```bash
bash run.sh
```

It listens on all host interfaces (`0.0.0.0`) at port `8877`. On the host, open `http://localhost:8877`. On another computer, use the host’s LAN IP address and the same port. Both browsers access the same saved workspace; inference still runs on the host GPU.

To restrict access to the host computer:

```bash
PAITON_STUDIO_HOST=127.0.0.1 bash run.sh
```

To choose another port:

```bash
PAITON_STUDIO_PORT=8878 bash run.sh
```

If you deliberately use a local hostname that Studio does not discover, add it explicitly:

```bash
PAITON_STUDIO_ALLOWED_HOSTS=studio.lan bash run.sh
```

Replace `studio.lan` with your actual hostname. This setting allows that host name; it does not create a DNS record or provide user authentication.

**Use a trusted local network.** Studio currently has no individual user accounts. People who can reach the app can access its workspace and controls. MCP connections have their own tokens, which are not a login system for the main app. Do not expose the server directly to the public internet. A browser on another computer sends prompts and selected files across your LAN to the host; plain HTTP does not encrypt that connection.

## Save and back up your work

Studio keeps editable projects, generated media and local records in `.data/` by default. Configuration written by guided setup lives in `config.local.json`. Both are private to your installation and excluded from source control.

For a complete workspace backup:

1. Let active generation and downloads finish, or cancel them from Studio.
2. Stop Studio from its launch terminal with **Ctrl+C**.
3. Copy the complete `.data/` directory and `config.local.json`, if present, to your backup location. Include hidden files and the database.
4. Keep a record of any configured external model directories or Docker volumes. They are not included merely by copying `.data/`.
5. Restart Studio with `bash run.sh`.

**Export project** creates shareable creative outputs, including supported site, media and text files. An export is not a full editable-workspace backup. To reopen work, return to the same running Studio host and choose the project in **Projects**.

### Put new workspace data on another drive

Choose a writable location on a local disk, then launch with:

```bash
PAITON_STUDIO_DATA=/path/to/studio-data bash run.sh
```

Replace the example path before running it. This selects a data directory; it does not migrate existing projects. Stop Studio before copying an existing complete data directory into a new location. Always use the same environment setting when you restart.

`PAITON_STUDIO_CONFIG` can select an explicit configuration file. Model folders and Docker storage may be on different drives from the workspace. Check their free space too when an installer reports insufficient storage.

## Update Studio

Keep the current working version available until the update has been checked.

1. Back up your workspace as described above and stop Studio.
2. Extract the new source into a separate folder.
3. Follow the installation commands in the [README](README.md#install-on-linux) inside that folder.
4. Copy your stopped workspace’s complete `.data/` and `config.local.json`, if present, into the new folder. If you use an external data path, back it up before launching the new version against it.
5. Start the new version and verify that a project opens and its assets are present. Check **Settings → System & drivers** and your creation tools before generating.

Model folders outside the old installation can continue to be referenced. If a configured path points inside the old installation folder, keep that folder in place or update the path before removing it. A code update does not require a driver update. After a driver or runtime change, recheck hardware readiness and test the tools you use before starting a large project.

To roll back, stop the new version and use the old source with its matching workspace backup. Do not assume an older version can read a database modified by a newer release.

## Connect existing models

Most users should install through **Settings → Tool setup & downloads**. Studio records the prepared package locations and verifies compatible profiles.

If you already have Paiton runtime packages:

1. Read the appropriate package guide in the [Paiton runtime repository](https://github.com/Eliovp-BV/paiton-vllm-plugin).
2. Use [config.example.json](config.example.json) as a reference for the supported keys.
3. Create or edit `config.local.json` in the Studio source folder while Studio is stopped. Include only the keys you actually need. Replace every example path you use with the real absolute path on the host.
4. Start Studio and review **Creation tools** and **Settings**. Installed files do not bypass the package’s GPU or integrity checks.

Do not copy all the placeholder paths into a new installation. These are prepared Paiton package interfaces, not a generic “load any Hugging Face model” option. A new model needs a compatible adapter, verified artifacts and hardware qualification before Studio can offer it for a task.

You do not need the proprietary Paiton compiler to run the supported installed packages.

## Queue and model memory

The queue serializes work on one GPU. Another application using the card can delay Studio. Studio does not stop other applications for you.

- **Downloads** fetch runtime packages and model weights when requested.
- **Preparation** verifies or converts a package and may need the GPU.
- **Loading** starts the model runtime and moves data into working memory.
- **Generation** creates the requested result.

Some first loads take minutes even after the model is installed. Closing and reopening a browser does not make a load complete faster. Keep the host awake and running.

Supported text runtimes can stay ready for **2, 5 or 15 minutes**, configured in **Settings → Preferences → Model loading & switching**. This applies to Qwen3.8 writing/website planning, GPT-OSS and MiniCPM. An active GPT workspace extends supported chat-runtime retention. Another queued tool can reclaim the GPU, after which a later text request may need to reload.

Chat history is saved separately from model memory and supplied as context for subsequent requests within the supported context budget. Releasing the GPU model does not delete the conversation. Long documents or conversations still have model-specific limits; use smaller selections or a shorter request when Studio reports that a request does not fit.

Disk caches avoid repeating supported preparation, and the operating system may cache model files in RAM. An initialized model that can instantly move between RAM and GPU is not a qualified Studio capability today. Current Image and Video adapters load per request.

### Cancel or recover work

Open **Queue** to cancel a queued or active request. Cancelling can take time while the runtime stops safely. Wait for the final cancelled state before assuming the GPU is free.

After an interruption, Studio reports affected jobs instead of presenting incomplete outputs as finished. Retry from the relevant tool. Website workflows offer **Retry unfinished steps** so completed plan or artwork steps can be reused. Review generated results before applying them.

## Transcribe a meeting

**Meetings → Transcribe your meeting** accepts recorded audio for local transcription, speaker diarization and summaries. Diarization assigns anonymous speaker labels; it does not identify people. Rename a speaker only when you know who they are, and review transcript timestamps before relying on a summary.

Meeting transcription is an **advanced, opt-in integration**. It is not installed by the general creation-tool downloader yet. Follow the [Meeting package setup guide](https://github.com/Eliovp-BV/paiton-vllm-plugin/blob/main/models/Meeting/REPRODUCE.md) to prepare the supported runtime and model cache, including its verification receipt. Configure:

- `meeting_enabled: true`
- `meeting_image`: the prepared, supported container image
- `meeting_models_dir`: the absolute path to the prepared models and provenance receipt

The cache includes the required Parakeet, community-1, Silero and compact Granite components. Studio verifies prepared files and reports what is missing; it does not automatically retrieve missing meeting weights. The default ASR path uses the package’s stock backend. The optional compiled prediction-LSTM path requires a matching qualified package and `meeting_compiler_enabled: true`; keep the default unless you prepared that package.

After setup:

1. Import a recording, select the needed tracks/channels and start transcription.
2. Review the text, timestamps and anonymous speaker labels.
3. Generate and review the summary; summaries can omit or misstate facts.
4. Export text, JSON, SRT or VTT as needed, or associate the result with a project.

Studio supports deleting its owned recording copies and a retention option to remove audio after processing. Deleting Studio’s copy does not delete the original file you imported.

### Record from the browser

Recording starts only after you grant microphone or shared-audio access. Processing starts after you stop the recording; this is not continuous live transcription. Obtain participants’ consent before recording.

Browsers require **localhost or trusted HTTPS** for recording. On plain LAN HTTP, import an existing audio recording instead. For an HTTPS host, supply a certificate trusted by the client browser:

```bash
PAITON_TLS_CERT=/path/to/certificate.pem \
PAITON_TLS_KEY=/path/to/private-key.pem \
bash run-meetings-secure.sh
```

Use real certificate paths. This launcher does not create certificates or make an untrusted certificate trusted. There is no automatic Teams meeting capture or Microsoft account integration.

## Connect applications with MCP

**MCP Servers** lets a compatible client use selected Studio capabilities, powered by local models. A normal email application needs an MCP-capable add-on or client; SMTP alone does not make it an MCP client.

### Mail MCP

1. Select a project and a compatible local response model.
2. Configure the Mail MCP connection and explicitly enable it.
3. Download the generated client configuration and add it to your MCP client.
4. Ask the client to summarize, draft a reply or rewrite supplied email text.

The streamable HTTP endpoint is `/mcp/`. Its bearer token is scoped to the enabled project connection. Treat client configurations as credentials: do not post them publicly. Disabling the connection revokes its token; changing its model rotates the token. Already accepted GPU work remains separately cancellable.

The `assist_email` tool supports `summarize`, `draft_reply` and `rewrite`. Clients should provide a stable `client_id` to avoid duplicate requests, poll `get_result` about every three seconds, and use `cancel_request` when needed. Local requests and results persist with the project. The model is chosen by the Studio owner; clients cannot request arbitrary runtime commands or cloud models.

### SMTP drafts

Configure an outgoing SMTP server, verified TLS, sender address and account credentials. A connection test checks authentication without sending mail. Store an application password if your provider requires one.

SMTP credentials are kept in an owner-only host file, separate from inference mounts and creative exports. This is not an encrypted credential vault. The trusted-host and trusted-network requirements still apply.

`prepare_email` creates an immutable review snapshot and an `.eml` draft. **Preparing a draft does not send it.** Open the draft in your normal mail application to review and send. `smtp_status` reports readiness without returning credentials; `get_delivery` checks the draft state.

Direct sending is unavailable on Linux because the retained native approval backend does not support that host. Studio does not expose an MCP “approve” or direct-send tool. The optional host-native approval command `python scripts/smtp_owner.py <delivery-id>` requires the extra dependencies in `requirements-mail-approval.txt` and a supported backend; its presence does not qualify Studio on Windows or macOS. Microsoft 365 and Google OAuth are future integrations.

### Create a purpose-built agent server

Choose **Create your own MCP server** to begin in **Agents**. Define a purpose, select approved project documents and a compatible chat model, then review the agent’s settings. The server starts disabled; enable it explicitly in MCP configuration.

Agent MCP endpoints use `/mcp/agents/`. Their tools are `server_info`, `run_agent`, `get_result` and `cancel_request`. Each server has a separate token; rotate or disable it to revoke access. Requests run in the shared GPU queue. The current limits allow one active run per agent and up to three active agent requests per project through MCP.

These are bounded text-oriented agents with selected context. They do not execute arbitrary host code, browse unrestricted folders, install third-party tools or maintain an autonomous background life. Mail and agent MCP configurations are not included in creative project exports.

## Installation errors

| Message or symptom | What to do |
| --- | --- |
| `python3: command not found` | Install Python through your Linux distribution. Use Python 3.12 for the tested setup. |
| `ensurepip is not available` | On Ubuntu, install `python3-venv`, then rerun the virtual-environment command. |
| `node` or `npm` not found | Install Node.js 22 LTS with npm, open a fresh terminal, and retry the version checks. |
| Python dependency installation fails | Check internet access and the Python version. Keep the pinned requirements; changing individual versions can break compatibility. |
| Docker permission denied | Follow Docker’s Linux post-install instructions and sign out/in after changing groups. Do not run the whole Studio app as root to bypass the check. |
| Unsupported Docker endpoint | Choose a local Docker Engine on the Studio host. Remote contexts and unsupported socket types are rejected. |
| Address already in use | An app may already be using port 8877. Open the existing Studio instance or choose another port; do not stop an unrelated service. |
| Interface missing after launch | Run `npm ci` and `npm run build` successfully from the source folder, then start Studio again. |

When reporting a problem, include the Studio version or source revision, your OS, GPU name and memory, the creation tool, the exact error, and the steps that led to it. Remove private prompts, documents, email addresses, credentials and MCP tokens before sharing screenshots or logs.

## Notices

The Mail MCP page provides the retained license and a source download for the running integration. The source offer contains reviewed application/build files and excludes private workspace data, model weights and proprietary compiler artifacts. See [NOTICE.md](NOTICE.md) for attribution and the current application licensing status.
