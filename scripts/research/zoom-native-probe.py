"""Read-only in-process Zoom module probe. No UI automation or Zoom SDK.

Frida is a research dependency, kept outside the application's package.
The script unloads its agent and detaches without terminating Zoom.
"""
import argparse
import json
import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "runtime" / "data" / "zoom-native-tools"))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--agent", type=pathlib.Path, default=pathlib.Path(__file__).with_suffix(".js"))
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--command", choices=["inventory", "status"], default="inventory")
    args = parser.parse_args()
    import frida
    session = frida.attach(args.pid)
    script = None
    try:
        script = session.create_script(args.agent.read_text(encoding="utf-8"))
        script.load()
        inventory = script.exports_sync.inventory()
        module_path = pathlib.Path(inventory["module"]["path"])
        digest = hashlib.sha256(module_path.read_bytes()).hexdigest()
        if args.command == "status":
            if digest != "bd40c94d3eb1118e1c89e0216f6902f86b12eb9babf138ab05c844e98aef7749":
                raise RuntimeError("Unverified Zoom module build; native calls disabled")
            result = script.exports_sync.status()
        else:
            result = inventory
        result["moduleSha256"] = digest
        if args.output:
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
    finally:
        if script is not None:
            script.unload()
        session.detach()

if __name__ == "__main__":
    main()
