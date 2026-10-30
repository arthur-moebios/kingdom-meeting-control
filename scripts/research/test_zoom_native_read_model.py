import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('native_read_model', pathlib.Path(__file__).with_name('zoom-native-read-model.py'))
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)


class TrackerTests(unittest.TestCase):
    def test_attendance_counts_people_instead_of_connections(self):
        self.assertEqual(model.attendance_from_options([{'label': '1', 'votes': 12}, {'label': '4', 'votes': 3}]), 24)
        self.assertEqual(model.attendance_from_options([{'label': '1', 'votes': 16}, {'label': '2', 'votes': 6},
                                                       {'label': '3', 'votes': 1}, {'label': '4', 'votes': 1}]), 35)
        self.assertIsNone(model.attendance_from_options([{'label': 'Sim', 'votes': 12}]))
    def test_poll_eligibility_is_unknown_instead_of_manufactured_zero(self):
        source = [{'id': 'p1', 'name': 'Count', 'questions': [{'id': 'q1', 'text': 'How many?',
                   'rawCounters': {'0x9c': 3, '0x98': 1}, 'options': [
                       {'label': '1', 'rawCounters': {'0x58': 2}},
                       {'label': '2', 'rawCounters': {'0x58': 1}}]}]}]
        result = model.normalize_poll_results(source)[0]
        self.assertIsNone(result['totalParticipants'])
        self.assertTrue(result['partial'])
        self.assertTrue(result['countsConsistent'])
        self.assertEqual(result['totalVoted'], 3)

    def test_inconsistent_poll_result_is_never_marked_complete(self):
        source = [{'id': 'p', 'name': 'Count', 'questions': [{'id': 'q', 'text': '?',
                   'rawCounters': {'0x9c': 1, '0x98': 1},
                   'options': [{'label': 'a', 'rawCounters': {'0x58': 2}}]}]}]
        with self.assertRaises(ValueError):
            model.normalize_poll_results(source)

    def test_unknown_hand_is_not_a_lower_hand_event(self):
        tracker = model.ParticipantTracker()
        tracker.reconcile({'participants': [{'id': '42', 'handRaised': True}], 'partial': False}, '1')
        unknown = tracker.reconcile({'participants': [{'id': '42', 'handRaised': None}], 'partial': True}, '2')
        self.assertEqual(unknown['events'], [])
        raised = tracker.reconcile({'participants': [{'id': '42', 'handRaised': True}], 'partial': False}, '3')
        self.assertEqual(raised['participants'][0]['handRaisedAt'], '1')

    def test_partial_read_does_not_manufacture_departures(self):
        tracker = model.ParticipantTracker()
        tracker.reconcile({'participants': [{'id': '42', 'handRaised': False}], 'partial': False})
        partial = tracker.reconcile({'participants': [], 'partial': True})
        self.assertEqual(partial['events'], [])
        complete = tracker.reconcile({'participants': [], 'partial': False})
        self.assertEqual(complete['events'], [{'type': 'zoom.participant.left', 'participantId': '42'}])

    def test_order_tracks_detection_and_re_raise_without_claiming_server_order(self):
        tracker = model.ParticipantTracker()
        tracker.reconcile({'participants': [{'id': '42', 'handRaised': True}, {'id': '99', 'handRaised': False}], 'partial': False}, '1')
        tracker.reconcile({'participants': [{'id': '42', 'handRaised': False}, {'id': '99', 'handRaised': True}], 'partial': False}, '2')
        result = tracker.reconcile({'participants': [{'id': '42', 'handRaised': True}, {'id': '99', 'handRaised': True}], 'partial': False}, '3')
        self.assertEqual([p['id'] for p in result['raisedHands']['order']], ['99', '42'])
        self.assertEqual(result['raisedHands']['orderSource'], 'detection-time')


if __name__ == '__main__':
    unittest.main()
