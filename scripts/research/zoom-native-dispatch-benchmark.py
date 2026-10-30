"""Compare read-only native queries with/without a WM_NULL message-pump wake."""
import argparse
import importlib.util
import json
import pathlib
import statistics
import time

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('bridge_probe', HERE / 'zoom-bridge-probe.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', required=True, type=int)
    parser.add_argument('--thread', required=True, type=int)
    parser.add_argument('--count', type=int, default=10)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    if not 1 <= args.count <= 100:
        raise RuntimeError('count outside research bound')
    samples = {'passiveDispatch': [], 'wakeDispatch': []}
    with module.BridgeClient(args.pid) as client:
        # Checks module versions before any direct RPC below.
        initial = client.run('query', args.thread)
        wake = client.wake_window(args.thread)
        for _ in range(args.count):
            for mode, window in [('passiveDispatch', '0'), ('wakeDispatch', wake)]:
                started = time.perf_counter_ns()
                result = client.script.exports_sync.run('query', args.thread, '0', 0, window)
                samples[mode].append((time.perf_counter_ns() - started) / 1_000_000)
                if result['before']['meetingIdRaw'] != initial['before']['meetingIdRaw']:
                    raise RuntimeError('Meeting changed during benchmark')
    report = {'kind': 'read-only-native-dispatch-benchmark', 'pid': args.pid, 'thread': args.thread,
              'meetingId': initial['before']['meetingIdRaw'], 'countPerMode': args.count,
              'results': {name: {'medianMs': round(statistics.median(values), 3), 'maxMs': round(max(values), 3),
                                  'samplesMs': [round(v, 3) for v in values]} for name, values in samples.items()},
              'limitations': ['Queries only; does not measure first remote video frame or audio.', 'Includes Frida RPC and query execution; excludes initial attachment and hash checks.']}
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))

if __name__ == '__main__':
    main()
