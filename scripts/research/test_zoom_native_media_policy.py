import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('media_policy', pathlib.Path(__file__).with_name('zoom-native-media-policy.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MediaPolicy = module.MediaPolicy
MediaObservationFusion = module.MediaObservationFusion

def media(hwnd=42, kind='video'):
    return {'active': True, 'mediaWindowHandle': hwnd, 'kind': kind}

class MediaPolicyTests(unittest.TestCase):
    def test_start_is_immediate(self):
        self.assertEqual(MediaPolicy().observe(media(), 0), (42, 'video'))

    def test_short_provider_flicker_does_not_stop_video(self):
        policy = MediaPolicy()
        policy.observe(media(), 0)
        self.assertIsNone(policy.observe({'active': False}, 1))
        self.assertIsNone(policy.observe(media(), 1.04))
        self.assertEqual(policy.current, (42, 'video'))

    def test_stable_end_emits_once_after_100ms(self):
        policy = MediaPolicy()
        policy.observe(media(), 0)
        self.assertIsNone(policy.observe({'active': False}, 1))
        self.assertEqual(policy.observe({'active': False}, 1.11), (None, 'none'))
        self.assertIsNone(policy.observe({'active': False}, 2))

    def test_failed_reads_do_not_end_a_share(self):
        policy = MediaPolicy()
        policy.observe(media(), 0)
        for failed in [None, {}, {'observerError': 'UIA failed'}, {'active': 'false'}]:
            self.assertIsNone(policy.observe(failed, 2))
        self.assertEqual(policy.current, (42, 'video'))

    def test_image_to_video_reconfigures_same_window(self):
        policy = MediaPolicy()
        policy.observe(media(kind='image'), 0)
        self.assertEqual(policy.observe(media(kind='video'), 1), (42, 'video'))

    def test_missing_target_stops_instead_of_using_main_jw_window(self):
        policy = MediaPolicy()
        policy.observe(media(), 0)
        self.assertEqual(policy.observe(media(hwnd=None), 1), (None, 'none'))

    def test_window_recreation_emits_new_target(self):
        policy = MediaPolicy()
        policy.observe(media(), 0)
        self.assertEqual(policy.observe(media(hwnd=43), 1), (43, 'video'))

class FusionTests(unittest.TestCase):
    def test_closed_native_session_overrides_an_unchanged_uia_video_context(self):
        fusion = MediaObservationFusion()
        fusion.observe({**media(), 'source': 'uia'}, 0)
        fusion.observe({**media(), 'source': 'smtc', 'playbackStatus': 'Playing'}, 0.1)
        ended = {'active': False, 'source': 'smtc', 'kind': 'none'}
        self.assertEqual(fusion.observe(ended, 0.2), ended)

    def test_native_video_overrides_failed_uia_without_delay(self):
        fusion = MediaObservationFusion()
        fusion.observe({'active': False, 'source': 'uia'}, 0)
        video = {**media(), 'source': 'smtc', 'playbackStatus': 'Playing'}
        self.assertEqual(fusion.observe(video, 0.01), video)

    def test_native_video_end_is_not_held_by_old_video_sample(self):
        fusion = MediaObservationFusion()
        fusion.observe({**media(), 'source': 'smtc', 'playbackStatus': 'Playing'}, 0)
        ended = {'active': False, 'source': 'smtc', 'kind': 'none'}
        self.assertEqual(fusion.observe(ended, 1), ended)

    def test_missing_smtc_session_cannot_end_a_uia_image(self):
        fusion = MediaObservationFusion()
        image = {**media(kind='image'), 'source': 'uia'}
        fusion.observe(image, 0)
        fusion.observe({'active': False, 'source': 'smtc'}, 1)
        self.assertIsNone(fusion.observe({'active': False, 'source': 'smtc'}, 3))

    def test_stale_native_video_is_not_reused_for_manual_share(self):
        fusion = MediaObservationFusion()
        fusion.observe({**media(), 'source': 'smtc', 'playbackStatus': 'Playing'}, 0)
        self.assertIsNone(fusion.current(3))

if __name__ == '__main__':
    unittest.main()
