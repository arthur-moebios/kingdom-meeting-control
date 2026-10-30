"""Offline tests only: neither imports Frida nor attaches to Zoom."""
import importlib.util
import pathlib
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('controls_plan', HERE / 'zoom-native-controls.py')
controls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controls)


class ControlPlanTests(unittest.TestCase):
    def test_no_implicit_allow_unmute_change(self):
        with self.assertRaises(ValueError):
            controls.make_plan('mute-all', '1234567890')
        self.assertEqual(controls.make_plan('mute-all', '1234567890', allow_unmute=False)['arguments'], [0])

    def test_ids_are_explicit_and_nonzero(self):
        for invalid in [None, 0, -1, 2**32, True, '42']:
            with self.assertRaises(ValueError):
                controls.make_plan('admit-participant', '1234567890', invalid)

    def test_cli_defaults_to_offline_even_with_invalid_process(self):
        result = subprocess.run([sys.executable, str(HERE / 'zoom-native-controls.py'),
                                 'admit-all', '--meeting-id', '1234567890', '--pid', '-123'],
                                capture_output=True, text=True, check=True)
        import json
        plan = json.loads(result.stdout)
        self.assertFalse(plan['attachedToZoom'])
        self.assertFalse(plan['execute'])


if __name__ == '__main__':
    unittest.main()
