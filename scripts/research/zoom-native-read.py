"""Passive native snapshots, optionally bounded polling; no remote calls or writes."""
import argparse
import datetime
import importlib.util
import json
import pathlib
import time
import threading
import sys

HERE = pathlib.Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int)
    parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--watch-seconds', type=float, default=0)
    parser.add_argument('--interval-ms', type=int, default=250)
    parser.add_argument('--no-polls', action='store_true')
    parser.add_argument('--managed', action='store_true', help='Read while the owning app keeps stdin open')
    args = parser.parse_args()
    stopped = threading.Event()
    if args.managed:
        def watch_owner():
            sys.stdin.read()
            stopped.set()
        threading.Thread(target=watch_owner, daemon=True).start()
    if not 0 <= args.watch_seconds <= 600 or not 100 <= args.interval_ms <= 10000:
        parser.error('Watch must be 0..600 seconds and interval 100..10000 ms')
    pid = args.pid or load('zoom-native-discovery').discover_one()['pid']
    memory = load('zoom-native-memory')
    tracker_type = load('zoom-native-read-model').ParticipantTracker
    tracker, token, last = tracker_type(), None, None
    deadline = time.monotonic() + args.watch_seconds
    failures = 0
    with memory.ProcessReader(pid) as reader:
        while True:
            try:
                state = memory.participant_snapshot(reader)
                state['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                if token is not None and token != state['sessionToken']:
                    # Never carry hand ordering or participant IDs into another session.
                    tracker = tracker_type()
                token = state['sessionToken']
                state = tracker.reconcile(state)
                if not args.no_polls:
                    try:
                        state['polls'] = memory.poll_snapshot(reader)
                    except (OSError, ValueError, RuntimeError) as error:
                        state['polls'] = {'partial': True, 'items': None, 'error': str(error)}
                last = state
                failures = 0
                if args.output:
                    temporary = args.output.with_suffix(args.output.suffix + '.tmp')
                    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
                    temporary.replace(args.output)
                    print(json.dumps({'output': str(args.output), 'participants': len(state['participants']),
                                      'raisedHands': len(state['raisedHands']['order']),
                                      'polls': len(state.get('polls', {}).get('items') or []),
                                      'eventCount': len(state['events']), 'mutationsExecuted': 0}), flush=True)
                else:
                    print(json.dumps(state, ensure_ascii=False), flush=True)
            except (OSError, ValueError, RuntimeError) as error:
                if not args.watch_seconds and not args.managed:
                    raise
                # A failed observation never becomes an authoritative empty roster.
                if args.output and last is not None:
                    stale = {**last, 'partial': True, 'stale': True, 'error': str(error)}
                    temporary = args.output.with_suffix(args.output.suffix + '.tmp')
                    temporary.write_text(json.dumps(stale, ensure_ascii=False, indent=2), encoding='utf-8')
                    temporary.replace(args.output)
                print(json.dumps({'partial': True, 'error': str(error), 'lastSnapshotRetained': last is not None}), flush=True)
                failures += 1
                if not reader.is_alive() or failures >= 3:
                    # The desktop client creates a new meeting process on rejoin.
                    # Let the supervisor rediscover it instead of polling a dead PID.
                    break
            if stopped.is_set() or (not args.managed and (not args.watch_seconds or time.monotonic() >= deadline)):
                break
            stopped.wait(args.interval_ms / 1000 if args.managed else min(args.interval_ms / 1000, max(0, deadline - time.monotonic())))


if __name__ == '__main__':
    main()
