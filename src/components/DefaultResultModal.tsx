import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Button, TeamBadge, Txt } from './ui';
import { Team } from '../types';
import { colors, font, radius, space } from '../theme';

type Props = { home: Team; away: Team; onCancel: () => void;
  onConfirm: (winnerTeamId: string, score: number) => void; busy?: boolean };

export function DefaultResultForm({ home, away, onCancel, onConfirm, busy = false }: Props) {
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [scoreText, setScoreText] = useState('30');
  const validScore = /^(?:[1-9]\d{0,2})$/.test(scoreText);
  const score = validScore ? Number(scoreText) : 0;

  return <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ padding: space(5) }}>
    <Txt k="h2">Record a default result</Txt>
    <Txt k="body" color={colors.muted} style={{ marginTop: space(2), marginBottom: space(3) }}>
      Choose the team present and eligible to win. The other team receives 0. This result
      counts in standings; no points are credited to players.
    </Txt>
    {[home, away].map(team => <Pressable key={team.id} onPress={() => setWinnerId(team.id)}
      accessibilityRole="radio" accessibilityState={{ selected: winnerId === team.id }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12,
        marginBottom: 8, borderRadius: radius.md, borderWidth: 2,
        borderColor: winnerId === team.id ? colors.brandTeal : colors.line }}>
      <TeamBadge logo={team.logo} color={team.color} size={22} />
      <Txt k="body" style={{ flex: 1 }}>{team.name}</Txt>
      <Txt k="body" color={winnerId === team.id ? colors.brandTeal : colors.muted}>
        {winnerId === team.id ? 'Selected' : 'Select'}
      </Txt>
    </Pressable>)}
    <Txt k="label" style={{ marginTop: space(2), marginBottom: 6 }}>Winning score</Txt>
    <TextInput value={scoreText} onChangeText={setScoreText} keyboardType="number-pad"
      maxLength={3} selectTextOnFocus accessibilityLabel="Default winning score"
      style={{ backgroundColor: colors.bg, borderRadius: radius.md, borderWidth: 1,
        borderColor: validScore ? colors.line : colors.red, color: colors.text,
        paddingHorizontal: 14, paddingVertical: 12, fontFamily: font.body, fontSize: 18 }} />
    {!validScore && <Txt k="body" color={colors.red} style={{ marginTop: 6 }}>
      Enter a whole number from 1 to 999.
    </Txt>}
    <Txt k="body" color={colors.muted} style={{ marginTop: space(2), fontSize: 12 }}>
      Final score: {winnerId === home.id ? `${score}–0` : winnerId === away.id ? `0–${score}` : 'choose a winner'}
    </Txt>
    <View style={{ flexDirection: 'row', gap: 10, marginTop: space(4) }}>
      <Button title="Cancel" kind="ghost" onPress={onCancel} disabled={busy} style={{ flex: 1 }} />
      <Button title={busy ? 'Saving…' : 'Confirm default'} disabled={!winnerId || !validScore || busy}
        onPress={() => winnerId && onConfirm(winnerId, score)} style={{ flex: 1 }} />
    </View>
  </ScrollView>;
}

export default function DefaultResultModal(props: Props) {
  return <Modal transparent animationType="fade" onRequestClose={props.onCancel}
    supportedOrientations={['portrait', 'landscape']}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: '#000B' }}>
      <Pressable onPress={props.onCancel} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6) }}>
        <Pressable onPress={() => {}} style={{ width: '100%', maxWidth: 380, maxHeight: '100%',
          backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1,
          borderColor: colors.line, overflow: 'hidden' }}>
          <DefaultResultForm {...props} />
        </Pressable>
      </Pressable>
    </KeyboardAvoidingView>
  </Modal>;
}
