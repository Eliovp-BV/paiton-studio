// Bundled help: opening the wiki never requests an external service.
export const WIKI = [
  {
    id: "host-drivers",
    title: "GPU detection, drivers and host setup",
    summary:
      "Understand host warnings and keep driver upgrades separate from model packages.",
    sections: [
      {
        heading: "When Studio cannot find your GPU",
        paragraphs: [
          "Studio checks the host automatically. A banner points to System details if GPU detection, device access, hardware qualification or the local Docker runtime needs attention. On a network connection, these checks describe the Studio host, not your browser computer. Existing projects stay available.",
          "A busy GPU is not incompatible. An unknown driver version alone is not a failure. Check device passthrough and permissions before assuming a driver reinstall is needed.",
        ],
      },
      {
        heading: "RDNA support and memory headroom",
        paragraphs: [
          "Current Paiton model packages target qualified RDNA4 hardware on Linux. A different GPU, an unidentified architecture or an unqualified card does not have guaranteed operation. Studio checks each package separately; RDNA4 detection alone does not mean every tool can run.",
          "GPU memory can be the limiting factor even on RDNA4. Smaller-memory cards may have fewer available models, and the display or another application can reduce free memory further. A package's download size is not its GPU memory requirement. Incompatible profiles stay unavailable; Studio does not lower quality or move inference to the cloud to make them fit.",
          "Windows support is being prepared, but working Linux packages do not establish native Windows compatibility. The host platform, driver, GPU architecture and package must be qualified together. Opening Studio from a Windows browser uses the remote Studio host's GPU.",
        ],
      },
      {
        heading: "Driver updates and Paiton packages",
        paragraphs: [
          "Studio does not lock the host to one exact driver version. The model containers keep their tested ROCm and libraries; the host supplies amdgpu. A newer host driver may work with existing packages, but the exact combination needs compatibility evidence.",
          "System details links to official AMD instructions and a community setup guide. The online source check contacts GitHub only when clicked. It does not prove a newer compatible driver exists and does not install anything. Broad installers can remove environments, restart Docker and require reboot. A host administrator should review the proposed change and arrange a maintenance window.",
          "Qualify an upgrade on a spare or recoverable installation: record a baseline, upgrade the host, then test all model packages, exact-image animation, reasoning, warm chat, website generation, cancellation and recovery before recommending it.",
        ],
      },
    ],
  },
  {
    id: "agents",
    title: "Create your own local agent",
    summary:
      "Start with a purpose, approved project documents and a bounded local workflow.",
    sections: [
      {
        heading: "Purpose \u2192 draft \u2192 review \u2192 save",
        paragraphs: [
          "Open Agents in your project. Choose a template, give it a name and purpose, then select the documents it may use. Model choice is optional; only compatible chat models are offered. MiniCPM5 is the faster small-model option, with lower quality on complex tasks. Prepare missing packages in Settings before running.",
          "Describe the work and choose Run agent. Each run makes two local requests: a draft followed by a review. Results become project text assets, and saved agents and recent run history are included in project exports. The review is another AI pass, not independent fact checking.",
        ],
      },
      {
        heading: "Several agents, one GPU",
        paragraphs: [
          "Agents save separate purposes and contexts; they do not each need a separate model in memory. Studio runs one GPU step at a time and can reuse the ready model between steps. Loading may take longer than writing. Keep the Studio host running while browsing, and stop a run to prevent later steps.",
          "This first version runs manually. Creative producer writes plans and proposed prompts, not new media. Agents cannot run shell commands, browse, send external messages, schedule themselves or publish. Only selected, bounded document excerpts are used. Hardware partitioning and concurrent model batching are not enabled.",
        ],
      },
    ],
  },
  {
    id: "gptpaiton",
    title: "Chat with GPTPaiton",
    summary:
      "A local conversation, document reader and image creator in your project.",
    sections: [
      {
        heading: "Start a conversation",
        paragraphs: [
          "Open GPTPaiton and ask a question. Prepare a compatible conversation model in Settings first if it is missing. Choose MiniCPM5-2B for quick replies or GPT-OSS for deeper work. Conversations are saved in the current project and included in project exports. Chat and Code use a compatible text model; Create image uses the image model. Auto recognizes direct image creation requests. Generated code is displayed for review and is never executed.",
        ],
      },
      {
        heading: "Reasoning and response time",
        paragraphs: [
          "With GPT-OSS, Quick, Balanced and Deeper select low, medium and high reasoning effort. Studio limits reasoning to reserve room for a final answer within the 2048-token response cap. A long answer can still reach that cap; ask it to continue. MiniCPM5-2B instead uses a smaller model with extended thinking off for fast replies. Expect lower quality on complex questions, arithmetic and unfamiliar code; review its answers.",
          "The first reply can require several minutes of model loading. Actual final-answer text appears as it arrives. Studio keeps a supported chat model ready while GPTPaiton is open, holding the GPU lease. After leaving or losing the browser connection, it unloads after the configured idle period: two minutes by default. Change this in Settings → Preferences → Model loading & switching. Another creation model unloads it before starting. Stop cancels only the current Studio request. Keep the host running while you browse.",
        ],
      },
      {
        heading: "Documents and privacy",
        paragraphs: [
          "Attach PDF, DOCX or UTF-8 text/code files up to 8 MB each, with at most eight documents in the conversation context. Extraction reads up to 100 PDF pages and 200,000 characters. Scanned PDFs require OCR outside Studio. Local keyword matching selects up to eight relevant excerpts; source details show what was included. This does not mean every page was analyzed.",
          "Recent turns are included within the model context budget; older turns remain saved. Documents are treated as quoted reference material. They cannot trigger commands or select tools. There is no web browsing, host command execution, cloud inference or image understanding in this assistant. Reachable users on the trusted LAN share this workspace.",
        ],
      },
    ],
  },
  {
    id: "video-alternatives",
    title: "Choose a video alternative",
    summary:
      "Select a qualified model for text-to-video or animating an image.",
    sections: [
      {
        heading: "Different models, different capabilities",
        paragraphs: [
          "H3 retains its verified input-image path and native audio. Wan2.2 TI2V-5B accepts text or an image and creates silent 832×480 landscape or 480×832 portrait clips. FastWan FullAttn 5B accepts text only and creates silent 832×480 or 1280×704 landscape clips. It uses three denoiser evaluations; detail and motion can differ from the full model.",
          "Wan and FastWan offer 49 or 121 frames at 24 fps: approximately 2.04 or 5.04 seconds. These are actual release profiles, not arbitrary duration controls. FastWan is excluded when animating an image. Wan preserves the selected source identity, fitting it to the chosen canvas before inference.",
        ],
      },
      {
        heading: "Preparation and compatibility",
        paragraphs: [
          "Download a supported package in Settings. Wan runtimes are assembled locally from pinned public package files, and FastWan performs a lossless CPU key conversion once. Allow time and disk space. These releases are qualified on the 32 GB Radeon AI PRO R9700; a 16 GB card is not currently qualified. Detection alone does not establish future GPU support.",
          "Wan uses the release stock default because its published complete-clip tests did not show a Paiton improvement. FastWan uses the qualified Paiton path. Studio does not invent savings or silently change your chosen profile.",
        ],
      },
    ],
  },
  {
    id: "delivery",
    title: "Prepare reels and shorts",
    summary:
      "Reframe a real project video while keeping its original pixels and sound safe.",
    sections: [
      {
        heading: "Create first, then prepare a delivery copy",
        paragraphs: [
          "Generate a video from your selected image, then open Reels & shorts. Choose the saved clip and a portrait, square or wide format. Keep the whole picture adds borders; Fill the frame crops it. The preview shows the framing, with optional composition guides that are never burned into the result.",
          "H3 creates 864×480 clips; Wan also offers native 480×832 portrait generation. A 9:16 delivery copy is a resized or cropped export of the selected clip. Filling portrait from an H3 landscape source keeps about 31% of its width. Move the horizontal focus to keep your subject visible, or keep the whole picture.",
        ],
      },
      {
        heading: "Your GPU can keep creating",
        paragraphs: [
          "Delivery copies use a separate local CPU queue, one encode at a time. They preserve the source frame rate and either copy its AAC audio or save without sound. Resizing adds no detail or new motion. A completed copy appears in the project library with its original source recorded.",
          "Cancel stops the copy and retains the original. If Studio closes during encoding, the request is interrupted; create another copy to retry. This version supports one clip at a time. Sequencing, trimming, timed captions and automatic publishing are not available yet. Review the finished file in the destination app before posting.",
        ],
      },
    ],
  },
  {
    id: "system",
    title: "System details and shared projects",
    summary:
      "Understand detected hardware and avoid losing edits from another window.",
    sections: [
      {
        heading: "Detection is separate from model support",
        paragraphs: [
          "Settings → System & drivers shows the Studio host's operating system, kernel, graphics driver, Docker, memory and disks. Host driver and the runtime's ROCm userspace are different components. Unknown details are shown as not reported. These checks do not install drivers or load a model.",
          "A detected GPU is not automatically qualified for a Paiton model. Creation tools applies the reviewed package requirements. More GPU memory alone cannot establish compatibility; future devices need their own validated packages.",
        ],
      },
      {
        heading: "When two windows edit the same project",
        paragraphs: [
          "Studio checks the saved project revision before writing. If another window saves first, your unsaved draft stays in this window and the newer saved work remains intact. Download your draft as JSON before choosing Load saved version, which replaces your unsaved window contents. Automatic merging and JSON draft import are not implemented.",
        ],
      },
    ],
  },
  {
    id: "setup",
    title: "Set up your creation tools",
    summary:
      "Check the host, choose a tool and download its local model when you are ready.",
    sections: [
      {
        heading: "Before your first generation",
        paragraphs: [
          "Open Settings, then Tool setup & downloads. Studio checks the host operating system, Docker, Radeon driver access and free space. Each tool shows its source, license, model download and preparation steps. Opening Settings does not start a download.",
        ],
        steps: [
          "Resolve any host requirements shown at the top of the setup screen.",
          "Review the tool's source, license and required disk space.",
          "Choose Download & prepare to begin that package's installation.",
          "Follow the named download, preparation and verification phases.",
          "When the tool is ready, return to your project and create something.",
        ],
      },
      {
        heading: "Downloads and local inference",
        paragraphs: [
          "Installation uses the internet to obtain the selected public model and runtime packages. Generation runs on the Studio host, with no hosted model fallback. Writing and video files can download before a Radeon driver is ready; generating still needs the supported GPU. Image preparation also uses that GPU and waits for current work to finish.",
          "Large model files can take time to download and verify. Container transfers depend on files Docker already has, so those phases show activity without a guessed percentage. A ready model still needs to load when your first generation begins.",
        ],
      },
      {
        heading: "Stop and continue later",
        paragraphs: [
          "Cancel keeps completed files and partial downloads for a later retry. Choose Download again to verify and reuse them. After Studio closes during setup, the request is marked Interrupted; restarting does not pretend that preparation finished. Studio stores new packages in its own data directory and keeps existing connected tools intact.",
        ],
      },
    ],
  },
  {
    id: "getting-started",
    title: "Your first creative project",
    summary: "Take one idea from an image to a video, writing and a website.",
    sections: [
      {
        heading: "Keep everything together",
        paragraphs: [
          "A project holds your images, videos, writing, website and creation history. Start with a short description of what you want to make. You can move between tools while your work stays in the same project.",
        ],
        steps: [
          "Create an image, or import a PNG or JPEG you already have.",
          "Choose Animate this on the image you want to bring to life.",
          "Write a blog, caption or product story with the local writing tool.",
          "Build a website using the project media and writing you choose.",
          "Review the pages and export a ZIP with the website, media and text.",
        ],
      },
      {
        heading: "Animate the actual image",
        paragraphs: [
          "Image to Video sends the selected image pixels into the video model. The fit preview shows the landscape image the model receives. Studio adds borders when needed, keeps the original unchanged and records which image produced the video. A motion prompt describes movement; it does not replace the source image.",
        ],
      },
    ],
  },
  {
    id: "models",
    title: "Choose the right creation tools",
    summary:
      "Use recommended defaults, or choose a compatible local model for each task.",
    sections: [
      {
        heading: "Defaults that match the task",
        paragraphs: [
          "Settings groups models by what they can do. Image models create artwork, video models animate scenes, and language models write text or plan website content. You do not need to know a model name to begin. Optional model details show the actual package and supported settings.",
          "Qwen3.8 27B is a writing choice when its Paiton package is ready on this host. A language model cannot be selected as the video generator. Website creation uses a language model for content and an image model for any requested artwork.",
        ],
      },
      {
        heading: "Ready is different from loaded",
        paragraphs: [
          "A ready model has the required local package and files; it may still need time to load when a job starts. Setup required means something is missing or incompatible. Studio never substitutes cloud inference. The available choices and presets come from supported integrations, so a new model must be integrated before it can appear as a working option.",
        ],
      },
    ],
  },
  {
    id: "model-cache",
    title: "Model loading, caching and faster switching",
    summary:
      "Understand what Studio can reuse and why a different model may still take time to start.",
    sections: [
      {
        heading: "Downloaded, cached and ready are different",
        paragraphs: [
          "Downloaded model weights and installed runtimes stay on local storage. Supported runtime caches are also stored locally, so reusable preparation files can survive a model being unloaded. These files prevent repeated downloads or some repeated preparation; they are not a running model.",
          "A ready model in GPU memory can answer again without another full load. When a different creation tool needs that memory, Studio releases the current model first. Switching back may still require reading weights, transferring them to the GPU and initializing the runtime. Paiton inference optimizations do not remove every startup cost.",
        ],
      },
      {
        heading: "What about system memory or disk?",
        paragraphs: [
          "The operating system may keep recently read model files in spare system RAM. That can reduce later disk reads, but this memory can be reclaimed by other applications. Studio does not claim a model is cached in RAM without a runtime reading, and file caching does not eliminate GPU transfer or initialization.",
          "Parking a loaded model in system RAM and restoring it later requires support from that specific runtime. Studio does not currently promise that for every model. A faster local drive may help the file-reading part of loading; it will not speed every preparation phase. Copying large weights to a RAM disk can exhaust system memory and is not required by Studio.",
        ],
      },
      {
        heading: "Keep the pace without silently changing quality",
        paragraphs: [
          "Settings → Preferences → Model loading & switching lets you keep supported models ready for 2, 5 or 15 idle minutes. The default is 2 minutes. This applies to Qwen3.8 writing and website planning, GPT-OSS, and MiniCPM. It holds GPU memory for faster follow-up work; a different queued tool can still release it immediately. It does not enable RAM suspension. Qwen3.8 still needs a long initial load after Studio starts or another tool releases it.",
          "Keep related writing or chat tasks together when practical; moving between large text, image and video tools can trigger repeated loads. The queue keeps your requested order and does not skip another person's work to avoid a switch.",
          "Review the preparation note beside your model choice before submitting. If speed matters more for the next request, explicitly choose a smaller compatible model such as MiniCPM5 for chat. Its answers can be weaker on complex reasoning, arithmetic and unfamiliar code. Studio keeps your selected quality settings and never silently changes models.",
          "Loading and warm-up messages describe preparation separately from generation. Low GPU activity can be normal while files are read or the CPU prepares a model. You can keep browsing while queued work runs; the Studio host must stay on. Your saved conversation and project remain available after a model switch.",
        ],
      },
    ],
  },
  {
    id: "queue",
    title: "Understand activity and the queue",
    summary: "See what is happening and keep one GPU working safely.",
    sections: [
      {
        heading: "One generation at a time",
        paragraphs: [
          "Studio shares one queue across tools and projects. It releases the current model before another one loads. You can keep editing or queue the next task while a generation runs. Closing the browser does not cancel the queue.",
          "Preparing checks the request and files. Loading starts the model and may include first-use compilation. Generating performs the inference. Saving validates the output before adding it to your project. Some phases can take minutes.",
        ],
      },
      {
        heading: "Read the activity display",
        paragraphs: [
          "GPU activity and memory readings describe the Studio host, including other applications using its GPU. Low GPU activity during loading can mean the host is reading files or doing CPU work. An unavailable reading is not zero activity. Sampling steps measure that phase only; they are not a countdown for the entire request.",
          "Model eligibility is checked separately for each tool using the detected graphics card, architecture and total memory. A model being small enough is not sufficient when its package requires a particular card. Settings explains incompatible choices and keeps them out of generation. Downloading files does not make an incompatible model runnable.",
        ],
      },
      {
        heading: "Cancel and recover",
        paragraphs: [
          "Cancel stops the selected queued job or Studio's active generation. Allow time for the model to stop and release its memory. Already saved assets remain available. Failed jobs keep their request and error; retry creates another attempt. After a Studio restart, interrupted computation is reported as failed rather than presented as resumed.",
        ],
      },
    ],
  },
  {
    id: "websites",
    title: "Build a connected website",
    summary:
      "Generate linked pages, add real artwork and edit the result before export.",
    sections: [
      {
        heading: "From a brief to a draft",
        paragraphs: [
          "Describe the purpose of the website, its audience and what visitors should learn. Choose two to five pages and up to three new artwork images. You can also select existing project media and writing. A local language model develops the page content; artwork requests run through the image tool in sequence.",
          "The writing model receives the selected text context. It does not watch your videos or inspect your image pixels. Include the details you want it to know in your brief or writing.",
        ],
        steps: [
          "Write the website brief and choose existing assets to include.",
          "Start generation and follow the content and artwork jobs in the queue.",
          "Review the finished website draft, then apply it to your project.",
          "Edit page titles, descriptions, sections, media and theme.",
          "Check linked pages at desktop and mobile sizes, then export.",
        ],
      },
      {
        heading: "While your website is being created",
        paragraphs: [
          "After you start, Studio confirms that the request is saved in the queue. Loading can take several minutes before writing begins. You can browse other projects and keep editing; a progress message stays visible across Studio. Keep the host running. Your prompts and generation stay local.",
          "A moving progress bar without a percentage means the runtime has not reported a measurable total for that phase. Completed task counts are separate: writing and artwork take different amounts of time, so two of three tasks does not mean two thirds of the wait is over.",
          "When all the website tasks finish, a Design finished card offers the saved draft for review. Its elapsed time includes waiting in the queue, model loading, writing and artwork. It never applies the draft automatically. This browser remembers pending completion notices when you refresh or return later.",
          "A time-saving comparison needs a matching measured unoptimized run on the same hardware and settings. Until that evidence is available, Studio shows the actual elapsed time without inventing how long another runtime would take.",
        ],
      },
      {
        heading: "Improve one output at a time",
        paragraphs: [
          "Open a saved website, choose a page in its site map, then select Rewrite page copy in the editor. Describe the change you want. Studio saves your current edits and queues only that page’s title, description and section writing. Its structure, links, media and other pages are preserved.",
          "Inside a page section, Create section artwork generates one image. Add it to the section or replace a selected image there. Replacement creates a new image from your description; it does not edit the original pixels. The original stays in your project library.",
          "Review update shows the original and new output side by side. Apply this update changes only the selected output. Discard update keeps your website unchanged and leaves generated assets in the project. If the website has newer edits, applying is disabled: save those edits and request a fresh update from that version.",
          "If a request fails or is cancelled, Retry this output repeats a single update. For a full website, Retry unfinished steps reuses completed writing and artwork and queues only unfinished work. Keep the same brief to recover a run; Generate website starts a separate design from the current brief.",
        ],
      },
      {
        heading: "What the website includes",
        paragraphs: [
          "Pages share navigation and use local media files. The exported website is static: it can show text, images and video without a model running. It does not provide a checkout, account system, database or working form backend. Exporting downloads files; it does not publish them.",
          "A new generation produces a separate draft until you apply it. Cancelling keeps valid completed artwork in the project. Recovery keeps those outputs available; starting a new design uses your current brief.",
        ],
      },
    ],
  },
  {
    id: "projects",
    title: "Save, reopen and export",
    summary:
      "Keep editable work on the Studio host and take finished files with you.",
    sections: [
      {
        heading: "Saved work and revisions",
        paragraphs: [
          "Projects and drafts are stored on the computer running Studio. Reopen a project to continue with its saved media, writing and website. Generated writing and saved revisions remain distinct, so choosing a newer version does not erase the earlier text.",
        ],
      },
      {
        heading: "An export you can keep",
        paragraphs: [
          "Export downloads a ZIP containing the website, media, text and project metadata. Extract the whole ZIP and open index.html. Keep the files together so page links and media paths continue to work. Exported pages need no AI subscription or running model.",
          "Opening an existing project in this Studio is supported. Importing an exported ZIP into another installation is not yet available. To back up editable projects, stop Studio and copy its data directory; the host setup guide explains its location.",
        ],
      },
    ],
  },
  {
    id: "local-network",
    title: "Use Studio across your network",
    summary:
      "The browser can be on another computer while inference stays on the host.",
    sections: [
      {
        heading: "Which computer does the work?",
        paragraphs: [
          "Studio runs the models and stores projects on its host computer. A browser on another device in the same network can control that workspace. GPU readings always describe the host. Imported files travel from your browser to the host, and exports download to the device running your browser.",
          "Generation uses local model packages with isolated runtime networking. There is no hosted model fallback or required AI subscription. Reading this wiki also stays within Studio.",
        ],
      },
      {
        heading: "A shared workspace",
        paragraphs: [
          "This version is for a trusted local network. It has no separate user accounts: people who can open the host's Studio address share its projects, settings and queue. The host must remain running for generation and editing. If the host address changes, use its new local network address.",
        ],
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "When something needs attention",
    summary:
      "Resolve setup, loading and generation problems without losing finished work.",
    sections: [
      {
        heading: "Setup required or GPU waiting",
        paragraphs: [
          "Open Settings, then Tool setup & downloads, to see missing packages or host requirements. Review the source, license and disk space, then explicitly start the package download. Setup keeps its progress when you return to your project.",
          "If another application is using the GPU, Studio can wait instead of loading a competing model. It does not stop that application. Once the GPU becomes available, queued work can proceed.",
        ],
      },
      {
        heading: "A job failed or seems slow",
        paragraphs: [
          "Check the named phase and error in the queue. Loading a large model can take longer than generating the final output, especially on first use. Cancel when you want to stop waiting. After fixing the reported problem, retry the request; finished project assets remain saved.",
          "Supported settings are model-specific. A different clip length or aspect ratio is available only when the integration exposes it. A request failure does not authorize Studio to reduce quality or switch to a different model silently.",
        ],
      },
    ],
  },
];
