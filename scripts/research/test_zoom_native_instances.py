import importlib.util
import os
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('native_instances', pathlib.Path(__file__).with_name('zoom-native-instances.py'))
instances = importlib.util.module_from_spec(spec)
spec.loader.exec_module(instances)

ROOM = '1234567890'
IN_ROOM = {'inMeetingRaw': 1, 'conferenceReadyRaw': 1, 'meetingIdRaw': ROOM}
A = {'pid': 100, 'thread': 1}
B = {'pid': 200, 'thread': 2}


class InstanceTests(unittest.TestCase):
    def test_the_process_in_the_configured_meeting_is_chosen(self):
        states = {100: {**IN_ROOM, 'meetingIdRaw': '9999999999'}, 200: IN_ROOM}
        self.assertEqual(instances.select_meeting([A, B], ROOM, lambda c: states[c['pid']]), B)

    def test_a_process_that_cannot_be_probed_is_not_chosen(self):
        def probe(candidate):
            if candidate['pid'] == 100:
                raise RuntimeError('attach failed')
            return IN_ROOM
        self.assertEqual(instances.select_meeting([A, B], ROOM, probe), B)

    def test_two_processes_in_the_same_meeting_are_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'refusing to guess'):
            instances.select_meeting([A, B], ROOM, lambda c: IN_ROOM)

    def test_no_process_in_the_meeting_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'found 0 of 2'):
            instances.select_meeting([A, B], ROOM, lambda c: {**IN_ROOM, 'inMeetingRaw': 0})

    def test_only_other_meeting_processes_are_listed(self):
        found = [A, B, {'pid': 200, 'thread': 3}, {'pid': os.getpid(), 'thread': 4}]
        self.assertEqual(instances.others(found, 100), [200])
        self.assertEqual(instances.others([A], 100), [])


if __name__ == '__main__':
    unittest.main()
