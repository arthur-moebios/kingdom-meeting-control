"""Media intent debounce, independent of Frida/Windows for focused tests."""
class MediaObservationFusion:
    def __init__(self):
        self.samples = {}
        self.last_kind = None
        self.transitions = {}
        self.smtc_was_active = False

    def observe(self, sample, now):
        if isinstance(sample, dict) and type(sample.get('active')) is bool:
            source = sample.get('source', 'uia')
            previous = self.samples.get(source, ({}, 0))[0]
            if any(previous.get(key) != sample.get(key) for key in ('active','kind','mediaWindowHandle')):
                self.transitions[source] = now
            if source == 'smtc' and sample['active']:
                self.smtc_was_active = True
            self.samples[source] = (sample, now)
        return self.current(now)

    def current(self, now):
        fresh = {source: sample for source, (sample, at) in self.samples.items() if now - at < 2}
        uia, smtc = fresh.get('uia'), fresh.get('smtc')
        if smtc and smtc['active'] and smtc.get('playbackStatus') == 'Playing':
            chosen = smtc
        elif uia and uia['active'] and uia.get('kind') == 'image':
            chosen = uia
        elif smtc and smtc['active']:
            chosen = smtc
        elif smtc and self.smtc_was_active and uia and uia['active'] and uia.get('kind') == 'video' and self.transitions.get('uia',0) <= self.transitions.get('smtc',0):
            chosen = smtc  # A stale UIA video context must not hold a closed native session.
        elif uia:
            chosen = uia
        elif smtc and self.last_kind != 'image':
            chosen = smtc
        else:
            return None  # SMTC has no information about still images.
        self.last_kind = chosen.get('kind') if chosen['active'] else None
        return chosen

class MediaPolicy:
    def __init__(self, end_delay=0.1):
        self.end_delay = end_delay
        self.current = None
        self.pending_end = None

    def observe(self, sample, now):
        # Invalid reads must never impersonate a normal media-ended event.
        if not isinstance(sample, dict) or type(sample.get('active')) is not bool:
            return None
        hwnd = sample.get('mediaWindowHandle')
        if sample['active'] and isinstance(hwnd, int) and hwnd > 0:
            self.pending_end = None
            desired = (hwnd, sample.get('kind', 'none'))
        elif sample['active']:
            # A missing/ambiguous target prevents sharing the wrong JW window.
            self.pending_end = None
            desired = (None, 'none')
        else:
            if self.pending_end is None:
                self.pending_end = now
            if now - self.pending_end < self.end_delay:
                return None
            desired = (None, 'none')
        if desired == self.current:
            return None
        self.current = desired
        return desired
