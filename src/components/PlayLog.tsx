// ============================================================================
// The play-by-play row, and the labels that go in it.
//
// There are two play-by-play lists: the live sheet on LiveGameScreen and the
// one under the box score. They had separate copies of the same label map
// (PBP_LABEL and EV_LABEL, byte-identical), separate copies of the row layout,
// and separate copies of the delete button - so a change to one silently left
// the other behind. Both now render this.
//
// Two things the row is required to do, and neither was true before:
//
//   * SAY WHICH TEAM. Only timeouts named a team; everything else was
//     "Player - made 3", so telling the sides apart meant already knowing both
//     rosters. The badge AND the name are shown: colour alone fails a
//     colour-blind scorekeeper, and two drop-in teams are routinely picked from
//     the same palette.
//
//   * ASK BEFORE DELETING. The row's X applied the score and stat change on the
//     first tap, and it sits millimetres from the row it belongs to on a phone
//     held courtside. A mis-tap silently rewriting the score is not noticed
//     until the final buzzer.
// ============================================================================

import { View, Pressable, Alert } from 'react-native';
import { Txt, TeamBadge } from './ui';
import { colors } from '../theme';
import { EventType, GameEvent } from '../types';

/** The one play-by-play vocabulary. */
export const PLAY_LABEL: Record<EventType, string> = {
  fg2_make: 'made 2', fg2_miss: 'missed 2', fg3_make: 'made 3', fg3_miss: 'missed 3',
  ft_make: 'made FT', ft_miss: 'missed FT', reb: 'rebound', oreb: 'off. reb', dreb: 'def. reb',
  ast: 'assist', stl: 'steal', blk: 'block', tov: 'turnover', pf: 'foul', timeout: 'Timeout',
};

/** How a team is identified in the log. */
export interface PlayLogTeam {
  name: string;
  color: string;
  logo?: string;
}

/** Just the event, without the team - the team is rendered beside it. */
export function playText(e: Pick<GameEvent, 'type' | 'playerId' | 'note'>, nameOf: (id: string | null) => string): string {
  if (e.type === 'timeout') {
    return e.note ? `Timeout — ${e.note} remaining` : 'Timeout';
  }
  return `${nameOf(e.playerId)} — ${PLAY_LABEL[e.type]}`;
}

/** The whole play in one string, for a confirmation or a screen reader. */
export function fullPlayText(
  e: Pick<GameEvent, 'type' | 'playerId' | 'note'>,
  team: PlayLogTeam,
  nameOf: (id: string | null) => string,
): string {
  return `${team.name} · ${playText(e, nameOf)}`;
}

export function PlayLogRow({ event, team, nameOf, first, onDelete }: {
  event: Pick<GameEvent, 'id' | 'period' | 'type' | 'playerId' | 'note'>;
  team: PlayLogTeam;
  nameOf: (id: string | null) => string;
  /** Suppresses the top divider on the first row. */
  first: boolean;
  /** Omit to render read-only (spectators, finished games). */
  onDelete?: (id: string) => void;
}) {
  const text = playText(event, nameOf);
  const full = fullPlayText(event, team, nameOf);

  const confirmDelete = () => {
    if (!onDelete) return;
    Alert.alert(
      'Delete this play?',
      `${full}\n\nThe score and stats update straight away.`,
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => onDelete(event.id) },
      ],
    );
  };

  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
      borderTopWidth: first ? 0 : 1, borderTopColor: colors.line,
    }}>
      <Txt k="stat" color={colors.muted} style={{ width: 24 }}>{event.period}</Txt>

      <View style={{ flexDirection: 'row', alignItems: 'center', width: 92, marginRight: 8 }}>
        <TeamBadge logo={team.logo} color={team.color} size={14} />
        <Txt k="body" color={colors.muted} numberOfLines={1} style={{ marginLeft: 6, flex: 1, fontSize: 12 }}>
          {team.name}
        </Txt>
      </View>

      <Txt k="body" style={{ flex: 1 }} color={event.type === 'timeout' ? colors.yellow : colors.text}>
        {text}
      </Txt>

      {onDelete && (
        <Pressable
          onPress={confirmDelete}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${full}`}
          accessibilityHint="Asks for confirmation before the score and stats change."
        >
          <Txt k="body" color={colors.red}>✕</Txt>
        </Pressable>
      )}
    </View>
  );
}
