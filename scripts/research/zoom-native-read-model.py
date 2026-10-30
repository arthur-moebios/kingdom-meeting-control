"""Pure snapshot reconciliation. No Windows APIs or Zoom process access."""
import datetime
import re


def attendance_from_options(options):
    if not options or any(not re.fullmatch(r'\d+', option['label'].strip(), re.ASCII) for option in options):
        return None
    return sum(int(option['label'].strip()) * option['votes'] for option in options)


def normalize_poll_results(polls):
    """Same data family as Web results, with unknown eligibility kept nullable."""
    results = []
    for poll in polls:
        for question in poll['questions']:
            answered = question['rawCounters']['0x9c']
            options = []
            for option in question['options']:
                votes = option['rawCounters']['0x58']
                if votes > answered:
                    raise ValueError('Poll counters changed or use an unsupported result model')
                options.append({'label': option['label'], 'votes': votes, 'total': answered,
                                'percent': 100 * votes / answered if answered else None})
            # A single-choice result cannot have a different sum and still be
            # reported as complete. Types other than 1 remain raw for now.
            single_choice = question['rawCounters']['0x98'] == 1
            consistent = single_choice and sum(o['votes'] for o in options) == answered
            results.append({'pollId': poll['id'], 'questionId': question['id'],
                            'pollName': poll['name'], 'question': question['text'],
                            'totalVoted': answered, 'totalParticipants': None,
                            'options': options, 'countsConsistent': consistent,
                            'attendanceTotal': attendance_from_options(options) if consistent else None,
                            'percentSource': 'calculated-from-native-counts',
                            'partial': True,
                            'limitations': ['Eligible voter count is not yet decoded.',
                                            'Only single-choice result counts have been checked.']})
    return results


class ParticipantTracker:
    def __init__(self):
        self.raised_at = {}
        self.previous = {}

    def reconcile(self, snapshot, now=None):
        timestamp = now or datetime.datetime.now(datetime.timezone.utc).isoformat()
        seen = set()
        participants = []
        events = []
        for source in snapshot['participants']:
            person = dict(source)
            identity = person['id']
            if identity in seen:
                raise ValueError('Duplicate participant ID in snapshot')
            seen.add(identity)
            old = self.previous.get(identity)
            raised = person.get('handRaised')
            if raised is True and identity not in self.raised_at:
                self.raised_at[identity] = timestamp
                events.append({'type': 'zoom.hand.raised', 'participantId': identity})
            elif raised is False and identity in self.raised_at:
                del self.raised_at[identity]
                events.append({'type': 'zoom.hand.lowered', 'participantId': identity})
            person['handRaisedAt'] = self.raised_at.get(identity)
            if old is None:
                events.append({'type': 'zoom.participant.joined', 'participantId': identity})
            self.previous[identity] = person
            participants.append(person)
        if not snapshot['partial']:
            for identity in set(self.previous) - seen:
                del self.previous[identity]
                self.raised_at.pop(identity, None)
                events.append({'type': 'zoom.participant.left', 'participantId': identity})
        hands = sorted((p for p in participants if p.get('handRaised') is True),
                       key=lambda p: (p['handRaisedAt'], p['id']))
        return {**snapshot, 'participants': participants, 'events': events,
                'raisedHands': {'order': hands, 'orderSource': 'detection-time',
                                'partial': snapshot['partial'] or any(p.get('handRaised') is None for p in participants)}}
