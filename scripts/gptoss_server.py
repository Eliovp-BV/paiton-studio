"""Extend the pinned public Paiton launcher with bounded Harmony reasoning."""
import importlib.util
import json
import os

REASONING_CONFIG = {
    "reasoning_start_str": "<|channel|>analysis<|message|>",
    "reasoning_end_str": "<|end|><|start|>assistant<|channel|>final<|message|>",
}

def main():
    spec = importlib.util.spec_from_file_location("paiton_gptoss_server", "/opt/paiton/gpt-oss/server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    original = server.command
    def command(*args, **kwargs):
        return original(*args, **kwargs) + ["--reasoning-config", json.dumps(REASONING_CONFIG)]
    server.command = command
    os.environ["VLLM_USE_V2_MODEL_RUNNER"] = "0"
    server.main()

if __name__ == "__main__":
    main()
